import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';

/**
 * Passe finale : exposition, tonemapping ACES, teinte d'immersion,
 * vignette et grain. Le rendu arrive en linéaire non borné, ce qui laisse
 * le bloom travailler sur les vraies hautes lumières.
 */
const finalShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uExposure: { value: 1.0 },
    uTint: { value: new THREE.Color(1, 1, 1) },
    uTintAmount: { value: 0 },
    uVignette: { value: 0.32 },
    uGrain: { value: 0.035 },
    uTime: { value: 0 },
    uDamage: { value: 0 },
    uWarp: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    precision highp float;
    uniform sampler2D tDiffuse;
    uniform float uExposure;
    uniform vec3 uTint;
    uniform float uTintAmount;
    uniform float uVignette;
    uniform float uGrain;
    uniform float uTime;
    uniform float uDamage;
    uniform float uWarp;
    varying vec2 vUv;

    vec3 acesToneMap(vec3 x) {
      const float a = 2.51;
      const float b = 0.03;
      const float c = 2.43;
      const float d = 0.59;
      const float e = 0.14;
      return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
    }

    float hash(vec2 p) {
      return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
    }

    void main() {
      vec2 uv = vUv;
      if (uWarp > 0.0) {
        // Ondulation de l'image quand la tête est sous la surface.
        uv.x += sin(uv.y * 24.0 + uTime * 2.4) * 0.0035 * uWarp;
        uv.y += sin(uv.x * 20.0 + uTime * 1.9) * 0.0035 * uWarp;
      }

      vec3 color = texture2D(tDiffuse, uv).rgb * uExposure;
      color = mix(color, color * uTint, uTintAmount);
      color = acesToneMap(color);

      float dist = distance(vUv, vec2(0.5));
      color *= 1.0 - uVignette * smoothstep(0.35, 0.85, dist);
      color = mix(color, vec3(0.55, 0.05, 0.03), uDamage * smoothstep(0.1, 0.8, dist));

      // Le grain suit la luminosité : sinon il domine les zones noires.
      float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
      float grain = hash(vUv * 1024.0 + fract(uTime) * 91.7) - 0.5;
      color += grain * uGrain * (0.15 + 0.85 * luma);

      // Sortie en sRGB : la chaîne de rendu travaille en linéaire jusqu'ici.
      color = pow(max(color, 0.0), vec3(1.0 / 2.2));
      gl_FragColor = vec4(color, 1.0);
    }
  `,
};

export interface PostProcessing {
  composer: EffectComposer;
  setSize(width: number, height: number): void;
  render(deltaTime: number): void;
  setUnderwater(amount: number, tint: THREE.Color): void;
  setDamage(amount: number): void;
  setBloom(strength: number): void;
  dispose(): void;
}

export function createPostProcessing(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
): PostProcessing {
  const size = renderer.getSize(new THREE.Vector2());
  const target = new THREE.WebGLRenderTarget(size.x, size.y, {
    type: THREE.HalfFloatType,
    colorSpace: THREE.NoColorSpace,
    samples: 4,
  });

  const composer = new EffectComposer(renderer, target);
  composer.addPass(new RenderPass(scene, camera));

  const bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.55, 0.7, 0.85);
  composer.addPass(bloom);

  const final = new ShaderPass(finalShader);
  final.renderToScreen = true;
  composer.addPass(final);

  let time = 0;

  return {
    composer,
    setSize(width, height) {
      composer.setSize(width, height);
      bloom.setSize(width, height);
    },
    render(deltaTime) {
      time += deltaTime;
      final.uniforms.uTime.value = time;
      composer.render(deltaTime);
    },
    setUnderwater(amount, tint) {
      final.uniforms.uTintAmount.value = amount;
      final.uniforms.uTint.value.copy(tint);
      final.uniforms.uWarp.value = amount;
    },
    setDamage(amount) {
      final.uniforms.uDamage.value = amount;
    },
    setBloom(strength) {
      bloom.strength = strength;
    },
    dispose() {
      composer.dispose();
      target.dispose();
    },
  };
}

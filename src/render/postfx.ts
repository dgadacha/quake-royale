import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { aoBlurShader, aoShader } from './ao';
import { createGBuffer, gbufferMaterial } from './gbuffer';
import { ssrShader } from './ssr';
import type { GraphicsSettings } from './graphics';

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

/** Multiplie l'image par la carte d'occlusion. */
const applyOcclusionShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    tOcclusion: { value: null as THREE.Texture | null },
    uEnabled: { value: 1 },
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
    uniform sampler2D tOcclusion;
    uniform float uEnabled;
    varying vec2 vUv;
    void main() {
      vec3 color = texture2D(tDiffuse, vUv).rgb;
      if (uEnabled > 0.5) {
        float occlusion = texture2D(tOcclusion, vUv).r;
        // L'occlusion creuse les recoins sans éteindre les zones éclairées.
        color *= mix(1.0, occlusion, 0.85);
      }
      gl_FragColor = vec4(color, 1.0);
    }
  `,
};

export interface ViewmodelLayer {
  scene: THREE.Scene;
  camera: THREE.Camera;
}

export interface PostProcessing {
  composer: EffectComposer;
  setSize(width: number, height: number): void;
  render(deltaTime: number): void;
  setUnderwater(amount: number, tint: THREE.Color): void;
  setDamage(amount: number): void;
  setBloom(strength: number): void;
  setGraphics(settings: GraphicsSettings): void;
  dispose(): void;
}

export function createPostProcessing(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  viewmodel?: ViewmodelLayer,
): PostProcessing {
  const size = renderer.getSize(new THREE.Vector2());
  const target = new THREE.WebGLRenderTarget(size.x, size.y, {
    type: THREE.HalfFloatType,
    colorSpace: THREE.NoColorSpace,
    samples: 4,
  });

  // Normales et distances du décor : socle de l'occlusion et des reflets.
  const gbuffer = createGBuffer(size.x, size.y);
  const occlusionTarget = new THREE.WebGLRenderTarget(size.x, size.y, {
    type: THREE.HalfFloatType,
    colorSpace: THREE.NoColorSpace,
    depthBuffer: false,
  });
  const occlusionBlurTarget = occlusionTarget.clone();
  let effectScale = 1;
  let viewWidth = size.x;
  let viewHeight = size.y;

  /** Redimensionne les cibles d'occlusion selon l'échelle de rendu choisie. */
  const resizeOcclusionTargets = () => {
    const width = Math.max(64, Math.round(viewWidth * effectScale));
    const height = Math.max(64, Math.round(viewHeight * effectScale));
    occlusionTarget.setSize(width, height);
    occlusionBlurTarget.setSize(width, height);
    occlusionMaterial.uniforms.uResolution.value.set(width, height);
    blurMaterial.uniforms.uTexel.value.set(1 / width, 1 / height);
  };

  const occlusionQuad = new FullScreenQuad(new THREE.ShaderMaterial(aoShader));
  const blurQuad = new FullScreenQuad(new THREE.ShaderMaterial(aoBlurShader));
  const occlusionMaterial = occlusionQuad.material as THREE.ShaderMaterial;
  const blurMaterial = blurQuad.material as THREE.ShaderMaterial;
  occlusionMaterial.uniforms.tNormalDepth.value = gbuffer.texture;
  blurMaterial.uniforms.tNormalDepth.value = gbuffer.texture;

  const composer = new EffectComposer(renderer, target);
  composer.addPass(new RenderPass(scene, camera));

  const applyOcclusion = new ShaderPass(applyOcclusionShader);
  applyOcclusion.uniforms.tOcclusion.value = occlusionBlurTarget.texture;
  composer.addPass(applyOcclusion);

  const reflections = new ShaderPass(ssrShader);
  reflections.uniforms.tNormalDepth.value = gbuffer.texture;
  composer.addPass(reflections);

  // L'arme tenue en main se dessine par-dessus, sur un tampon de profondeur
  // remis à zéro : elle ne peut donc jamais être coupée par un mur proche.
  // Elle passe avant le halo lumineux pour en bénéficier comme le décor.
  if (viewmodel) {
    const weaponPass = new RenderPass(viewmodel.scene, viewmodel.camera);
    weaponPass.clear = false;
    weaponPass.clearDepth = true;
    composer.addPass(weaponPass);
  }

  const bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.55, 0.7, 0.85);
  composer.addPass(bloom);

  const final = new ShaderPass(finalShader);
  final.renderToScreen = true;
  composer.addPass(final);

  let time = 0;
  let occlusionEnabled = true;
  const halfExtent = new THREE.Vector2();
  const worldUpView = new THREE.Vector3();

  /** Demi-ouverture de la caméra, nécessaire pour reconstruire les positions. */
  const updateCameraUniforms = () => {
    const perspective = camera as THREE.PerspectiveCamera;
    const tangent = Math.tan(THREE.MathUtils.degToRad(perspective.fov * 0.5));
    halfExtent.set(tangent * perspective.aspect, tangent);
    occlusionMaterial.uniforms.uHalfExtent.value.copy(halfExtent);
    occlusionMaterial.uniforms.uProjection.value.copy(perspective.projectionMatrix);
    reflections.uniforms.uHalfExtent.value.copy(halfExtent);
    reflections.uniforms.uProjection.value.copy(perspective.projectionMatrix);

    // Direction du haut du monde vue depuis la caméra : c'est elle qui
    // distingue un sol réfléchissant d'un mur.
    worldUpView.set(0, 1, 0).transformDirection(camera.matrixWorldInverse);
    reflections.uniforms.uWorldUpView.value.copy(worldUpView);
  };

  const renderOcclusion = () => {
    const previousTarget = renderer.getRenderTarget();

    // Le décor seul alimente le tampon : l'arme a sa propre passe.
    const previousOverride = scene.overrideMaterial;
    scene.overrideMaterial = gbufferMaterial;
    renderer.setRenderTarget(gbuffer);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, true, false);
    renderer.render(scene, camera);
    scene.overrideMaterial = previousOverride;

    if (occlusionEnabled) {
      renderer.setRenderTarget(occlusionTarget);
      occlusionQuad.render(renderer);

      // Deux passes de flou séparées, moins coûteuses qu'une passe carrée.
      blurMaterial.uniforms.tDiffuse.value = occlusionTarget.texture;
      blurMaterial.uniforms.uDirection.value.set(1, 0);
      renderer.setRenderTarget(occlusionBlurTarget);
      blurQuad.render(renderer);

      blurMaterial.uniforms.tDiffuse.value = occlusionBlurTarget.texture;
      blurMaterial.uniforms.uDirection.value.set(0, 1);
      renderer.setRenderTarget(occlusionTarget);
      blurQuad.render(renderer);

      applyOcclusion.uniforms.tOcclusion.value = occlusionTarget.texture;
    }

    renderer.setRenderTarget(previousTarget);
  };

  return {
    composer,
    setSize(width, height) {
      composer.setSize(width, height);
      bloom.setSize(width, height);
      gbuffer.setSize(width, height);
      viewWidth = width;
      viewHeight = height;
      resizeOcclusionTargets();
    },
    render(deltaTime) {
      time += deltaTime;
      final.uniforms.uTime.value = time;

      if (applyOcclusion.enabled || reflections.enabled) {
        updateCameraUniforms();
        renderOcclusion();
      }

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
    setGraphics(settings) {
      occlusionEnabled = settings.ambientOcclusion;
      applyOcclusion.enabled = settings.ambientOcclusion;
      applyOcclusion.uniforms.uEnabled.value = settings.ambientOcclusion ? 1 : 0;
      occlusionMaterial.uniforms.uIntensity.value = settings.aoIntensity;
      occlusionMaterial.uniforms.uRadius.value = settings.aoRadius;

      reflections.enabled = settings.reflections;
      reflections.uniforms.uStrength.value = settings.reflections
        ? settings.reflectionStrength
        : 0;

      if (settings.effectScale !== effectScale) {
        effectScale = settings.effectScale;
        resizeOcclusionTargets();
      }

      bloom.enabled = settings.bloom;
      bloom.strength = settings.bloomStrength;
      final.uniforms.uGrain.value = settings.grain ? 0.035 : 0;
    },
    dispose() {
      composer.dispose();
      target.dispose();
      gbuffer.dispose();
      occlusionTarget.dispose();
      occlusionBlurTarget.dispose();
      occlusionQuad.dispose();
      blurQuad.dispose();
    },
  };
}

import * as THREE from 'three';
import { viewPositionSnippet } from './gbuffer';

const SAMPLE_COUNT = 16;

/** Points répartis dans un hémisphère, resserrés vers le centre. */
function hemisphereKernel(count: number): THREE.Vector3[] {
  const kernel: THREE.Vector3[] = [];
  let seed = 0x2545f491;
  const random = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return ((seed >>> 0) % 100000) / 100000;
  };

  for (let i = 0; i < count; i++) {
    const vector = new THREE.Vector3(
      random() * 2 - 1,
      random() * 2 - 1,
      random() * 0.9 + 0.1,
    ).normalize();
    // Plus d'échantillons près de l'origine : c'est là que se joue le contact.
    const scale = 0.25 + 0.75 * Math.pow(i / count, 2);
    kernel.push(vector.multiplyScalar(scale));
  }
  return kernel;
}

/** Bruit de rotation, appliqué en damier pour casser la régularité du noyau. */
function rotationNoise(size = 4): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  let seed = 0x9e3779b9;
  const random = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return ((seed >>> 0) % 100000) / 100000;
  };
  for (let i = 0; i < size * size; i++) {
    const angle = random() * Math.PI * 2;
    data[i * 4] = Math.round((Math.cos(angle) * 0.5 + 0.5) * 255);
    data[i * 4 + 1] = Math.round((Math.sin(angle) * 0.5 + 0.5) * 255);
    data[i * 4 + 2] = 0;
    data[i * 4 + 3] = 255;
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.needsUpdate = true;
  return texture;
}

export const aoNoiseTexture = rotationNoise();
export const aoKernel = hemisphereKernel(SAMPLE_COUNT);

export const aoShader = {
  uniforms: {
    tNormalDepth: { value: null as THREE.Texture | null },
    tNoise: { value: aoNoiseTexture },
    uKernel: { value: aoKernel },
    uProjection: { value: new THREE.Matrix4() },
    uHalfExtent: { value: new THREE.Vector2() },
    uResolution: { value: new THREE.Vector2() },
    uRadius: { value: 34 },
    uBias: { value: 0.9 },
    uIntensity: { value: 1.0 },
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

    uniform sampler2D tNormalDepth;
    uniform sampler2D tNoise;
    uniform vec3 uKernel[${SAMPLE_COUNT}];
    uniform mat4 uProjection;
    uniform vec2 uHalfExtent;
    uniform vec2 uResolution;
    uniform float uRadius;
    uniform float uBias;
    uniform float uIntensity;

    varying vec2 vUv;

    ${viewPositionSnippet}

    void main() {
      vec4 source = texture2D(tNormalDepth, vUv);
      float depth = source.a;

      // Pixel sans géométrie : rien à occulter.
      if (depth <= 0.0) {
        gl_FragColor = vec4(1.0);
        return;
      }

      vec3 position = viewPositionFrom(vUv, depth, uHalfExtent);
      vec3 normal = normalize(source.rgb);

      // Repère tangent tourné aléatoirement, pour disperser les échantillons.
      vec2 noiseScale = uResolution / 4.0;
      vec2 rotation = texture2D(tNoise, vUv * noiseScale).xy * 2.0 - 1.0;
      vec3 randomVec = normalize(vec3(rotation, 0.0));
      vec3 tangent = normalize(randomVec - normal * dot(randomVec, normal));
      vec3 bitangent = cross(normal, tangent);
      mat3 tbn = mat3(tangent, bitangent, normal);

      float occlusion = 0.0;
      for (int i = 0; i < ${SAMPLE_COUNT}; i++) {
        vec3 samplePos = position + tbn * uKernel[i] * uRadius;

        vec4 projected = uProjection * vec4(samplePos, 1.0);
        vec2 sampleUv = (projected.xy / projected.w) * 0.5 + 0.5;
        if (sampleUv.x < 0.0 || sampleUv.x > 1.0 || sampleUv.y < 0.0 || sampleUv.y > 1.0) continue;

        float sceneDepth = texture2D(tNormalDepth, sampleUv).a;
        if (sceneDepth <= 0.0) continue;

        // La surface trouvée cache-t-elle le point échantillonné ?
        float sampleDepth = -samplePos.z;
        if (sceneDepth < sampleDepth - uBias) {
          // Une surface très en avant appartient à un autre plan :
          // sans ce garde-fou, les silhouettes se bordent d'un halo sombre.
          float rangeCheck = smoothstep(0.0, 1.0, uRadius / abs(depth - sceneDepth));
          occlusion += rangeCheck;
        }
      }

      float visibility = 1.0 - (occlusion / float(${SAMPLE_COUNT})) * uIntensity;
      gl_FragColor = vec4(vec3(clamp(visibility, 0.0, 1.0)), 1.0);
    }
  `,
};

/** Flou guidé par la profondeur : il lisse le bruit sans franchir les arêtes. */
export const aoBlurShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    tNormalDepth: { value: null as THREE.Texture | null },
    uTexel: { value: new THREE.Vector2() },
    uDirection: { value: new THREE.Vector2(1, 0) },
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
    uniform sampler2D tNormalDepth;
    uniform vec2 uTexel;
    uniform vec2 uDirection;

    varying vec2 vUv;

    void main() {
      float centerDepth = texture2D(tNormalDepth, vUv).a;
      float total = 0.0;
      float weightSum = 0.0;

      for (int i = -3; i <= 3; i++) {
        vec2 offset = uDirection * uTexel * float(i);
        float sampleDepth = texture2D(tNormalDepth, vUv + offset).a;
        // Un écart de profondeur marqué signale une autre surface.
        float weight = exp(-abs(sampleDepth - centerDepth) * 0.08);
        total += texture2D(tDiffuse, vUv + offset).r * weight;
        weightSum += weight;
      }

      float value = weightSum > 0.0 ? total / weightSum : 1.0;
      gl_FragColor = vec4(vec3(value), 1.0);
    }
  `,
};

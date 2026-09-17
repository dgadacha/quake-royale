import * as THREE from 'three';

/**
 * Normales et distances du décor, écrites en une passe.
 * L'occlusion ambiante comme les réflexions raisonnent sur la surface vue par
 * chaque pixel : sans ces deux informations, aucune des deux n'est calculable.
 */
export const gbufferMaterial = new THREE.ShaderMaterial({
  vertexShader: /* glsl */ `
    varying vec3 vViewNormal;
    varying float vViewDepth;
    void main() {
      vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
      vViewNormal = normalize(normalMatrix * normal);
      vViewDepth = -viewPosition.z;
      gl_Position = projectionMatrix * viewPosition;
    }
  `,
  fragmentShader: /* glsl */ `
    precision highp float;
    varying vec3 vViewNormal;
    varying float vViewDepth;
    void main() {
      gl_FragColor = vec4(normalize(vViewNormal), vViewDepth);
    }
  `,
});

export function createGBuffer(width: number, height: number): THREE.WebGLRenderTarget {
  return new THREE.WebGLRenderTarget(width, height, {
    type: THREE.FloatType,
    colorSpace: THREE.NoColorSpace,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    depthBuffer: true,
  });
}

/** Reconstruit la position vue d'un pixel à partir de sa distance. */
export const viewPositionSnippet = /* glsl */ `
  vec3 viewPositionFrom(vec2 uv, float viewDepth, vec2 halfExtent) {
    vec2 ndc = uv * 2.0 - 1.0;
    return vec3(ndc * halfExtent * viewDepth, -viewDepth);
  }
`;

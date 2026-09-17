import * as THREE from 'three';
import { viewPositionSnippet } from './gbuffer';

/**
 * Réflexions calculées dans l'image déjà rendue : le rayon réfléchi est
 * parcouru pas à pas et projeté à l'écran, où sa profondeur est comparée à
 * celle du décor. Ce qui n'est pas à l'écran ne peut pas se refléter, d'où
 * l'atténuation sur les bords, qui évite que les reflets s'interrompent net.
 */
export const ssrShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    tNormalDepth: { value: null as THREE.Texture | null },
    uProjection: { value: new THREE.Matrix4() },
    uHalfExtent: { value: new THREE.Vector2() },
    uWorldUpView: { value: new THREE.Vector3(0, 1, 0) },
    uStrength: { value: 0.55 },
    uMaxDistance: { value: 900 },
    uStepCount: { value: 28 },
    uThickness: { value: 26 },
    /** Au-delà de cette inclinaison, la surface ne réfléchit plus. */
    uUpBias: { value: 0.65 },
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
    uniform mat4 uProjection;
    uniform vec2 uHalfExtent;
    uniform vec3 uWorldUpView;
    uniform float uStrength;
    uniform float uMaxDistance;
    uniform float uStepCount;
    uniform float uThickness;
    uniform float uUpBias;

    varying vec2 vUv;

    ${viewPositionSnippet}

    void main() {
      vec3 color = texture2D(tDiffuse, vUv).rgb;
      vec4 source = texture2D(tNormalDepth, vUv);
      float depth = source.a;

      if (depth <= 0.0 || uStrength <= 0.0) {
        gl_FragColor = vec4(color, 1.0);
        return;
      }

      vec3 normal = normalize(source.rgb);

      // Seules les surfaces tournées vers le haut réfléchissent : sols polis,
      // dalles humides, nappes d'eau. Un mur de pierre ne renvoie rien.
      float facingUp = dot(normal, normalize(uWorldUpView));
      float reflectivity = smoothstep(uUpBias, 1.0, facingUp);
      if (reflectivity <= 0.001) {
        gl_FragColor = vec4(color, 1.0);
        return;
      }

      vec3 position = viewPositionFrom(vUv, depth, uHalfExtent);
      vec3 viewDir = normalize(position);
      vec3 rayDir = normalize(reflect(viewDir, normal));

      // Un rayon qui repart vers la caméra ne trouvera jamais rien d'utile.
      if (rayDir.z > 0.0) {
        gl_FragColor = vec4(color, 1.0);
        return;
      }

      float stepSize = uMaxDistance / uStepCount;
      vec3 hitColor = vec3(0.0);
      float hit = 0.0;
      vec2 hitUv = vec2(0.0);

      for (int i = 1; i <= 64; i++) {
        if (float(i) > uStepCount) break;

        vec3 samplePos = position + rayDir * stepSize * float(i);
        vec4 projected = uProjection * vec4(samplePos, 1.0);
        vec2 sampleUv = (projected.xy / projected.w) * 0.5 + 0.5;
        if (sampleUv.x < 0.0 || sampleUv.x > 1.0 || sampleUv.y < 0.0 || sampleUv.y > 1.0) break;

        float sceneDepth = texture2D(tNormalDepth, sampleUv).a;
        if (sceneDepth <= 0.0) continue;

        float rayDepth = -samplePos.z;
        float difference = rayDepth - sceneDepth;

        // Le rayon vient de passer derrière une surface : c'est le contact.
        // L'épaisseur évite d'accrocher un objet très éloigné vu de profil.
        if (difference > 0.0 && difference < uThickness) {
          hitUv = sampleUv;
          hitColor = texture2D(tDiffuse, sampleUv).rgb;
          hit = 1.0;
          break;
        }
      }

      if (hit > 0.0) {
        // Disparition progressive sur les bords de l'image et à l'horizon.
        vec2 edge = smoothstep(vec2(0.0), vec2(0.12), hitUv)
          * (1.0 - smoothstep(vec2(0.88), vec2(1.0), hitUv));
        float edgeFade = edge.x * edge.y;

        // Un regard rasant réfléchit davantage qu'un regard plongeant.
        float fresnel = pow(1.0 - max(dot(normal, -viewDir), 0.0), 2.5);
        float amount = reflectivity * uStrength * edgeFade * (0.25 + 0.75 * fresnel);
        color = mix(color, hitColor, clamp(amount, 0.0, 1.0));
      }

      gl_FragColor = vec4(color, 1.0);
    }
  `,
};

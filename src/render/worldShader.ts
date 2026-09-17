export const worldVertexShader = /* glsl */ `
attribute vec2 aLightUv;
attribute vec4 aStyles;
attribute vec4 aTangent;

uniform float uTime;
uniform float uWarpAmount;

varying vec2 vUv;
varying vec2 vLightUv;
varying vec4 vStyles;
varying vec3 vWorldPos;
varying vec3 vNormal;
varying vec3 vTangent;
varying vec3 vBitangent;

void main() {
  vUv = uv;
  vLightUv = aLightUv;
  vStyles = aStyles;

  vec3 pos = position;
  if (uWarpAmount > 0.0) {
    // Houle des surfaces liquides, appliquée sur les deux axes horizontaux.
    pos.y += sin(pos.x * 0.025 + uTime * 1.7) * uWarpAmount;
    pos.y += sin(pos.z * 0.021 + uTime * 2.3) * uWarpAmount * 0.7;
  }

  vec4 world = modelMatrix * vec4(pos, 1.0);
  vWorldPos = world.xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);
  vTangent = normalize(mat3(modelMatrix) * aTangent.xyz);
  vBitangent = normalize(cross(vNormal, vTangent)) * aTangent.w;

  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

export const worldFragmentShader = /* glsl */ `
precision highp float;

uniform sampler2D uMap;
uniform sampler2D uSurface;
uniform sampler2D uHdNormal;
uniform sampler2D uHdRoughness;
uniform sampler2D uHdAo;
uniform float uHasHdNormal;
uniform float uHasHdRoughness;
uniform float uHasHdAo;
uniform float uNormalScale;
uniform float uTextureScale;
uniform float uMetalness;
uniform sampler2D uEmissive;
uniform sampler2D uLightmap;
uniform sampler2D uStyleLut;
uniform sampler2D uDetail;

uniform float uHasEmissive;
uniform float uLightScale;
uniform float uLightGamma;
uniform vec3 uAmbient;
uniform float uSpecular;
uniform float uDetailScale;
uniform float uDetailStrength;
uniform float uLightmapTexel;
uniform float uNormalFlipY;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform float uEmissiveStrength;
uniform float uTime;
uniform vec3 uFlashPos;
uniform vec3 uFlashColor;
uniform float uFlashRadius;

#define MAX_LIGHTS 12
uniform vec4 uLightPositions[MAX_LIGHTS];
uniform vec4 uLightColors[MAX_LIGHTS];
uniform int uLightCount;
uniform float uDynamicDiffuse;
uniform float uDynamicSpecular;

varying vec2 vUv;
varying vec2 vLightUv;
varying vec4 vStyles;
varying vec3 vWorldPos;
varying vec3 vNormal;
varying vec3 vTangent;
varying vec3 vBitangent;

float styleIntensity(float index) {
  if (index > 63.5) return 0.0;
  return texture2D(uStyleLut, vec2((index + 0.5) / 64.0, 0.5)).r;
}

vec3 sampleLight(vec2 uv) {
  vec4 lm = texture2D(uLightmap, uv);
  float sum =
    lm.r * styleIntensity(vStyles.x) +
    lm.g * styleIntensity(vStyles.y) +
    lm.b * styleIntensity(vStyles.z) +
    lm.a * styleIntensity(vStyles.w);
  return vec3(pow(min(sum, 1.5), uLightGamma) * uLightScale);
}

void main() {
  // Un matériau haute définition peut répéter autrement que la texture
  // d'origine : son échelle lui est propre.
  vec2 hdUv = vUv * uTextureScale;

  vec4 albedo = texture2D(uMap, uTextureScale == 1.0 ? vUv : hdUv);
  if (albedo.a < 0.5) discard;

  vec4 surface = texture2D(uSurface, vUv);

  // Les cartes fournies remplacent celles déduites de la texture d'origine ;
  // ce qui manque retombe sur ces dernières.
  vec3 tangentNormal;
  if (uHasHdNormal > 0.5) {
    tangentNormal = texture2D(uHdNormal, hdUv).xyz * 2.0 - 1.0;
    tangentNormal.xy *= uNormalScale;
  } else {
    tangentNormal = surface.xyz * 2.0 - 1.0;
  }
  tangentNormal.y *= uNormalFlipY;

  float roughness = uHasHdRoughness > 0.5
    ? texture2D(uHdRoughness, hdUv).g
    : surface.a;
  float materialAo = uHasHdAo > 0.5 ? texture2D(uHdAo, hdUv).r : 1.0;

  // Grain de proximité : il disparaît avec la distance grâce au mip.
  vec3 detail = texture2D(uDetail, vUv * uDetailScale).xyz;
  tangentNormal.xy += (detail.xy * 2.0 - 1.0) * uDetailStrength;
  tangentNormal = normalize(tangentNormal);

  mat3 tbn = mat3(normalize(vTangent), normalize(vBitangent), normalize(vNormal));
  vec3 normal = normalize(tbn * tangentNormal);

  vec3 light = sampleLight(vLightUv);

  // Direction dominante de la lumière, reconstruite depuis la pente de la
  // lightmap : sans elle le relief des normales resterait invisible.
  float lr = sampleLight(vLightUv + vec2(uLightmapTexel, 0.0)).r;
  float ll = sampleLight(vLightUv - vec2(uLightmapTexel, 0.0)).r;
  float lu = sampleLight(vLightUv + vec2(0.0, uLightmapTexel)).r;
  float ld = sampleLight(vLightUv - vec2(0.0, uLightmapTexel)).r;
  vec3 lightDirTangent = normalize(vec3((ll - lr) * 4.0, (ld - lu) * 4.0, 0.6));
  vec3 lightDir = normalize(tbn * lightDirTangent);

  float relief = mix(1.0, clamp(dot(normal, lightDir) * 0.5 + 0.7, 0.0, 1.35), 0.85);
  vec3 diffuse = albedo.rgb * light * relief;

  vec3 viewDir = normalize(cameraPosition - vWorldPos);
  vec3 halfDir = normalize(lightDir + viewDir);
  float gloss = mix(96.0, 6.0, roughness);
  float spec = pow(max(dot(normal, halfDir), 0.0), gloss) * (1.0 - roughness) * uSpecular;
  float fresnel = pow(1.0 - max(dot(normal, viewDir), 0.0), 5.0) * 0.28;

  // Le métal réfléchit sa propre couleur au lieu de diffuser du blanc.
  vec3 specularTint = mix(vec3(1.0), albedo.rgb, uMetalness);
  vec3 color = diffuse * (1.0 - uMetalness * 0.65)
    + light * specularTint * (spec + fresnel * (1.0 - roughness));

  // L'occlusion du matériau ne touche que l'éclairage d'ambiance : elle
  // décrit le relief de la surface, pas l'ombre portée du niveau.
  color += albedo.rgb * uAmbient * materialAo;
  color *= mix(1.0, materialAo, 0.6);

  if (uHasEmissive > 0.5) {
    vec3 emissive = texture2D(uEmissive, vUv).rgb;
    float pulse = 0.92 + 0.08 * sin(uTime * 6.0 + vWorldPos.x * 0.05);
    color += emissive * uEmissiveStrength * pulse;
  }

  // Sources dynamiques du niveau.
  //
  // Les lightmaps portent déjà le diffus de ces mêmes sources : en réappliquer
  // la totalité délaverait la scène. Leur apport réel est ailleurs, dans le
  // reflet spéculaire que l'éclairage cuit ne peut pas contenir, et dans la
  // couleur, qu'une lightmap en niveaux de gris ne sait pas porter.
  for (int i = 0; i < MAX_LIGHTS; i++) {
    if (i >= uLightCount) break;

    vec3 toLight = uLightPositions[i].xyz - vWorldPos;
    float lightDistance = length(toLight);
    float lightRadius = uLightPositions[i].w;
    if (lightDistance >= lightRadius || lightRadius <= 0.0) continue;

    vec3 lightVector = toLight / lightDistance;
    float attenuation = pow(1.0 - lightDistance / lightRadius, 2.0);
    vec3 energy = uLightColors[i].rgb * uLightColors[i].a * attenuation;

    float lambert = max(dot(normal, lightVector), 0.0);
    color += albedo.rgb * energy * lambert * uDynamicDiffuse;

    vec3 lightHalf = normalize(lightVector + viewDir);
    float lightSpec = pow(max(dot(normal, lightHalf), 0.0), gloss) * (1.0 - roughness);
    color += energy * lightSpec * uDynamicSpecular;
  }

  // Lampe attachée au joueur : évite les couloirs totalement noirs.
  vec3 toFlash = uFlashPos - vWorldPos;
  float dist = length(toFlash);
  if (dist < uFlashRadius) {
    float atten = pow(1.0 - dist / uFlashRadius, 2.0);
    float lambert = max(dot(normal, normalize(toFlash)), 0.0);
    color += albedo.rgb * uFlashColor * atten * (lambert * 0.8 + 0.2);
  }

  float fog = 1.0 - exp(-pow(length(cameraPosition - vWorldPos) * uFogDensity, 2.0));
  color = mix(color, uFogColor, clamp(fog, 0.0, 1.0));

  gl_FragColor = vec4(color, 1.0);
}
`;

export const skyVertexShader = /* glsl */ `
varying vec3 vDirection;
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vDirection = world.xyz - cameraPosition;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

/**
 * Le ciel d'origine est une texture double : une couche opaque de nuages
 * et une couche de fond, défilant à des vitesses différentes.
 */
export const skyFragmentShader = /* glsl */ `
precision highp float;

uniform sampler2D uLayerFront;
uniform sampler2D uLayerBack;
uniform float uTime;
uniform vec3 uTint;
uniform float uBrightness;
uniform vec3 uFogColor;
uniform float uFogAmount;

varying vec3 vDirection;

void main() {
  vec3 dir = normalize(vDirection);
  // Projection à plat classique : le ciel paraît infiniment haut.
  dir.y = max(abs(dir.y), 0.08) * 3.0;
  vec2 base = dir.xz / dir.y * 0.5;

  vec4 front = texture2D(uLayerFront, base * 1.0 + uTime * 0.012);
  vec3 back = texture2D(uLayerBack, base * 0.75 + uTime * 0.005).rgb;
  vec3 color = mix(back, front.rgb, front.a);

  color *= uTint * uBrightness;
  float horizon = smoothstep(0.35, 0.0, abs(normalize(vDirection).y));
  color = mix(color, uFogColor, horizon * uFogAmount);

  gl_FragColor = vec4(color, 1.0);
}
`;

export const liquidVertexShader = /* glsl */ `
uniform float uTime;
uniform float uWaveHeight;

varying vec2 vUv;
varying vec3 vWorldPos;
varying vec3 vNormal;

void main() {
  vec3 pos = position;
  float wave = sin(pos.x * 0.03 + uTime * 1.6) + sin(pos.z * 0.027 + uTime * 2.1);
  pos += normal * wave * uWaveHeight;

  vec4 world = modelMatrix * vec4(pos, 1.0);
  vWorldPos = world.xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);
  vUv = uv;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

export const liquidFragmentShader = /* glsl */ `
precision highp float;

uniform sampler2D uMap;
uniform float uTime;
uniform vec3 uTint;
uniform float uEmissiveStrength;
uniform float uOpacity;
uniform float uWarp;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform vec3 uFlashPos;
uniform vec3 uFlashColor;
uniform float uFlashRadius;

varying vec2 vUv;
varying vec3 vWorldPos;
varying vec3 vNormal;

void main() {
  // Déformation sinusoïdale des coordonnées, héritée du rendu d'origine.
  vec2 uv = vUv;
  uv.x += sin(vUv.y * 3.14159 + uTime * 0.9) * uWarp;
  uv.y += sin(vUv.x * 3.14159 + uTime * 0.75) * uWarp;

  vec3 color = texture2D(uMap, uv).rgb * uTint;

  vec3 viewDir = normalize(cameraPosition - vWorldPos);
  float fresnel = pow(1.0 - max(dot(normalize(vNormal), viewDir), 0.0), 3.0);
  color += vec3(0.16, 0.22, 0.30) * fresnel;
  color *= 1.0 + uEmissiveStrength;

  vec3 toFlash = uFlashPos - vWorldPos;
  float dist = length(toFlash);
  if (dist < uFlashRadius) {
    color += uFlashColor * pow(1.0 - dist / uFlashRadius, 2.0) * 0.5;
  }

  float fog = 1.0 - exp(-pow(length(cameraPosition - vWorldPos) * uFogDensity, 2.0));
  color = mix(color, uFogColor, clamp(fog, 0.0, 1.0));

  gl_FragColor = vec4(color, uOpacity);
}
`;

import * as THREE from 'three';
import type { MdlModel } from '../formats/mdl';
import type { Palette } from '../formats/palette';
import { buildTextureSet, type TextureSet } from './textures';

export const aliasVertexShader = /* glsl */ `
attribute vec3 aNextPosition;

uniform float uBlend;

varying vec2 vUv;
varying vec3 vWorldPos;

void main() {
  // Les images clés sont mélangées ici : aucun recalcul côté processeur.
  vec3 morphed = mix(position, aNextPosition, uBlend);
  vec4 world = modelMatrix * vec4(morphed, 1.0);
  vWorldPos = world.xyz;
  vUv = uv;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

export const aliasFragmentShader = /* glsl */ `
precision highp float;

uniform sampler2D uMap;
uniform sampler2D uSurface;
uniform sampler2D uEmissive;
uniform float uHasEmissive;
uniform vec3 uAmbient;
uniform float uLightScale;
uniform vec3 uKeyLight;
uniform vec3 uFlashPos;
uniform vec3 uFlashColor;
uniform float uFlashRadius;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform float uEmissiveStrength;

varying vec2 vUv;
varying vec3 vWorldPos;

void main() {
  vec4 albedo = texture2D(uMap, vUv);
  if (albedo.a < 0.5) discard;

  // La normale vient de la géométrie affichée : elle reste juste
  // quelle que soit l'image intermédiaire du morphage.
  vec3 normal = normalize(cross(dFdx(vWorldPos), dFdy(vWorldPos)));

  float key = max(dot(normal, normalize(uKeyLight)), 0.0) * 0.65 + 0.35;
  vec3 color = albedo.rgb * (uAmbient + vec3(key) * uLightScale);

  vec3 toFlash = uFlashPos - vWorldPos;
  float dist = length(toFlash);
  if (dist < uFlashRadius) {
    float atten = pow(1.0 - dist / uFlashRadius, 2.0);
    color += albedo.rgb * uFlashColor * atten * (max(dot(normal, normalize(toFlash)), 0.0) * 0.8 + 0.2);
  }

  if (uHasEmissive > 0.5) {
    color += texture2D(uEmissive, vUv).rgb * uEmissiveStrength;
  }

  float fog = 1.0 - exp(-pow(length(cameraPosition - vWorldPos) * uFogDensity, 2.0));
  color = mix(color, uFogColor, clamp(fog, 0.0, 1.0));

  gl_FragColor = vec4(color, 1.0);
}
`;

export interface AliasModelOptions {
  anisotropy: number;
  ambient: THREE.Color;
  fogColor: THREE.Color;
  fogDensity: number;
  lightScale: number;
  emissiveStrength: number;
}

/**
 * Images et peau d'un modèle, partagées par tous ceux qui l'emploient.
 *
 * Une carte peut compter quarante adversaires du même type. Leur recalculer à
 * chacun les mêmes images clés revient à garder quarante copies d'un même
 * tableau, ce que la subdivision rend intenable : elles ne diffèrent que par
 * l'instant où chacun en est.
 */
interface SharedAlias {
  frameBuffers: Float32Array[];
  uvs: Float32Array;
  textureSet: TextureSet;
  users: number;
}

const sharedByModel = new WeakMap<MdlModel, SharedAlias>();

function shareOf(model: MdlModel, palette: Palette, options: AliasModelOptions): SharedAlias {
  const existing = sharedByModel.get(model);
  if (existing) {
    existing.users++;
    return existing;
  }

  const cornerCount = model.triangles.length * 3;
  const sourceIndices = new Int32Array(cornerCount);
  const uvs = new Float32Array(cornerCount * 2);

  let corner = 0;
  for (const triangle of model.triangles) {
    for (const vertexIndex of triangle.vertices) {
      const coord = model.texCoords[vertexIndex];
      let s = coord.s;
      // Les sommets de couture occupent la moitié droite de la peau
      // lorsqu'ils appartiennent à une face arrière.
      if (coord.onSeam && !triangle.facesFront) s += model.skinWidth / 2;
      uvs[corner * 2] = (s + 0.5) / model.skinWidth;
      uvs[corner * 2 + 1] = (coord.t + 0.5) / model.skinHeight;
      sourceIndices[corner] = vertexIndex;
      corner++;
    }
  }

  const frameBuffers = model.frames.map((frame) => {
    const positions = new Float32Array(cornerCount * 3);
    for (let i = 0; i < cornerCount; i++) {
      const source = sourceIndices[i] * 3;
      // Passage du repère du jeu à celui du moteur de rendu.
      positions[i * 3] = frame.positions[source];
      positions[i * 3 + 1] = frame.positions[source + 2];
      positions[i * 3 + 2] = -frame.positions[source + 1];
    }
    return positions;
  });

  const skin = model.skins[0];
  const textureSet = buildTextureSet(
    skin
      ? { name: 'skin', width: skin.width, height: skin.height, pixels: skin.pixels }
      : { name: 'skin', width: 16, height: 16, pixels: null },
    palette,
    { anisotropy: options.anisotropy, maxUpscale: 2, normalStrength: 1.4 },
  );
  textureSet.map.wrapS = THREE.ClampToEdgeWrapping;
  textureSet.map.wrapT = THREE.ClampToEdgeWrapping;

  const share: SharedAlias = { frameBuffers, uvs, textureSet, users: 1 };
  sharedByModel.set(model, share);
  return share;
}

/**
 * Affichage d'un modèle animé. Les images clés sont conservées côté carte
 * graphique et mélangées par le shader, ce qui permet d'animer des dizaines
 * de modèles sans travail par sommet côté processeur.
 */
export class AliasModel {
  readonly mesh: THREE.Mesh;
  readonly frameCount: number;
  private readonly material: THREE.ShaderMaterial;
  private readonly geometry: THREE.BufferGeometry;
  private readonly frameBuffers: Float32Array[];
  private readonly textureSet: TextureSet;
  private readonly model: MdlModel;
  private currentFrame = -1;
  private nextFrame = -1;

  /**
   * `skin` remplace la peau d'origine sans rien changer d'autre : les
   * coordonnées de texture restent celles du modèle, si bien qu'une image
   * refaite au même agencement se pose exactement où il faut.
   */
  constructor(
    model: MdlModel,
    palette: Palette,
    options: AliasModelOptions,
    skin: THREE.Texture | null = null,
  ) {
    this.model = model;
    const share = shareOf(model, palette, options);
    this.frameBuffers = share.frameBuffers;
    this.textureSet = share.textureSet;
    this.frameCount = this.frameBuffers.length;

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.frameBuffers[0], 3));
    this.geometry.setAttribute(
      'aNextPosition',
      new THREE.BufferAttribute(this.frameBuffers[Math.min(1, this.frameCount - 1)], 3),
    );
    this.geometry.setAttribute('uv', new THREE.BufferAttribute(share.uvs, 2));

    const empty = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
    empty.needsUpdate = true;

    this.material = new THREE.ShaderMaterial({
      vertexShader: aliasVertexShader,
      fragmentShader: aliasFragmentShader,
      uniforms: {
        uMap: { value: skin ?? this.textureSet.map },
        uSurface: { value: this.textureSet.surfaceMap },
        uEmissive: { value: this.textureSet.emissiveMap ?? empty },
        uHasEmissive: { value: this.textureSet.emissiveMap ? 1 : 0 },
        uBlend: { value: 0 },
        uAmbient: { value: options.ambient },
        uLightScale: { value: options.lightScale * 0.45 },
        uKeyLight: { value: new THREE.Vector3(0.4, 1, 0.25) },
        uFlashPos: { value: new THREE.Vector3() },
        uFlashColor: { value: new THREE.Color(0, 0, 0) },
        uFlashRadius: { value: 0 },
        uFogColor: { value: options.fogColor },
        uFogDensity: { value: options.fogDensity },
        uEmissiveStrength: { value: options.emissiveStrength },
      },
    });

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.setFrames(0, Math.min(1, this.frameCount - 1), 0);
  }

  /** Choisit les deux images à mélanger et leur avancement. */
  setFrames(current: number, next: number, blend: number): void {
    const a = ((current % this.frameCount) + this.frameCount) % this.frameCount;
    const b = ((next % this.frameCount) + this.frameCount) % this.frameCount;
    if (a !== this.currentFrame) {
      this.geometry.setAttribute('position', new THREE.BufferAttribute(this.frameBuffers[a], 3));
      this.currentFrame = a;
    }
    if (b !== this.nextFrame) {
      this.geometry.setAttribute(
        'aNextPosition',
        new THREE.BufferAttribute(this.frameBuffers[b], 3),
      );
      this.nextFrame = b;
    }
    this.material.uniforms.uBlend.value = blend;
  }

  /** Animation continue sur l'ensemble des images, en images par seconde. */
  animate(time: number, fps = 10): void {
    if (this.frameCount <= 1) return;
    const position = time * fps;
    const frame = Math.floor(position);
    this.setFrames(frame, frame + 1, position - frame);
  }

  /**
   * Joue une séquence délimitée. Une séquence qui ne boucle pas se fige sur
   * sa dernière image, ce qu'attend une mort.
   */
  playRange(elapsed: number, first: number, count: number, fps: number, loop = true): void {
    if (count <= 1) {
      this.setFrames(first, first, 0);
      return;
    }
    const position = elapsed * fps;
    if (!loop && position >= count - 1) {
      this.setFrames(first + count - 1, first + count - 1, 0);
      return;
    }
    const step = loop ? position % count : Math.min(position, count - 1);
    const frame = Math.floor(step);
    const next = loop ? (frame + 1) % count : Math.min(frame + 1, count - 1);
    this.setFrames(first + frame, first + next, step - frame);
  }

  setFlashlight(position: THREE.Vector3, color: THREE.Color, radius: number): void {
    this.material.uniforms.uFlashPos.value.copy(position);
    this.material.uniforms.uFlashColor.value.copy(color);
    this.material.uniforms.uFlashRadius.value = radius;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    // Les images et la peau servent aux autres exemplaires du même modèle :
    // elles ne partent qu'avec le dernier.
    const share = sharedByModel.get(this.model);
    if (share && --share.users <= 0) {
      share.textureSet.map.dispose();
      share.textureSet.surfaceMap.dispose();
      share.textureSet.emissiveMap?.dispose();
      sharedByModel.delete(this.model);
    }
  }
}

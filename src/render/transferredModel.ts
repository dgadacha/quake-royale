import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { MdlModel } from '../formats/mdl';
import { aliasFragmentShader, aliasVertexShader, type AliasModelOptions } from './aliasModel';
import {
  bindToModel,
  evaluateFrame,
  frameToRenderSpace,
  identifyParts,
  modelParts,
} from './deformationTransfer';

/**
 * Modèle détaillé rejouant les animations d'un modèle du jeu.
 *
 * Le maillage vient d'ailleurs — il n'a ni squelette ni animation — mais il est
 * attaché à la surface du modèle d'origine, dont il reprend les images une à
 * une. Elles sont calculées au chargement puis conservées telles quelles : le
 * mélange entre deux images se fait ensuite sur la carte graphique, comme pour
 * les modèles du jeu, sans rien recalculer pendant la partie.
 */

/** Quart de tour candidats : les exportateurs ne s'accordent pas sur l'avant. */
const TURNS = [0, 90, 180, 270];

function boundingBox(positions: Float32Array): { min: number[]; max: number[] } {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], positions[i + k]);
      max[k] = Math.max(max[k], positions[i + k]);
    }
  }
  return { min, max };
}

function rotateY(positions: Float32Array, degrees: number): Float32Array {
  const r = (degrees * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  const out = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i];
    const z = positions[i + 2];
    out[i] = x * cos + z * sin;
    out[i + 1] = positions[i + 1];
    out[i + 2] = -x * sin + z * cos;
  }
  return out;
}

/** Met le maillage à la taille du modèle d'origine, pieds au sol. */
function fitTo(positions: Float32Array, target: { min: number[]; max: number[] }): Float32Array {
  const box = boundingBox(positions);
  const scale = (target.max[1] - target.min[1]) / (box.max[1] - box.min[1] || 1);
  const out = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    out[i] = (positions[i] - (box.min[0] + box.max[0]) / 2) * scale + (target.min[0] + target.max[0]) / 2;
    out[i + 1] = (positions[i + 1] - box.min[1]) * scale + target.min[1];
    out[i + 2] = (positions[i + 2] - (box.min[2] + box.max[2]) / 2) * scale + (target.min[2] + target.max[2]) / 2;
  }
  return out;
}

/**
 * Orientation qui rapproche le plus le maillage du modèle d'origine.
 * Comparer les sommets suffit à départager quatre quarts de tour, et évite de
 * demander à qui fournit le maillage de connaître la convention du jeu.
 */
function bestTurn(positions: Float32Array, rest: Float32Array, target: { min: number[]; max: number[] }): number {
  const count = positions.length / 3;
  const step = Math.max(1, Math.floor(count / 2000));
  let best = TURNS[0];
  let bestError = Infinity;

  for (const turn of TURNS) {
    const fitted = fitTo(rotateY(positions, turn), target);
    let sum = 0;
    let taken = 0;
    for (let i = 0; i < count; i += step) {
      let nearest = Infinity;
      for (let v = 0; v < rest.length; v += 3) {
        const d =
          (fitted[i * 3] - rest[v]) ** 2 +
          (fitted[i * 3 + 1] - rest[v + 1]) ** 2 +
          (fitted[i * 3 + 2] - rest[v + 2]) ** 2;
        if (d < nearest) nearest = d;
      }
      sum += Math.sqrt(nearest);
      taken++;
    }
    const error = sum / taken;
    if (error < bestError) {
      bestError = error;
      best = turn;
    }
  }
  return best;
}

export interface TransferredModelInfo {
  /** Quart de tour retenu pour aligner le maillage. */
  turn: number;
  vertexCount: number;
  frameCount: number;
  /** Part du maillage rattachée à l'arme du modèle d'origine. */
  weaponShare: number;
  /** Temps passé à lier puis à calculer les images, en millisecondes. */
  elapsed: number;
}

export class TransferredModel {
  readonly mesh: THREE.Mesh;
  readonly frameCount: number;
  readonly info: TransferredModelInfo;
  private readonly geometry: THREE.BufferGeometry;
  private readonly material: THREE.ShaderMaterial;
  private readonly frames: Float32Array[];
  private currentFrame = -1;
  private nextFrame = -1;

  constructor(
    geometry: THREE.BufferGeometry,
    map: THREE.Texture | null,
    frames: Float32Array[],
    options: AliasModelOptions,
    info: TransferredModelInfo,
  ) {
    this.frames = frames;
    this.frameCount = frames.length;
    this.info = info;
    this.geometry = geometry;

    geometry.setAttribute('position', new THREE.BufferAttribute(frames[0], 3));
    geometry.setAttribute(
      'aNextPosition',
      new THREE.BufferAttribute(frames[Math.min(1, frames.length - 1)], 3),
    );

    const blank = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat);
    blank.needsUpdate = true;

    this.material = new THREE.ShaderMaterial({
      vertexShader: aliasVertexShader,
      fragmentShader: aliasFragmentShader,
      uniforms: {
        uMap: { value: map ?? blank },
        uSurface: { value: blank },
        uEmissive: { value: blank },
        uHasEmissive: { value: 0 },
        uBlend: { value: 0 },
        uAmbient: { value: options.ambient },
        uLightScale: { value: options.lightScale },
        uKeyLight: { value: new THREE.Vector3(0.4, 1, 0.6) },
        uFlashPos: { value: new THREE.Vector3() },
        uFlashColor: { value: new THREE.Color(0, 0, 0) },
        uFlashRadius: { value: 0 },
        uFogColor: { value: options.fogColor },
        uFogDensity: { value: options.fogDensity },
        uEmissiveStrength: { value: options.emissiveStrength },
      },
    });

    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.frustumCulled = false;
  }

  setFrames(current: number, next: number, blend: number): void {
    const a = ((current % this.frameCount) + this.frameCount) % this.frameCount;
    const b = ((next % this.frameCount) + this.frameCount) % this.frameCount;
    if (a !== this.currentFrame) {
      this.geometry.setAttribute('position', new THREE.BufferAttribute(this.frames[a], 3));
      this.currentFrame = a;
    }
    if (b !== this.nextFrame) {
      this.geometry.setAttribute('aNextPosition', new THREE.BufferAttribute(this.frames[b], 3));
      this.nextFrame = b;
    }
    this.material.uniforms.uBlend.value = blend;
  }

  animate(time: number, fps = 10): void {
    if (this.frameCount <= 1) return;
    const position = (time * fps) % this.frameCount;
    const frame = Math.floor(position);
    this.setFrames(frame, frame + 1, position - frame);
  }

  playRange(elapsed: number, first: number, count: number, fps: number, loop = true): void {
    if (count <= 0) {
      this.setFrames(first, first, 0);
      return;
    }
    const step = elapsed * fps;
    if (!loop && step >= count - 1) {
      this.setFrames(first + count - 1, first + count - 1, 0);
      return;
    }
    const frame = Math.floor(step) % count;
    const next = loop ? (frame + 1) % count : Math.min(frame + 1, count - 1);
    this.setFrames(first + frame, first + next, step - Math.floor(step));
  }

  setFlashlight(position: THREE.Vector3, color: THREE.Color, radius: number): void {
    this.material.uniforms.uFlashPos.value.copy(position);
    this.material.uniforms.uFlashColor.value.copy(color);
    this.material.uniforms.uFlashRadius.value = radius;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    const map = this.material.uniforms.uMap.value as THREE.Texture | null;
    map?.dispose();
  }
}

/**
 * Maillage préparé et ses images, prêts à être partagés.
 *
 * Les images pèsent quelques dizaines de mégaoctets : elles sont calculées une
 * fois pour toutes et prêtées à chaque adversaire du même type, qui n'a en
 * propre que sa position dans l'animation.
 */
export class TransferredSource {
  constructor(
    private readonly index: THREE.BufferAttribute | null,
    private readonly uv: THREE.BufferAttribute | null,
    private readonly map: THREE.Texture | null,
    private readonly frames: Float32Array[],
    readonly info: TransferredModelInfo,
  ) {}

  /** Nouvel adversaire s'appuyant sur les mêmes images. */
  create(options: AliasModelOptions): TransferredModel {
    const geometry = new THREE.BufferGeometry();
    if (this.index) geometry.setIndex(this.index);
    if (this.uv) geometry.setAttribute('uv', this.uv);
    return new TransferredModel(geometry, this.map, this.frames, options, this.info);
  }

  dispose(): void {
    this.map?.dispose();
  }
}

/**
 * Charge un maillage préparé par tools/prepare-enemy.mjs et lui fait rejouer
 * les images du modèle d'origine.
 */
export async function loadTransferredModel(url: string, model: MdlModel): Promise<TransferredSource> {
  const started = performance.now();
  const gltf = await new GLTFLoader().loadAsync(url);

  let source: THREE.Mesh | null = null;
  gltf.scene.traverse((child) => {
    if (!source && (child as THREE.Mesh).isMesh) source = child as THREE.Mesh;
  });
  if (!source) throw new Error(`aucun maillage dans ${url}`);

  const mesh = source as THREE.Mesh;
  const geometry = mesh.geometry as THREE.BufferGeometry;
  const positions = geometry.getAttribute('position').array as Float32Array;

  const rest = frameToRenderSpace(model, 0);
  const target = boundingBox(rest);
  const turn = bestTurn(positions, rest, target);
  const fitted = fitTo(rotateY(positions, turn), target);

  // L'outil de préparation marque d'un l'arme du maillage : elle doit suivre
  // l'arme du modèle d'origine, et non la main qui la tient.
  const roles = identifyParts(model);
  const marks = geometry.getAttribute('_part');
  const forced = new Int32Array(fitted.length / 3);
  let weaponVertices = 0;
  for (let v = 0; v < forced.length; v++) {
    const isWeapon = marks ? marks.getX(v) > 0.5 : false;
    if (isWeapon && roles.weapon >= 0) {
      forced[v] = roles.weapon;
      weaponVertices++;
    } else {
      forced[v] = roles.body;
    }
  }

  const binding = bindToModel(model, fitted, { neighbours: 4, forcedParts: forced });

  const frames: Float32Array[] = [];
  for (let f = 0; f < model.frames.length; f++) {
    const out = new Float32Array(fitted.length);
    evaluateFrame(binding, model, frameToRenderSpace(model, f), out);
    frames.push(out);
  }

  const material = mesh.material as THREE.MeshStandardMaterial;
  const map = Array.isArray(material) ? null : (material.map ?? null);
  if (map) map.colorSpace = THREE.SRGBColorSpace;

  return new TransferredSource(
    geometry.getIndex(),
    (geometry.getAttribute('uv') as THREE.BufferAttribute) ?? null,
    map,
    frames,
    {
      turn,
      vertexCount: forced.length,
      frameCount: frames.length,
      weaponShare: forced.length > 0 ? weaponVertices / forced.length : 0,
      elapsed: performance.now() - started,
    },
  );
}

export { modelParts };

import * as THREE from 'three';
import {
  classifyTexture,
  type BspData,
  type BspFace,
  type BspMipTexture,
} from '../formats/bsp';
import { Palette } from '../formats/palette';
import { LightmapAtlas, LightStyles, LIGHTMAP_SCALE } from './lightmap';
import { buildDetailTexture, buildTextureSet, type TextureSet } from './textures';
import {
  createLiquidMaterial,
  createSkyMaterial,
  createWorldMaterial,
  type LiquidKind,
} from './materials';
import type { HDMaterialManager } from '../hd/materials/HDMaterialManager';
import { MAX_ACTIVE_LIGHTS } from '../hd/lights/HDLightManager';
import { lightFromSurface, type HDLight } from '../hd/lights/LightResolver';

/** Quake place Z vers le haut : on bascule dans le repère de three. */
export function quakeToThree(x: number, y: number, z: number): [number, number, number] {
  return [x, z, -y];
}

export interface WorldOptions {
  anisotropy: number;
  lightScale: number;
  lightGamma: number;
  ambient: THREE.Color;
  fogColor: THREE.Color;
  fogDensity: number;
  specular: number;
  emissiveStrength: number;
  detailStrength: number;
  atlasSize: number;
  /** Couche haute définition, consultée surface par surface. Absente, rien ne change. */
  hdMaterials?: HDMaterialManager | null;
  /** Tableaux partagés des sources dynamiques, mis à jour chaque image. */
  lightPositions: THREE.Vector4[];
  lightColors: THREE.Vector4[];
}

export const defaultWorldOptions = (anisotropy: number): WorldOptions => ({
  anisotropy,
  lightScale: 2.1,
  lightGamma: 1.35,
  ambient: new THREE.Color(0x0d1014),
  fogColor: new THREE.Color(0x0a0c0f),
  fogDensity: 0.00035,
  specular: 0.55,
  emissiveStrength: 1.6,
  detailStrength: 0.35,
  atlasSize: 2048,
  hdMaterials: null,
  lightPositions: Array.from({ length: MAX_ACTIVE_LIGHTS }, () => new THREE.Vector4()),
  lightColors: Array.from({ length: MAX_ACTIVE_LIGHTS }, () => new THREE.Vector4()),
});

interface FaceGeometry {
  positions: number[];
  normals: number[];
  uvs: number[];
  lightUvs: number[];
  styles: number[];
  tangents: number[];
  indices: number[];
  vertexCount: number;
  /** Emplacement de chaque face dans l'index, pour n'en dessiner qu'une part. */
  faceRanges: { face: number; start: number; count: number }[];
}

function newFaceGeometry(): FaceGeometry {
  return {
    positions: [],
    normals: [],
    uvs: [],
    lightUvs: [],
    styles: [],
    tangents: [],
    indices: [],
    vertexCount: 0,
    faceRanges: [],
  };
}

function toBufferGeometry(source: FaceGeometry): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(source.positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(source.normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(source.uvs, 2));
  geometry.setAttribute('aLightUv', new THREE.Float32BufferAttribute(source.lightUvs, 2));
  geometry.setAttribute('aStyles', new THREE.Float32BufferAttribute(source.styles, 4));
  geometry.setAttribute('aTangent', new THREE.Float32BufferAttribute(source.tangents, 4));
  geometry.setIndex(source.indices);
  geometry.computeBoundingSphere();
  return geometry;
}

/** Étendue de la face en unités de texture, alignée sur la grille des lightmaps. */
function surfaceExtents(
  bsp: BspData,
  face: BspFace,
): { texMins: [number, number]; extents: [number, number] } {
  const info = bsp.texInfos[face.texInfo];
  let minS = Infinity;
  let minT = Infinity;
  let maxS = -Infinity;
  let maxT = -Infinity;

  for (let i = 0; i < face.edgeCount; i++) {
    const edgeIndex = bsp.surfEdges[face.firstEdge + i];
    const vertexIndex =
      edgeIndex >= 0 ? bsp.edges[edgeIndex * 2] : bsp.edges[-edgeIndex * 2 + 1];
    const x = bsp.vertices[vertexIndex * 3];
    const y = bsp.vertices[vertexIndex * 3 + 1];
    const z = bsp.vertices[vertexIndex * 3 + 2];

    const s = x * info.sAxis[0] + y * info.sAxis[1] + z * info.sAxis[2] + info.sOffset;
    const t = x * info.tAxis[0] + y * info.tAxis[1] + z * info.tAxis[2] + info.tOffset;
    minS = Math.min(minS, s);
    maxS = Math.max(maxS, s);
    minT = Math.min(minT, t);
    maxT = Math.max(maxT, t);
  }

  const bminS = Math.floor(minS / LIGHTMAP_SCALE);
  const bminT = Math.floor(minT / LIGHTMAP_SCALE);
  const bmaxS = Math.ceil(maxS / LIGHTMAP_SCALE);
  const bmaxT = Math.ceil(maxT / LIGHTMAP_SCALE);

  return {
    texMins: [bminS * LIGHTMAP_SCALE, bminT * LIGHTMAP_SCALE],
    extents: [(bmaxS - bminS) * LIGHTMAP_SCALE, (bmaxT - bminT) * LIGHTMAP_SCALE],
  };
}

/** Regroupe les textures d'animation "+0nom" .. "+9nom" sous leur nom de base. */
function buildAnimationGroups(textures: BspMipTexture[]): Map<number, number[]> {
  const bases = new Map<string, Map<number, number>>();
  textures.forEach((texture, index) => {
    const name = texture.name;
    if (!name.startsWith('+')) return;
    const frameChar = name[1];
    const base = name.slice(2);
    const frame = Number.parseInt(frameChar, 10);
    if (Number.isNaN(frame)) return; // les séquences alternatives "+a.." sont ignorées
    if (!bases.has(base)) bases.set(base, new Map());
    bases.get(base)!.set(frame, index);
  });

  const result = new Map<number, number[]>();
  for (const frames of bases.values()) {
    const ordered = [...frames.entries()].sort((a, b) => a[0] - b[0]).map(([, index]) => index);
    for (const index of ordered) result.set(index, ordered);
  }
  return result;
}

interface SkyTextures {
  front: THREE.DataTexture;
  back: THREE.DataTexture;
}

/** La texture de ciel contient deux couches côte à côte. */
function buildSkyTextures(mip: BspMipTexture, palette: Palette): SkyTextures | null {
  if (!mip.pixels) return null;
  const half = mip.width >> 1;
  const height = mip.height;
  const front = new Uint8Array(half * height);
  const back = new Uint8Array(half * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < half; x++) {
      front[y * half + x] = mip.pixels[y * mip.width + x];
      back[y * half + x] = mip.pixels[y * mip.width + half + x];
    }
  }

  const make = (indices: Uint8Array, transparent: number) => {
    const texture = new THREE.DataTexture(
      palette.expand(indices, half, height, transparent),
      half,
      height,
      THREE.RGBAFormat,
    );
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.generateMipmaps = true;
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;
    return texture;
  };

  return { front: make(front, 0), back: make(back, -1) };
}

export interface BuiltWorld {
  root: THREE.Group;
  /** Un groupe par modèle du BSP, l'indice 0 étant la géométrie fixe. */
  models: THREE.Group[];
  /** Sources déduites des surfaces émettrices de la carte. */
  surfaceLights: HDLight[];
  setFlashlight(position: THREE.Vector3, color: THREE.Color, radius: number): void;
  /** Restreint le dessin aux faces retenues ; null rétablit tout. */
  setVisibleFaces(visible: Uint8Array | null): void;
  getDrawnFaces(): number;
  setDynamicLights(count: number, diffuse: number, specular: number): void;
  setShadow(
    map: THREE.Texture,
    matrix: THREE.Matrix4,
    view: THREE.Matrix4,
    strength: number,
    texel: number,
  ): void;
  styleIntensity(style: number): number;
  update(time: number): void;
  dispose(): void;
  stats: {
    faces: number;
    draws: number;
    textures: number;
    lightmapPages: number;
    /** Lots de surfaces rendus avec un matériau haute définition. */
    hdMaterials: number;
    /** Faces écartées du rendu : volumes de déclenchement et de service. */
    hiddenFaces: number;
  };
}

/**
 * Textures qui ne se dessinent pas : elles marquent des volumes de service.
 */
const INVISIBLE_TEXTURES = new Set(['trigger', 'clip', 'skip', 'hint', 'hintskip']);

/**
 * Sous-modèles à ne pas afficher.
 *
 * Une carte range dans ses sous-modèles aussi bien les portes et les
 * plateformes que les volumes de déclenchement, qui détectent le passage du
 * joueur et n'ont jamais été destinés à être vus. Les dessiner revient à
 * poser de grandes cloisons opaques au milieu des salles.
 */
function hiddenModels(entities: BspData['entities']): Set<number> {
  const hidden = new Set<number>();
  for (const entity of entities) {
    const model = /^\*(\d+)$/.exec(entity.model ?? '');
    if (!model) continue;
    const classname = entity.classname ?? '';
    if (classname.startsWith('trigger') || classname === 'func_illusionary_invisible') {
      hidden.add(Number.parseInt(model[1], 10));
    }
  }
  return hidden;
}

export function buildWorld(bsp: BspData, palette: Palette, options: WorldOptions): BuiltWorld {
  const atlas = new LightmapAtlas(options.atlasSize);
  const styles = new LightStyles();
  const detail = buildDetailTexture();

  const textureSets = new Map<number, TextureSet>();
  const getTextureSet = (index: number): TextureSet => {
    let set = textureSets.get(index);
    if (!set) {
      const mip = bsp.textures[index] ?? { name: '', width: 16, height: 16, pixels: null };
      set = buildTextureSet(mip, palette, { anisotropy: options.anisotropy });
      textureSets.set(index, set);
    }
    return set;
  };

  const animations = buildAnimationGroups(bsp.textures);

  const skyIndex = bsp.textures.findIndex((t) => classifyTexture(t.name) === 'sky');
  const skyTextures = skyIndex >= 0 ? buildSkyTextures(bsp.textures[skyIndex], palette) : null;

  type Kind = 'solid' | 'sky' | 'liquid';
  interface Bucket {
    kind: Kind;
    texture: number;
    page: number;
    geometry: FaceGeometry;
  }

  const root = new THREE.Group();
  root.name = 'world';
  const models: THREE.Group[] = [];
  const allMaterials: THREE.ShaderMaterial[] = [];

  /**
   * Lots du monde dont on peut ne dessiner qu'une partie.
   * L'index complet reste en mémoire ; à chaque changement de visibilité on
   * recopie les seules faces retenues au début d'un tampon de travail, et la
   * portée de dessin s'arrête là.
   */
  interface VisibleBatch {
    geometry: THREE.BufferGeometry;
    ranges: { face: number; start: number; count: number }[];
    fullIndex: Uint32Array;
    work: THREE.BufferAttribute;
  }
  const visibleBatches: VisibleBatch[] = [];
  const animatedMaterials: { material: THREE.ShaderMaterial; frames: number[] }[] = [];
  let faceCount = 0;
  let hdApplied = 0;

  /**
   * Sources déduites des surfaces qui émettent : un bassin de lave doit
   * éclairer sa salle. Elles sont regroupées par cellule d'espace, sinon une
   * grande nappe produirait des centaines de sources pour un seul reflet.
   */
  const emitterCells = new Map<
    string,
    { kind: 'lava' | 'slime' | 'teleport'; x: number; y: number; z: number; weight: number }
  >();
  const EMITTER_CELL = 320;

  const emptyTexture = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
  emptyTexture.needsUpdate = true;

  const hidden = hiddenModels(bsp.entities);
  let hiddenFaces = 0;

  for (const [modelIndex, model] of bsp.models.entries()) {
    const group = new THREE.Group();
    const buckets = new Map<string, Bucket>();

    // Le groupe reste dans la liste pour que les indices correspondent aux
    // sous-modèles de la carte, mais on ne lui construit aucune surface.
    if (hidden.has(modelIndex)) {
      hiddenFaces += model.faceCount;
      models.push(group);
      root.add(group);
      continue;
    }

    for (let f = 0; f < model.faceCount; f++) {
      const face = bsp.faces[model.firstFace + f];
      if (!face || face.edgeCount < 3) continue;
      const info = bsp.texInfos[face.texInfo];
      if (!info) continue;
      const mip = bsp.textures[info.miptex];
      // Les volumes de service portent une texture qui ne se dessine pas.
      if (INVISIBLE_TEXTURES.has((mip?.name ?? '').toLowerCase())) {
        hiddenFaces++;
        continue;
      }
      const kindName = classifyTexture(mip?.name ?? '');
      const kind: Kind = kindName === 'sky' ? 'sky' : kindName === 'normal' ? 'solid' : 'liquid';
      faceCount++;

      const plane = bsp.planes[face.plane];
      const sign = face.side ? -1 : 1;
      const normalQ: [number, number, number] = [
        plane.normal[0] * sign,
        plane.normal[1] * sign,
        plane.normal[2] * sign,
      ];
      const normal = quakeToThree(normalQ[0], normalQ[1], normalQ[2]);

      // Lightmap : une entrée par style présent sur la face.
      let slotX = 0;
      let slotY = 0;
      let page = 0;
      let lightWidth = 1;
      let lightHeight = 1;
      let texMins: [number, number] = [0, 0];
      let extents: [number, number] = [0, 0];

      if (kind === 'solid') {
        const measured = surfaceExtents(bsp, face);
        texMins = measured.texMins;
        extents = measured.extents;
        lightWidth = Math.min(64, Math.max(1, Math.floor(extents[0] / LIGHTMAP_SCALE) + 1));
        lightHeight = Math.min(64, Math.max(1, Math.floor(extents[1] / LIGHTMAP_SCALE) + 1));

        const samples: (Uint8Array | null)[] = [null, null, null, null];
        const hasLighting = face.lightOffset >= 0 && bsp.lighting.length > 0;
        if (hasLighting) {
          const size = lightWidth * lightHeight;
          for (let s = 0; s < 4; s++) {
            if (face.styles[s] === 255) break;
            const start = face.lightOffset + s * size;
            if (start + size <= bsp.lighting.length) {
              samples[s] = bsp.lighting.subarray(start, start + size);
            }
          }
        }
        // Une face sans éclairage calculé reste sombre. Une valeur claire en
        // ferait des taches blanches au milieu d'une carte par ailleurs cuite.
        const slot = atlas.add(lightWidth, lightHeight, samples, hasLighting ? 0 : 18);
        slotX = slot.x;
        slotY = slot.y;
        page = slot.page;
      }

      // Centre de la face, utile aux surfaces émettrices.
      if (kind === 'liquid') {
        const liquidKind = classifyTexture(mip?.name ?? '');
        if (liquidKind === 'lava' || liquidKind === 'slime' || liquidKind === 'teleport') {
          let cx = 0;
          let cy = 0;
          let cz = 0;
          for (let i = 0; i < face.edgeCount; i++) {
            const edgeIndex = bsp.surfEdges[face.firstEdge + i];
            const vertexIndex =
              edgeIndex >= 0 ? bsp.edges[edgeIndex * 2] : bsp.edges[-edgeIndex * 2 + 1];
            cx += bsp.vertices[vertexIndex * 3];
            cy += bsp.vertices[vertexIndex * 3 + 1];
            cz += bsp.vertices[vertexIndex * 3 + 2];
          }
          cx /= face.edgeCount;
          cy /= face.edgeCount;
          cz /= face.edgeCount;

          const cellKey = `${liquidKind}:${Math.round(cx / EMITTER_CELL)}:${Math.round(
            cy / EMITTER_CELL,
          )}:${Math.round(cz / EMITTER_CELL)}`;
          const cell = emitterCells.get(cellKey);
          if (cell) {
            cell.x += cx;
            cell.y += cy;
            cell.z += cz;
            cell.weight += 1;
          } else {
            emitterCells.set(cellKey, { kind: liquidKind, x: cx, y: cy, z: cz, weight: 1 });
          }
        }
      }

      const key = `${kind}:${info.miptex}:${page}`;
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = { kind, texture: info.miptex, page, geometry: newFaceGeometry() };
        buckets.set(key, bucket);
      }
      const geometry = bucket.geometry;

      const texWidth = mip?.width || 64;
      const texHeight = mip?.height || 64;
      const first = geometry.vertexCount;

      // Espace tangent : les axes de texture de la face font déjà le travail.
      const tangent = quakeToThree(info.sAxis[0], info.sAxis[1], info.sAxis[2]);
      const tangentVec = new THREE.Vector3(...tangent).normalize();
      const bitangentVec = new THREE.Vector3(
        ...quakeToThree(info.tAxis[0], info.tAxis[1], info.tAxis[2]),
      ).normalize();
      const normalVec = new THREE.Vector3(...normal);
      const handedness =
        new THREE.Vector3().crossVectors(normalVec, tangentVec).dot(bitangentVec) < 0 ? -1 : 1;

      for (let i = 0; i < face.edgeCount; i++) {
        const edgeIndex = bsp.surfEdges[face.firstEdge + i];
        const vertexIndex =
          edgeIndex >= 0 ? bsp.edges[edgeIndex * 2] : bsp.edges[-edgeIndex * 2 + 1];
        const x = bsp.vertices[vertexIndex * 3];
        const y = bsp.vertices[vertexIndex * 3 + 1];
        const z = bsp.vertices[vertexIndex * 3 + 2];

        const s = x * info.sAxis[0] + y * info.sAxis[1] + z * info.sAxis[2] + info.sOffset;
        const t = x * info.tAxis[0] + y * info.tAxis[1] + z * info.tAxis[2] + info.tOffset;

        const [px, py, pz] = quakeToThree(x, y, z);
        geometry.positions.push(px, py, pz);
        geometry.normals.push(normal[0], normal[1], normal[2]);
        geometry.uvs.push(s / texWidth, t / texHeight);
        geometry.tangents.push(tangentVec.x, tangentVec.y, tangentVec.z, handedness);
        geometry.styles.push(
          face.styles[0] === 255 ? 255 : face.styles[0],
          face.styles[1] === 255 ? 255 : face.styles[1],
          face.styles[2] === 255 ? 255 : face.styles[2],
          face.styles[3] === 255 ? 255 : face.styles[3],
        );

        if (kind === 'solid') {
          const lu = (s - texMins[0]) / LIGHTMAP_SCALE + 0.5 + slotX;
          const lv = (t - texMins[1]) / LIGHTMAP_SCALE + 0.5 + slotY;
          geometry.lightUvs.push(lu / atlas.size, lv / atlas.size);
        } else {
          geometry.lightUvs.push(0, 0);
        }
      }
      geometry.vertexCount += face.edgeCount;

      const indexStart = geometry.indices.length;
      for (let i = 1; i < face.edgeCount - 1; i++) {
        geometry.indices.push(first, first + i, first + i + 1);
      }
      geometry.faceRanges.push({
        face: model.firstFace + f,
        start: indexStart,
        count: geometry.indices.length - indexStart,
      });
    }

    for (const bucket of buckets.values()) {
      if (bucket.geometry.indices.length === 0) continue;
      const geometry = toBufferGeometry(bucket.geometry);
      const mip = bsp.textures[bucket.texture];
      const name = mip?.name ?? '';
      let material: THREE.ShaderMaterial;

      if (bucket.kind === 'sky') {
        material = createSkyMaterial(
          skyTextures?.front ?? emptyTexture,
          skyTextures?.back ?? emptyTexture,
          options.fogColor,
        );
      } else if (bucket.kind === 'liquid') {
        const kindName = classifyTexture(name) as LiquidKind;
        material = createLiquidMaterial(getTextureSet(bucket.texture).map, kindName, options);
      } else {
        const set = getTextureSet(bucket.texture);
        // Conversion haute définition si la texture en a une, sinon la
        // texture d'origine continue de faire le travail.
        const hd = options.hdMaterials?.resolve(name) ?? null;
        if (hd) hdApplied++;
        material = createWorldMaterial(
          set,
          emptyTexture,
          styles.texture,
          detail,
          emptyTexture,
          options,
          hd,
        );
        material.userData.lightmapPage = bucket.page;

        const frames = animations.get(bucket.texture);
        if (frames && frames.length > 1) {
          animatedMaterials.push({ material, frames });
        }
      }

      // Seul le monde est soumis à la visibilité précalculée : les portes et
      // les plateformes ne figurent pas dans les feuilles de l'arbre.
      if (modelIndex === 0 && bucket.geometry.faceRanges.length > 0) {
        const fullIndex = Uint32Array.from(bucket.geometry.indices);
        const work = new THREE.BufferAttribute(new Uint32Array(fullIndex.length), 1);
        work.setUsage(THREE.DynamicDrawUsage);
        work.array.set(fullIndex);
        geometry.setIndex(work);
        visibleBatches.push({
          geometry,
          ranges: bucket.geometry.faceRanges,
          fullIndex,
          work,
        });
      }

      const mesh = new THREE.Mesh(geometry, material);
      mesh.frustumCulled = true;
      mesh.renderOrder = bucket.kind === 'sky' ? -1 : bucket.kind === 'liquid' ? 1 : 0;
      group.add(mesh);
      allMaterials.push(material);
    }

    models.push(group);
    root.add(group);
  }

  // Les pages d'atlas n'existent qu'une fois toutes les faces placées.
  const lightmapPages = atlas.build();
  for (const material of allMaterials) {
    const page = material.userData.lightmapPage;
    if (typeof page === 'number' && lightmapPages[page]) {
      material.uniforms.uLightmap.value = lightmapPages[page];
    }
  }

  const setFlashlight = (position: THREE.Vector3, color: THREE.Color, radius: number) => {
    for (const material of allMaterials) {
      const uniforms = material.uniforms;
      if (uniforms.uFlashPos) uniforms.uFlashPos.value.copy(position);
      if (uniforms.uFlashColor) uniforms.uFlashColor.value.copy(color);
      if (uniforms.uFlashRadius) uniforms.uFlashRadius.value = radius;
    }
  };

  // Une source par cellule, placée un peu au-dessus de la nappe pour
  // éclairer ses bords plutôt que de rester noyée dedans.
  const surfaceLights: HDLight[] = [...emitterCells.values()].map((cell) => {
    const center: [number, number, number] = [
      cell.x / cell.weight,
      cell.y / cell.weight,
      cell.z / cell.weight + 24,
    ];
    const radius = Math.min(900, 300 + Math.sqrt(cell.weight) * 150);
    return lightFromSurface(center, cell.kind, radius);
  });

  const setShadow = (
    map: THREE.Texture,
    matrix: THREE.Matrix4,
    view: THREE.Matrix4,
    strength: number,
    texel: number,
  ) => {
    for (const material of allMaterials) {
      const uniforms = material.uniforms;
      if (!uniforms.uShadowStrength) continue;
      uniforms.uShadowMap.value = map;
      (uniforms.uShadowMatrix.value as THREE.Matrix4).copy(matrix);
      (uniforms.uShadowView.value as THREE.Matrix4).copy(view);
      uniforms.uShadowStrength.value = strength;
      uniforms.uShadowTexel.value = texel;
    }
  };

  let drawnFaces = faceCount;

  /**
   * Restreint le dessin aux faces retenues. Un tableau vide rétablit tout,
   * ce qui sert de filet quand la carte ne porte pas de données de visibilité.
   */
  const setVisibleFaces = (visible: Uint8Array | null) => {
    if (!visible) {
      for (const batch of visibleBatches) {
        batch.work.array.set(batch.fullIndex);
        batch.work.needsUpdate = true;
        batch.geometry.setDrawRange(0, batch.fullIndex.length);
      }
      drawnFaces = faceCount;
      return;
    }

    let drawn = 0;
    for (const batch of visibleBatches) {
      const target = batch.work.array as Uint32Array;
      let written = 0;
      for (const range of batch.ranges) {
        if (!visible[range.face]) continue;
        target.set(batch.fullIndex.subarray(range.start, range.start + range.count), written);
        written += range.count;
        drawn++;
      }
      batch.work.needsUpdate = true;
      batch.geometry.setDrawRange(0, written);
    }
    drawnFaces = drawn;
  };

  const setDynamicLights = (count: number, diffuse: number, specular: number) => {
    for (const material of allMaterials) {
      const uniforms = material.uniforms;
      if (!uniforms.uLightCount) continue;
      uniforms.uLightCount.value = count;
      uniforms.uDynamicDiffuse.value = diffuse;
      uniforms.uDynamicSpecular.value = specular;
    }
  };

  const update = (time: number) => {
    styles.update(time);
    for (const material of allMaterials) {
      if (material.uniforms.uTime) material.uniforms.uTime.value = time;
    }
    // Les textures animées défilent à cinq images par seconde.
    const frame = Math.floor(time * 5);
    for (const entry of animatedMaterials) {
      const index = entry.frames[frame % entry.frames.length];
      entry.material.uniforms.uMap.value = getTextureSet(index).map;
      entry.material.uniforms.uSurface.value = getTextureSet(index).surfaceMap;
    }
  };

  const dispose = () => {
    root.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        object.geometry.dispose();
        (object.material as THREE.Material).dispose();
      }
    });
    for (const set of textureSets.values()) {
      set.map.dispose();
      set.surfaceMap.dispose();
      set.emissiveMap?.dispose();
    }
    skyTextures?.front.dispose();
    skyTextures?.back.dispose();
    atlas.dispose();
    styles.dispose();
    detail.dispose();
    emptyTexture.dispose();
  };

  return {
    root,
    models,
    surfaceLights,
    setFlashlight,
    setVisibleFaces,
    getDrawnFaces: () => drawnFaces,
    setDynamicLights,
    setShadow,
    styleIntensity: (style: number) => styles.intensityOf(style),
    update,
    dispose,
    stats: {
      faces: faceCount,
      draws: allMaterials.length,
      textures: textureSets.size,
      lightmapPages: lightmapPages.length,
      hdMaterials: hdApplied,
      hiddenFaces,
    },
  };
}

import { BinaryReader } from './binary';

export const BSP_VERSION = 29;

/** Contenu d'une feuille ou d'un noeud de collision. */
export const Contents = {
  EMPTY: -1,
  SOLID: -2,
  WATER: -3,
  SLIME: -4,
  LAVA: -5,
  SKY: -6,
  CLIP: -8,
  CURRENT_0: -9,
  CURRENT_DOWN: -14,
} as const;

export const TEX_SPECIAL = 1;

export interface BspPlane {
  normal: [number, number, number];
  dist: number;
  type: number;
}

export interface BspNode {
  plane: number;
  children: [number, number];
  mins: [number, number, number];
  maxs: [number, number, number];
  firstFace: number;
  faceCount: number;
}

export interface BspClipNode {
  plane: number;
  children: [number, number];
}

export interface BspLeaf {
  contents: number;
  visOffset: number;
  mins: [number, number, number];
  maxs: [number, number, number];
  firstMarkSurface: number;
  markSurfaceCount: number;
  ambient: [number, number, number, number];
}

export interface BspTexInfo {
  /** s = dot(position, sAxis) + sOffset, idem pour t. */
  sAxis: [number, number, number];
  sOffset: number;
  tAxis: [number, number, number];
  tOffset: number;
  miptex: number;
  flags: number;
}

export interface BspFace {
  plane: number;
  side: number;
  firstEdge: number;
  edgeCount: number;
  texInfo: number;
  styles: [number, number, number, number];
  lightOffset: number;
}

export interface BspModel {
  mins: [number, number, number];
  maxs: [number, number, number];
  origin: [number, number, number];
  headNodes: [number, number, number, number];
  visLeafs: number;
  firstFace: number;
  faceCount: number;
}

export interface BspMipTexture {
  name: string;
  width: number;
  height: number;
  /** Niveau 0 en indices de palette, absent si la texture vit dans un wad externe. */
  pixels: Uint8Array | null;
}

export interface BspEntity {
  classname: string;
  [key: string]: string;
}

export interface BspData {
  entities: BspEntity[];
  planes: BspPlane[];
  textures: BspMipTexture[];
  vertices: Float32Array;
  visData: Uint8Array;
  nodes: BspNode[];
  texInfos: BspTexInfo[];
  faces: BspFace[];
  lighting: Uint8Array;
  clipNodes: BspClipNode[];
  leafs: BspLeaf[];
  markSurfaces: Uint16Array;
  edges: Int32Array;
  surfEdges: Int32Array;
  models: BspModel[];
}

const enum Lump {
  Entities,
  Planes,
  Textures,
  Vertexes,
  Visibility,
  Nodes,
  TexInfo,
  Faces,
  Lighting,
  ClipNodes,
  Leafs,
  MarkSurfaces,
  Edges,
  SurfEdges,
  Models,
  Count,
}

interface LumpRef {
  offset: number;
  length: number;
}

/** Le bloc d'entités est une suite de blocs { "clé" "valeur" }. */
export function parseEntities(text: string): BspEntity[] {
  const entities: BspEntity[] = [];
  let current: Record<string, string> | null = null;
  let key: string | null = null;
  let i = 0;

  const readToken = (): string | null => {
    while (i < text.length && /\s/.test(text[i])) i++;
    if (i >= text.length) return null;
    const c = text[i];
    if (c === '{' || c === '}') {
      i++;
      return c;
    }
    if (c === '"') {
      i++;
      const start = i;
      while (i < text.length && text[i] !== '"') i++;
      const value = text.slice(start, i);
      i++;
      return value;
    }
    const start = i;
    while (i < text.length && !/\s/.test(text[i])) i++;
    return text.slice(start, i);
  };

  for (;;) {
    const token = readToken();
    if (token === null) break;
    if (token === '{') {
      current = {};
      key = null;
    } else if (token === '}') {
      if (current) entities.push({ classname: '', ...current } as BspEntity);
      current = null;
    } else if (current) {
      if (key === null) key = token;
      else {
        current[key] = token;
        key = null;
      }
    }
  }
  return entities;
}

export function parseBsp(buffer: ArrayBuffer | Uint8Array): BspData {
  const reader = new BinaryReader(buffer);
  const version = reader.i32();
  if (version !== BSP_VERSION) {
    throw new Error(`BSP version ${version} non prise en charge (29 attendu)`);
  }

  const lumps: LumpRef[] = [];
  for (let i = 0; i < Lump.Count; i++) {
    lumps.push({ offset: reader.i32(), length: reader.i32() });
  }

  const at = (lump: Lump) => new BinaryReader(reader.bytes, lumps[lump].offset);
  const count = (lump: Lump, size: number) => Math.floor(lumps[lump].length / size);

  // Entités
  const entText = new TextDecoder('latin1').decode(
    reader.slice(lumps[Lump.Entities].offset, lumps[Lump.Entities].length),
  );
  const entities = parseEntities(entText);

  // Plans
  const planes: BspPlane[] = [];
  {
    const r = at(Lump.Planes);
    const n = count(Lump.Planes, 20);
    for (let i = 0; i < n; i++) {
      planes.push({ normal: r.vec3(), dist: r.f32(), type: r.i32() });
    }
  }

  // Textures (miptex)
  const textures: BspMipTexture[] = [];
  {
    const base = lumps[Lump.Textures].offset;
    if (lumps[Lump.Textures].length > 0) {
      const r = new BinaryReader(reader.bytes, base);
      const n = r.i32();
      const offsets: number[] = [];
      for (let i = 0; i < n; i++) offsets.push(r.i32());
      for (const rel of offsets) {
        if (rel < 0) {
          textures.push({ name: '', width: 16, height: 16, pixels: null });
          continue;
        }
        const t = new BinaryReader(reader.bytes, base + rel);
        const name = t.fixedString(16).toLowerCase();
        const width = t.u32();
        const height = t.u32();
        const dataOffset = t.u32();
        t.skip(12); // mips 1 à 3, régénérés côté GPU
        const valid = width > 0 && height > 0 && width <= 4096 && height <= 4096;
        const pixels =
          valid && dataOffset > 0
            ? reader.slice(base + rel + dataOffset, width * height)
            : null;
        textures.push({ name, width: valid ? width : 16, height: valid ? height : 16, pixels });
      }
    }
  }

  // Sommets
  const vertexCount = count(Lump.Vertexes, 12);
  const vertices = new Float32Array(vertexCount * 3);
  {
    const r = at(Lump.Vertexes);
    for (let i = 0; i < vertexCount * 3; i++) vertices[i] = r.f32();
  }

  const visData = reader.slice(lumps[Lump.Visibility].offset, lumps[Lump.Visibility].length);

  // Noeuds
  const nodes: BspNode[] = [];
  {
    const r = at(Lump.Nodes);
    const n = count(Lump.Nodes, 24);
    for (let i = 0; i < n; i++) {
      nodes.push({
        plane: r.i32(),
        children: [r.i16(), r.i16()],
        mins: [r.i16(), r.i16(), r.i16()],
        maxs: [r.i16(), r.i16(), r.i16()],
        firstFace: r.u16(),
        faceCount: r.u16(),
      });
    }
  }

  // TexInfo
  const texInfos: BspTexInfo[] = [];
  {
    const r = at(Lump.TexInfo);
    const n = count(Lump.TexInfo, 40);
    for (let i = 0; i < n; i++) {
      const sAxis = r.vec3();
      const sOffset = r.f32();
      const tAxis = r.vec3();
      const tOffset = r.f32();
      texInfos.push({ sAxis, sOffset, tAxis, tOffset, miptex: r.i32(), flags: r.i32() });
    }
  }

  // Faces
  const faces: BspFace[] = [];
  {
    const r = at(Lump.Faces);
    const n = count(Lump.Faces, 20);
    for (let i = 0; i < n; i++) {
      faces.push({
        plane: r.u16(),
        side: r.u16(),
        firstEdge: r.i32(),
        edgeCount: r.u16(),
        texInfo: r.u16(),
        styles: [r.u8(), r.u8(), r.u8(), r.u8()],
        lightOffset: r.i32(),
      });
    }
  }

  const lighting = reader.slice(lumps[Lump.Lighting].offset, lumps[Lump.Lighting].length);

  // Clipnodes
  const clipNodes: BspClipNode[] = [];
  {
    const r = at(Lump.ClipNodes);
    const n = count(Lump.ClipNodes, 8);
    for (let i = 0; i < n; i++) {
      clipNodes.push({ plane: r.i32(), children: [r.i16(), r.i16()] });
    }
  }

  // Feuilles
  const leafs: BspLeaf[] = [];
  {
    const r = at(Lump.Leafs);
    const n = count(Lump.Leafs, 28);
    for (let i = 0; i < n; i++) {
      leafs.push({
        contents: r.i32(),
        visOffset: r.i32(),
        mins: [r.i16(), r.i16(), r.i16()],
        maxs: [r.i16(), r.i16(), r.i16()],
        firstMarkSurface: r.u16(),
        markSurfaceCount: r.u16(),
        ambient: [r.u8(), r.u8(), r.u8(), r.u8()],
      });
    }
  }

  // Marksurfaces
  const markCount = count(Lump.MarkSurfaces, 2);
  const markSurfaces = new Uint16Array(markCount);
  {
    const r = at(Lump.MarkSurfaces);
    for (let i = 0; i < markCount; i++) markSurfaces[i] = r.u16();
  }

  // Arêtes
  const edgeCount = count(Lump.Edges, 4);
  const edges = new Int32Array(edgeCount * 2);
  {
    const r = at(Lump.Edges);
    for (let i = 0; i < edgeCount; i++) {
      edges[i * 2] = r.u16();
      edges[i * 2 + 1] = r.u16();
    }
  }

  const surfEdgeCount = count(Lump.SurfEdges, 4);
  const surfEdges = new Int32Array(surfEdgeCount);
  {
    const r = at(Lump.SurfEdges);
    for (let i = 0; i < surfEdgeCount; i++) surfEdges[i] = r.i32();
  }

  // Modèles (0 = monde, les suivants sont les portes, plateformes, etc.)
  const models: BspModel[] = [];
  {
    const r = at(Lump.Models);
    const n = count(Lump.Models, 64);
    for (let i = 0; i < n; i++) {
      models.push({
        mins: r.vec3(),
        maxs: r.vec3(),
        origin: r.vec3(),
        headNodes: [r.i32(), r.i32(), r.i32(), r.i32()],
        visLeafs: r.i32(),
        firstFace: r.i32(),
        faceCount: r.i32(),
      });
    }
  }

  return {
    entities,
    planes,
    textures,
    vertices,
    visData,
    nodes,
    texInfos,
    faces,
    lighting,
    clipNodes,
    leafs,
    markSurfaces,
    edges,
    surfEdges,
    models,
  };
}

/** Décompresse le PVS d'une feuille (encodage RLE des octets nuls). */
export function decompressVis(visData: Uint8Array, offset: number, leafCount: number): Uint8Array {
  const rowBytes = (leafCount + 7) >> 3;
  const out = new Uint8Array(rowBytes);
  if (offset < 0 || visData.length === 0) {
    out.fill(0xff);
    return out;
  }
  let src = offset;
  let dst = 0;
  while (dst < rowBytes) {
    if (visData[src] !== 0) {
      out[dst++] = visData[src++];
      continue;
    }
    src++;
    let runs = visData[src++];
    while (runs > 0 && dst < rowBytes) {
      out[dst++] = 0;
      runs--;
    }
  }
  return out;
}

/** Nom de texture -> rôle de rendu. */
export function classifyTexture(name: string): 'sky' | 'water' | 'slime' | 'lava' | 'teleport' | 'normal' {
  if (name.startsWith('sky')) return 'sky';
  if (name.startsWith('*')) {
    if (name.includes('lava')) return 'lava';
    if (name.includes('slime')) return 'slime';
    if (name.includes('tele')) return 'teleport';
    return 'water';
  }
  return 'normal';
}

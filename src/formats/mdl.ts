import { BinaryReader } from './binary';

/** Modèles animés "alias" : sommets en octets, animation par images clés. */
export const MDL_MAGIC = 'IDPO';
export const MDL_VERSION = 6;

export interface MdlSkin {
  /** Indices de palette, une image par variante. */
  pixels: Uint8Array;
  width: number;
  height: number;
}

export interface MdlFrame {
  name: string;
  /** Positions déjà mises à l'échelle, trois flottants par sommet. */
  positions: Float32Array;
  /** Index de normale précalculée, un par sommet. */
  normals: Uint8Array;
}

export interface MdlModel {
  skins: MdlSkin[];
  skinWidth: number;
  skinHeight: number;
  vertexCount: number;
  /** Coordonnées de texture par sommet, plus le drapeau de couture. */
  texCoords: { s: number; t: number; onSeam: boolean }[];
  triangles: { facesFront: boolean; vertices: [number, number, number] }[];
  frames: MdlFrame[];
  /** Durée de chaque image quand le modèle en impose une. */
  frameIntervals: number[] | null;
  eyePosition: [number, number, number];
  boundingRadius: number;
  flags: number;
}

function readSkin(reader: BinaryReader, width: number, height: number): MdlSkin[] {
  const group = reader.i32();
  const size = width * height;
  if (group === 0) {
    const pixels = reader.slice(reader.offset, size);
    reader.skip(size);
    return [{ pixels, width, height }];
  }

  // Peau animée : plusieurs images et leurs durées.
  const count = reader.i32();
  reader.skip(count * 4);
  const skins: MdlSkin[] = [];
  for (let i = 0; i < count; i++) {
    skins.push({ pixels: reader.slice(reader.offset, size), width, height });
    reader.skip(size);
  }
  return skins;
}

function readSimpleFrame(
  reader: BinaryReader,
  vertexCount: number,
  scale: [number, number, number],
  origin: [number, number, number],
): MdlFrame {
  reader.skip(8); // boîte englobante de l'image, recalculée à l'affichage
  const name = reader.fixedString(16);
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Uint8Array(vertexCount);

  for (let i = 0; i < vertexCount; i++) {
    const x = reader.u8();
    const y = reader.u8();
    const z = reader.u8();
    normals[i] = reader.u8();
    positions[i * 3] = x * scale[0] + origin[0];
    positions[i * 3 + 1] = y * scale[1] + origin[1];
    positions[i * 3 + 2] = z * scale[2] + origin[2];
  }
  return { name, positions, normals };
}

export function parseMdl(buffer: ArrayBuffer | Uint8Array): MdlModel {
  const reader = new BinaryReader(buffer);
  const magic = reader.magic(4);
  if (magic !== MDL_MAGIC) throw new Error(`signature ${MDL_MAGIC} attendue, reçu "${magic}"`);
  const version = reader.i32();
  if (version !== MDL_VERSION) throw new Error(`modèle version ${version} non pris en charge`);

  const scale = reader.vec3();
  const scaleOrigin = reader.vec3();
  const boundingRadius = reader.f32();
  const eyePosition = reader.vec3();
  const skinCount = reader.i32();
  const skinWidth = reader.i32();
  const skinHeight = reader.i32();
  const vertexCount = reader.i32();
  const triangleCount = reader.i32();
  const frameCount = reader.i32();
  reader.i32(); // synchronisation de l'animation, sans effet ici
  const flags = reader.i32();
  reader.f32(); // taille moyenne des triangles

  const skins: MdlSkin[] = [];
  for (let i = 0; i < skinCount; i++) skins.push(...readSkin(reader, skinWidth, skinHeight));

  const texCoords: MdlModel['texCoords'] = [];
  for (let i = 0; i < vertexCount; i++) {
    const onSeam = reader.i32() !== 0;
    texCoords.push({ onSeam, s: reader.i32(), t: reader.i32() });
  }

  const triangles: MdlModel['triangles'] = [];
  for (let i = 0; i < triangleCount; i++) {
    const facesFront = reader.i32() !== 0;
    triangles.push({ facesFront, vertices: [reader.i32(), reader.i32(), reader.i32()] });
  }

  const frames: MdlFrame[] = [];
  let frameIntervals: number[] | null = null;
  for (let i = 0; i < frameCount; i++) {
    const type = reader.i32();
    if (type === 0) {
      frames.push(readSimpleFrame(reader, vertexCount, scale, scaleOrigin));
      continue;
    }
    // Groupe d'images : une séquence avec ses propres durées.
    const count = reader.i32();
    reader.skip(8);
    const intervals: number[] = [];
    for (let k = 0; k < count; k++) intervals.push(reader.f32());
    frameIntervals = frameIntervals ?? [];
    for (let k = 0; k < count; k++) {
      frames.push(readSimpleFrame(reader, vertexCount, scale, scaleOrigin));
      frameIntervals.push(intervals[k]);
    }
  }

  return {
    skins,
    skinWidth,
    skinHeight,
    vertexCount,
    texCoords,
    triangles,
    frames,
    frameIntervals,
    eyePosition,
    boundingRadius,
    flags,
  };
}

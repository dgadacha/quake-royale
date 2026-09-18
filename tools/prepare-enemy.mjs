#!/usr/bin/env node
/**
 * Prépare un modèle détaillé pour qu'il rejoue les animations du jeu.
 *
 * Meshy livre deux fichiers qui ne se recouvrent pas : l'un porte les textures
 * mais forme un seul bloc, l'autre est découpé en parties mais nu. Le report
 * d'animation a besoin des deux — la texture pour l'affichage, le découpage
 * pour savoir quelle partie du maillage est l'arme, car c'est elle qui bouge
 * le plus et qui, mal rattachée, déchire le modèle.
 *
 * L'outil reporte le découpage sur le maillage texturé, allège le tout à une
 * densité tenable en jeu, et écrit un seul fichier.
 *
 *   node tools/prepare-enemy.mjs <texture.glb> <segmentation.glb> <sortie.glb> [sommets]
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { MeshoptSimplifier } from 'meshoptimizer';

const [texPath, segPath, outPath, targetArg, textureArg] = process.argv.slice(2);
if (!texPath || !segPath || !outPath) {
  console.error(
    'usage : node tools/prepare-enemy.mjs <texture.glb> <segmentation.glb> <sortie.glb> [sommets] [taille des textures]',
  );
  process.exit(1);
}
const TARGET = Number(targetArg ?? 15000);
const TEXTURE_SIZE = Number(textureArg ?? 2048);

/**
 * Ramène une image à une taille raisonnable.
 * Meshy livre la couleur en huit mille pixels de côté : de quoi peser plus que
 * tout le reste du jeu, pour un ennemi qu'on voit rarement de près.
 */
function shrink(buffer, index) {
  const dir = join(tmpdir(), `quake-hd-texture-${process.pid}-${index}`);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'image.jpg');
  try {
    writeFileSync(file, buffer);
    execFileSync('sips', ['-Z', String(TEXTURE_SIZE), '--setProperty', 'formatOptions', '82', file], {
      stdio: 'ignore',
    });
    const out = readFileSync(file);
    return out.length < buffer.length ? out : buffer;
  } catch {
    // Sans l'outil du système, l'image passe telle quelle.
    return buffer;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- lecture

function loadGlb(path) {
  const b = readFileSync(path);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let o = 12;
  let json = null;
  let bin = null;
  while (o < b.length) {
    const len = dv.getUint32(o, true);
    const type = String.fromCharCode(b[o + 4], b[o + 5], b[o + 6], b[o + 7]).replace(/\0/g, '');
    if (type === 'JSON') json = JSON.parse(Buffer.from(b.subarray(o + 8, o + 8 + len)).toString('utf8'));
    if (type === 'BIN') bin = b.subarray(o + 8, o + 8 + len);
    o += 8 + len;
  }
  const TYPES = { 5121: Uint8Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
  const SIZES = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
  const read = (index) => {
    const a = json.accessors[index];
    const bv = json.bufferViews[a.bufferView];
    const C = TYPES[a.componentType];
    const n = SIZES[a.type];
    const start = bin.byteOffset + (bv.byteOffset || 0) + (a.byteOffset || 0);
    const stride = bv.byteStride;
    if (stride && stride !== n * C.BYTES_PER_ELEMENT) {
      const out = new C(a.count * n);
      const src = new DataView(bin.buffer, start, a.count * stride);
      for (let k = 0; k < a.count; k++) {
        for (let c = 0; c < n; c++) {
          out[k * n + c] =
            C === Float32Array ? src.getFloat32(k * stride + c * 4, true) : src.getUint32(k * stride + c * 4, true);
        }
      }
      return out;
    }
    return new C(bin.buffer, start, a.count * n);
  };
  const viewBytes = (index) => {
    const bv = json.bufferViews[index];
    const start = bin.byteOffset + (bv.byteOffset || 0);
    return Buffer.from(bin.buffer, start, bv.byteLength);
  };
  return { json, bin, read, viewBytes };
}

const box = (pos, n) => {
  const mn = [Infinity, Infinity, Infinity];
  const mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 3; k++) {
      mn[k] = Math.min(mn[k], pos[i * 3 + k]);
      mx[k] = Math.max(mx[k], pos[i * 3 + k]);
    }
  }
  return { mn, mx };
};

// ------------------------------------------------- report du découpage

const tex = loadGlb(texPath);
const seg = loadGlb(segPath);
const prim = tex.json.meshes[0].primitives[0];
const position = new Float32Array(tex.read(prim.attributes.POSITION));
const normal = prim.attributes.NORMAL !== undefined ? new Float32Array(tex.read(prim.attributes.NORMAL)) : null;
const uv = prim.attributes.TEXCOORD_0 !== undefined ? new Float32Array(tex.read(prim.attributes.TEXCOORD_0)) : null;
const rawIndices = tex.read(prim.indices);
const indices = rawIndices instanceof Uint32Array ? rawIndices : new Uint32Array(rawIndices);
const count = position.length / 3;

const segParts = seg.json.nodes.map((node) => ({
  name: node.name ?? '',
  pos: seg.read(seg.json.meshes[node.mesh].primitives[0].attributes.POSITION),
}));

/**
 * Élancement d'une partie : longueur le long de son axe principal, rapportée
 * à son épaisseur. Une arme tenue en main est bien plus allongée qu'un torse
 * ou qu'une cuisse, et c'est ce qui permet de la reconnaître sans se fier au
 * numéro que l'exportateur lui a donné.
 */
function slenderness(pos) {
  const n = pos.length / 3;
  const step = Math.max(1, Math.floor(n / 8000));
  const c = [0, 1, 2].map((k) => {
    let sum = 0;
    let taken = 0;
    for (let i = 0; i < n; i += step) {
      sum += pos[i * 3 + k];
      taken++;
    }
    return sum / taken;
  });
  let axis = [1, 0.3, 0.2];
  for (let it = 0; it < 120; it++) {
    const r = [0, 0, 0];
    for (let i = 0; i < n; i += step) {
      const d = [pos[i * 3] - c[0], pos[i * 3 + 1] - c[1], pos[i * 3 + 2] - c[2]];
      const dot = d[0] * axis[0] + d[1] * axis[1] + d[2] * axis[2];
      for (let k = 0; k < 3; k++) r[k] += d[k] * dot;
    }
    const norm = Math.hypot(r[0], r[1], r[2]);
    if (norm < 1e-20) break;
    axis = r.map((x) => x / norm);
  }
  let along = 0;
  let across = 0;
  for (let i = 0; i < n; i += step) {
    const d = [pos[i * 3] - c[0], pos[i * 3 + 1] - c[1], pos[i * 3 + 2] - c[2]];
    const a = d[0] * axis[0] + d[1] * axis[1] + d[2] * axis[2];
    along = Math.max(along, Math.abs(a));
    across = Math.max(across, Math.hypot(d[0] - a * axis[0], d[1] - a * axis[1], d[2] - a * axis[2]));
  }
  return across > 0 ? along / across : 0;
}

// La partie la plus élancée, en dehors de la plus fournie qui est le corps,
// est l'arme. C'est elle qui bouge le plus, et qui doit être rattachée à
// l'arme du modèle d'origine plutôt qu'à la main qui la tient.
const biggest = segParts.reduce((best, p, i) => (p.pos.length > segParts[best].pos.length ? i : best), 0);
const slender = segParts.map((p) => slenderness(p.pos));
let weaponPart = -1;
for (let i = 0; i < segParts.length; i++) {
  if (i === biggest) continue;
  if (slender[i] < 2) continue;
  if (weaponPart < 0 || slender[i] > slender[weaponPart]) weaponPart = i;
}

// Les deux fichiers sortent à des échelles différentes : on les ramène tous
// deux à une hauteur de un, pieds au sol, avant de les comparer.
const segBox = segParts.reduce(
  (acc, p) => {
    const b = box(p.pos, p.pos.length / 3);
    for (let k = 0; k < 3; k++) {
      acc.mn[k] = Math.min(acc.mn[k], b.mn[k]);
      acc.mx[k] = Math.max(acc.mx[k], b.mx[k]);
    }
    return acc;
  },
  { mn: [Infinity, Infinity, Infinity], mx: [-Infinity, -Infinity, -Infinity] },
);
const texBox = box(position, count);

const normalise = (pos, n, bb) => {
  const h = bb.mx[1] - bb.mn[1];
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    out[i * 3] = (pos[i * 3] - (bb.mn[0] + bb.mx[0]) / 2) / h;
    out[i * 3 + 1] = (pos[i * 3 + 1] - bb.mn[1]) / h;
    out[i * 3 + 2] = (pos[i * 3 + 2] - (bb.mn[2] + bb.mx[2]) / 2) / h;
  }
  return out;
};

const texNorm = normalise(position, count, texBox);
let segCount = 0;
for (const p of segParts) segCount += p.pos.length / 3;
const segNorm = new Float32Array(segCount * 3);
const segLabel = new Uint8Array(segCount);
let write = 0;
segParts.forEach((p, index) => {
  const n = p.pos.length / 3;
  segNorm.set(normalise(p.pos, n, segBox), write * 3);
  segLabel.fill(index, write, write + n);
  write += n;
});

const CELL = 0.02;
const grid = new Map();
for (let i = 0; i < segCount; i++) {
  const k = `${Math.floor(segNorm[i * 3] / CELL)},${Math.floor(segNorm[i * 3 + 1] / CELL)},${Math.floor(segNorm[i * 3 + 2] / CELL)}`;
  let cell = grid.get(k);
  if (!cell) {
    cell = [];
    grid.set(k, cell);
  }
  cell.push(i);
}

const part = new Float32Array(count);
for (let i = 0; i < count; i++) {
  const x = texNorm[i * 3];
  const y = texNorm[i * 3 + 1];
  const z = texNorm[i * 3 + 2];
  const cx = Math.floor(x / CELL);
  const cy = Math.floor(y / CELL);
  const cz = Math.floor(z / CELL);
  let best = Infinity;
  let label = 0;
  for (let r = 0; r <= 3 && best === Infinity; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dz = -r; dz <= r; dz++) {
          if (r > 0 && Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== r) continue;
          const cell = grid.get(`${cx + dx},${cy + dy},${cz + dz}`);
          if (!cell) continue;
          for (const j of cell) {
            const d = (x - segNorm[j * 3]) ** 2 + (y - segNorm[j * 3 + 1]) ** 2 + (z - segNorm[j * 3 + 2]) ** 2;
            if (d < best) {
              best = d;
              label = segLabel[j];
            }
          }
        }
      }
    }
  }
  part[i] = label === weaponPart ? 1 : 0;
}

// --------------------------------------------------------- allègement

await MeshoptSimplifier.ready;
const [simplified, error] = MeshoptSimplifier.simplify(indices, position, 3, TARGET * 2 * 3, 0.01, ['LockBorder']);

const remap = new Int32Array(count).fill(-1);
let kept = 0;
for (const v of simplified) if (remap[v] < 0) remap[v] = kept++;

const outPosition = new Float32Array(kept * 3);
const outNormal = normal ? new Float32Array(kept * 3) : null;
const outUv = uv ? new Float32Array(kept * 2) : null;
const outPart = new Float32Array(kept);
for (let v = 0; v < count; v++) {
  const d = remap[v];
  if (d < 0) continue;
  for (let k = 0; k < 3; k++) {
    outPosition[d * 3 + k] = position[v * 3 + k];
    if (outNormal) outNormal[d * 3 + k] = normal[v * 3 + k];
  }
  if (outUv) {
    outUv[d * 2] = uv[v * 2];
    outUv[d * 2 + 1] = uv[v * 2 + 1];
  }
  outPart[d] = part[v];
}
const outIndices = new Uint32Array(simplified.length);
for (let i = 0; i < simplified.length; i++) outIndices[i] = remap[simplified[i]];

const shares = new Map();
for (let i = 0; i < kept; i++) shares.set(outPart[i], (shares.get(outPart[i]) ?? 0) + 1);

// ----------------------------------------------------------- écriture

const chunks = [];
let offset = 0;
const addView = (buffer) => {
  const pad = (4 - (buffer.length % 4)) % 4;
  const view = { buffer: 0, byteOffset: offset, byteLength: buffer.length };
  chunks.push(buffer, Buffer.alloc(pad));
  offset += buffer.length + pad;
  return view;
};

const bufferViews = [];
const accessors = [];
const addAccessor = (data, type, componentType, extra = {}) => {
  bufferViews.push(addView(Buffer.from(data.buffer, data.byteOffset, data.byteLength)));
  accessors.push({
    bufferView: bufferViews.length - 1,
    componentType,
    count: data.length / ({ SCALAR: 1, VEC2: 2, VEC3: 3 }[type]),
    type,
    ...extra,
  });
  return accessors.length - 1;
};

const bb = box(outPosition, kept);
const aPos = addAccessor(outPosition, 'VEC3', 5126, { min: bb.mn, max: bb.mx });
const aNormal = outNormal ? addAccessor(outNormal, 'VEC3', 5126) : undefined;
const aUv = outUv ? addAccessor(outUv, 'VEC2', 5126) : undefined;
const aPart = addAccessor(outPart, 'SCALAR', 5126);
const aIndex = addAccessor(outIndices, 'SCALAR', 5125);

// Les images du fichier texturé sont reprises, ramenées à une taille tenable.
let avant = 0;
let apres = 0;
const images = tex.json.images.map((image, index) => {
  const source = tex.viewBytes(image.bufferView);
  const reduced = image.mimeType === 'image/jpeg' ? shrink(source, index) : source;
  avant += source.length;
  apres += reduced.length;
  bufferViews.push(addView(reduced));
  return { mimeType: image.mimeType, bufferView: bufferViews.length - 1 };
});

const attributes = { POSITION: aPos, _PART: aPart };
if (aNormal !== undefined) attributes.NORMAL = aNormal;
if (aUv !== undefined) attributes.TEXCOORD_0 = aUv;

const bin = Buffer.concat(chunks);
const json = {
  asset: { version: '2.0', generator: 'quake-hd prepare-enemy' },
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [{ mesh: 0 }],
  meshes: [{ primitives: [{ attributes, indices: aIndex, material: 0 }] }],
  materials: tex.json.materials,
  textures: tex.json.textures,
  samplers: tex.json.samplers,
  images,
  accessors,
  bufferViews,
  buffers: [{ byteLength: bin.length }],
};

const jsonBuf = Buffer.from(JSON.stringify(json), 'utf8');
const jsonPad = Buffer.alloc((4 - (jsonBuf.length % 4)) % 4, 0x20);
const header = Buffer.alloc(12);
header.write('glTF', 0, 'ascii');
header.writeUInt32LE(2, 4);
header.writeUInt32LE(12 + 8 + jsonBuf.length + jsonPad.length + 8 + bin.length, 8);
const jsonHeader = Buffer.alloc(8);
jsonHeader.writeUInt32LE(jsonBuf.length + jsonPad.length, 0);
jsonHeader.write('JSON', 4, 'ascii');
const binHeader = Buffer.alloc(8);
binHeader.writeUInt32LE(bin.length, 0);
binHeader.write('BIN\0', 4, 'ascii');

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, Buffer.concat([header, jsonHeader, jsonBuf, jsonPad, binHeader, bin]));

console.log(`départ   ${count} sommets, ${indices.length / 3} triangles`);
console.log(`allégé   ${kept} sommets, ${outIndices.length / 3} triangles (écart ${(error * 100).toFixed(2)} %)`);
console.log(
  'découpage ' +
    segParts.map((p, i) => `${p.name || i} élancement ${slender[i].toFixed(2)}${i === weaponPart ? ' <- arme' : ''}`).join(', '),
);
console.log(
  `parties  arme ${(100 * (shares.get(1) ?? 0) / kept).toFixed(1)} %, corps ${(100 * (shares.get(0) ?? 0) / kept).toFixed(1)} %`,
);
console.log(`textures ${(avant / 1048576).toFixed(1)} Mo ramenés à ${(apres / 1048576).toFixed(1)} Mo (${TEXTURE_SIZE} px)`);
console.log(`écrit    ${outPath} (${(Buffer.byteLength(readFileSync(outPath)) / 1048576).toFixed(1)} Mo)`);

#!/usr/bin/env node
/**
 * Dessine le découpage d'un modèle sur une peau.
 *
 * Une peau refaite doit reprendre l'agencement du modèle, dont les
 * coordonnées de texture ne bougent pas. Superposer le découpage à l'image
 * montre d'un coup d'œil ce qui tombe juste et ce qui glisse.
 *
 *   node tools/uv-overlay.mjs <modele.mdl> <peau.png> <sortie.png>
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync, inflateSync } from 'node:zlib';
import { dirname } from 'node:path';

const [modelName, skinPath, outPath] = process.argv.slice(2);
if (!modelName || !skinPath || !outPath) {
  console.error('usage : node tools/uv-overlay.mjs <progs/xxx.mdl> <peau.png> <sortie.png>');
  process.exit(1);
}

// ------------------------------------------------------------------- PNG

const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
const crc32 = (b) => {
  let c = -1;
  for (let i = 0; i < b.length; i++) c = crcTable[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
const chunk = (type, data) => {
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
};
function encodePng(rgba, w, h) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
function decodePng(path) {
  const b = readFileSync(path);
  let o = 8;
  let w = 0;
  let h = 0;
  let colour = 0;
  let bits = 0;
  const parts = [];
  while (o < b.length) {
    const len = b.readUInt32BE(o);
    const type = b.toString('ascii', o + 4, o + 8);
    const data = b.subarray(o + 8, o + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      bits = data[8];
      colour = data[9];
    }
    if (type === 'IDAT') parts.push(data);
    if (type === 'IEND') break;
    o += 12 + len;
  }
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colour];
  if (!channels || bits !== 8) throw new Error(`image non gérée : ${bits} bits, type ${colour}`);
  const raw = inflateSync(Buffer.concat(parts));
  const stride = w * channels;
  const out = new Uint8Array(w * h * 4);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur = new Uint8Array(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0;
      const bb = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += bb;
      else if (filter === 3) v += (a + bb) >> 1;
      else if (filter === 4) {
        const p = a + bb - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - bb);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? bb : c;
      }
      cur[x] = v & 0xff;
    }
    prev = cur;
    for (let x = 0; x < w; x++) {
      const s = x * channels;
      const d = (y * w + x) * 4;
      out[d] = cur[s];
      out[d + 1] = channels >= 3 ? cur[s + 1] : cur[s];
      out[d + 2] = channels >= 3 ? cur[s + 2] : cur[s];
      out[d + 3] = 255;
    }
  }
  return { w, h, data: out };
}

// ------------------------------------------------------------- le modèle

const pak = readFileSync('public/data/pak0.pak');
const dv = new DataView(pak.buffer, pak.byteOffset, pak.byteLength);
const dirOffset = dv.getInt32(4, true);
const dirLength = dv.getInt32(8, true);
let base = -1;
for (let i = 0; i < dirLength / 64; i++) {
  const o = dirOffset + i * 64;
  let name = '';
  for (let j = 0; j < 56; j++) {
    const c = pak[o + j];
    if (!c) break;
    name += String.fromCharCode(c);
  }
  if (name.toLowerCase() === modelName.toLowerCase()) base = dv.getInt32(o + 56, true);
}
if (base < 0) {
  console.error(`modèle introuvable : ${modelName}`);
  process.exit(1);
}

const skinCount = dv.getInt32(base + 48, true);
const skinWidth = dv.getInt32(base + 52, true);
const skinHeight = dv.getInt32(base + 56, true);
const vertexCount = dv.getInt32(base + 60, true);
const triangleCount = dv.getInt32(base + 64, true);

let cursor = base + 84;
for (let i = 0; i < skinCount; i++) {
  const group = dv.getInt32(cursor, true);
  cursor += 4;
  if (group === 0) cursor += skinWidth * skinHeight;
  else {
    const n = dv.getInt32(cursor, true);
    cursor += 4 + n * 4 + n * skinWidth * skinHeight;
  }
}

const coords = [];
for (let i = 0; i < vertexCount; i++) {
  coords.push({
    onSeam: dv.getInt32(cursor, true) !== 0,
    s: dv.getInt32(cursor + 4, true),
    t: dv.getInt32(cursor + 8, true),
  });
  cursor += 12;
}
const triangles = [];
for (let i = 0; i < triangleCount; i++) {
  triangles.push({
    facesFront: dv.getInt32(cursor, true) !== 0,
    vertices: [dv.getInt32(cursor + 4, true), dv.getInt32(cursor + 8, true), dv.getInt32(cursor + 12, true)],
  });
  cursor += 16;
}

// ------------------------------------------------------------ le dessin

const skin = decodePng(skinPath);
const out = new Uint8Array(skin.data);

const line = (x0, y0, x1, y1, front) => {
  const steps = Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)));
  for (let i = 0; i <= steps; i++) {
    const x = Math.round(x0 + ((x1 - x0) * i) / steps);
    const y = Math.round(y0 + ((y1 - y0) * i) / steps);
    if (x < 0 || y < 0 || x >= skin.w || y >= skin.h) continue;
    const o = (y * skin.w + x) * 4;
    // Vert pour l'avant, rouge pour l'arrière : les deux moitiés de la peau.
    out[o] = front ? 40 : 255;
    out[o + 1] = front ? 255 : 40;
    out[o + 2] = 40;
  }
};

for (const triangle of triangles) {
  const points = triangle.vertices.map((v) => {
    const coord = coords[v];
    let s = coord.s;
    if (coord.onSeam && !triangle.facesFront) s += skinWidth / 2;
    return [((s + 0.5) / skinWidth) * skin.w, ((coord.t + 0.5) / skinHeight) * skin.h];
  });
  for (let k = 0; k < 3; k++) {
    const a = points[k];
    const b = points[(k + 1) % 3];
    line(a[0], a[1], b[0], b[1], triangle.facesFront);
  }
}

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, encodePng(out, skin.w, skin.h));
console.log(`${modelName} : ${triangleCount} faces, peau d'origine ${skinWidth}x${skinHeight}`);
console.log(`image fournie ${skin.w}x${skin.h}`);
console.log(`découpage superposé dans ${outPath}`);

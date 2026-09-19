#!/usr/bin/env node
/**
 * Exporte en PNG les peaux des modèles animés.
 *
 * Elles servent de gabarit : une peau refaite doit garder le même agencement,
 * puisque les coordonnées de texture des modèles ne bougent pas. Seule la
 * taille peut changer.
 *
 *   node tools/export-skins.mjs [dossier-de-sortie]
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { join } from 'node:path';

const OUT = process.argv[2] ?? 'reference/skins';
const PAK = 'public/data/pak0.pak';

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

const pak = readFileSync(PAK);
const dv = new DataView(pak.buffer, pak.byteOffset, pak.byteLength);
const dirOffset = dv.getInt32(4, true);
const dirLength = dv.getInt32(8, true);

const entries = [];
for (let i = 0; i < dirLength / 64; i++) {
  const o = dirOffset + i * 64;
  let name = '';
  for (let j = 0; j < 56; j++) {
    const c = pak[o + j];
    if (!c) break;
    name += String.fromCharCode(c);
  }
  entries.push({ name: name.toLowerCase(), offset: dv.getInt32(o + 56, true) });
}

const paletteEntry = entries.find((e) => e.name === 'gfx/palette.lmp');
if (!paletteEntry) {
  console.error('palette introuvable');
  process.exit(1);
}
const palette = pak.subarray(paletteEntry.offset, paletteEntry.offset + 768);

mkdirSync(OUT, { recursive: true });

for (const entry of entries) {
  if (!/^progs\/.*\.mdl$/.test(entry.name)) continue;
  const o = entry.offset;
  if (String.fromCharCode(pak[o], pak[o + 1], pak[o + 2], pak[o + 3]) !== 'IDPO') continue;

  const skinCount = dv.getInt32(o + 48, true);
  const width = dv.getInt32(o + 52, true);
  const height = dv.getInt32(o + 56, true);
  if (skinCount <= 0 || width <= 0 || height <= 0) continue;

  // Les peaux suivent l'en-tête ; une peau animée est précédée de son nombre
  // d'images, dont on ne garde que la première.
  let cursor = o + 84;
  const group = dv.getInt32(cursor, true);
  cursor += 4;
  if (group !== 0) {
    const count = dv.getInt32(cursor, true);
    cursor += 4 + count * 4;
  }

  const pixels = pak.subarray(cursor, cursor + width * height);
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const index = pixels[i];
    rgba[i * 4] = palette[index * 3];
    rgba[i * 4 + 1] = palette[index * 3 + 1];
    rgba[i * 4 + 2] = palette[index * 3 + 2];
    rgba[i * 4 + 3] = 255;
  }

  const file = entry.name.replace('progs/', '').replace('.mdl', '.png');
  writeFileSync(join(OUT, file), encodePng(rgba, width, height));
  console.log(`${file.padEnd(18)} ${width}x${height}`);
}
console.log(`\npeaux exportées dans ${OUT}`);

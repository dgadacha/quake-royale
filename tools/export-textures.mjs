#!/usr/bin/env node
/**
 * Exporte en PNG toutes les textures des cartes, pour servir de base à un
 * pack haute définition.
 *
 * Les cartes embarquent leurs textures sous forme d'indices de palette : ce
 * sont elles la source, pas un fichier d'images séparé. Chaque nom n'est
 * exporté qu'une fois, même s'il apparaît dans vingt cartes.
 *
 *   node tools/export-textures.mjs [dossier-de-sortie]
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { join, basename } from 'node:path';

/**
 * Famille de matériau, lue depuis le moteur pour qu'il n'existe qu'un seul
 * classement. Sans esbuild sous la main, la colonne reste simplement vide.
 */
async function loadFamily() {
  try {
    const { build } = await import('esbuild');
    const out = await build({
      entryPoints: ['src/render/surfaceProfiles.ts'],
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'node',
    });
    const mod = await import(
      'data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64')
    );
    return mod.familyFromName;
  } catch {
    return () => '';
  }
}

/** Surfaces que le moteur ne dessine jamais : inutile de les refaire. */
const INVISIBLE = new Set(['trigger', 'clip', 'skip', 'hint', 'hintskip']);

const DATA = 'public/data';
const OUT = process.argv[2] ?? 'reference/textures';

// ---------------------------------------------------------------- encodage PNG

const crcTable = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  const body = out.subarray(4, 8 + data.length);
  out.writeUInt32BE(crc32(body), 8 + data.length);
  return out;
}

function encodePng(rgba, width, height) {
  // Chaque ligne est précédée de son octet de filtre, ici toujours « aucun ».
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(
      raw,
      y * (width * 4 + 1) + 1,
    );
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // 8 bits par composante
  ihdr[9] = 6;   // RVB + alpha
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ------------------------------------------------------------------- lecture

function pakEntries(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (String.fromCharCode(buf[0], buf[1], buf[2], buf[3]) !== 'PACK') return new Map();
  const offset = dv.getInt32(4, true);
  const length = dv.getInt32(8, true);
  const entries = new Map();
  for (let i = 0; i < length / 64; i++) {
    const o = offset + i * 64;
    let name = '';
    for (let j = 0; j < 56; j++) {
      const c = buf[o + j];
      if (!c) break;
      name += String.fromCharCode(c);
    }
    entries.set(name.toLowerCase(), {
      offset: dv.getInt32(o + 56, true),
      length: dv.getInt32(o + 60, true),
    });
  }
  return entries;
}

/** Textures d'un BSP : nom, dimensions et indices de palette. */
function bspTextures(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const version = dv.getInt32(0, true);
  if (version !== 29 && version !== 30) return [];
  // Lump 2 : les textures.
  const base = dv.getInt32(4 + 2 * 8, true);
  const size = dv.getInt32(4 + 2 * 8 + 4, true);
  if (base <= 0 || base + size > buf.length) return [];

  const count = dv.getInt32(base, true);
  if (count < 0 || count > 8192) return [];

  const out = [];
  for (let i = 0; i < count; i++) {
    const rel = dv.getInt32(base + 4 + i * 4, true);
    if (rel < 0) continue;
    const o = base + rel;
    let name = '';
    for (let j = 0; j < 16; j++) {
      const c = buf[o + j];
      if (!c) break;
      name += String.fromCharCode(c);
    }
    const width = dv.getInt32(o + 16, true);
    const height = dv.getInt32(o + 20, true);
    const first = dv.getInt32(o + 24, true);
    if (width <= 0 || height <= 0 || first <= 0) continue;
    if (o + first + width * height > buf.length) continue;
    out.push({
      name: name.toLowerCase(),
      width,
      height,
      pixels: buf.subarray(o + first, o + first + width * height),
    });
  }
  return out;
}

/** Nom de fichier sûr : les marques d'animation ne passent pas partout. */
function safeName(name) {
  return name
    .replace(/^\*/, 'liquide_')
    .replace(/^\{/, 'masque_')
    .replace(/^\+/, 'anim_')
    .replace(/[^a-z0-9_.-]/gi, '_');
}

// -------------------------------------------------------------------- export

const palettePath = ['gfx/palette.lmp'];
let palette = null;
const textures = new Map();
const seenIn = new Map();

const sources = [];
if (existsSync(DATA)) {
  for (const file of readdirSync(DATA)) {
    if (file.toLowerCase().endsWith('.pak')) sources.push(join(DATA, file));
  }
  const maps = join(DATA, 'maps');
  if (existsSync(maps)) {
    for (const file of readdirSync(maps)) {
      if (file.toLowerCase().endsWith('.bsp')) sources.push(join(maps, file));
    }
  }
}
if (sources.length === 0) {
  console.error(`aucune donnée trouvée dans ${DATA}`);
  process.exit(1);
}

const note = (name, origin) => {
  if (!seenIn.has(name)) seenIn.set(name, new Set());
  seenIn.get(name).add(origin);
};

for (const source of sources) {
  const buf = readFileSync(source);
  if (source.toLowerCase().endsWith('.pak')) {
    const entries = pakEntries(buf);
    for (const key of palettePath) {
      const e = entries.get(key);
      if (e && !palette) palette = buf.subarray(e.offset, e.offset + e.length);
    }
    for (const [name, e] of entries) {
      if (!/\.bsp$/.test(name)) continue;
      const map = basename(name);
      for (const tex of bspTextures(buf.subarray(e.offset, e.offset + e.length))) {
        if (!textures.has(tex.name)) textures.set(tex.name, tex);
        note(tex.name, map);
      }
    }
  } else {
    const map = basename(source);
    for (const tex of bspTextures(buf)) {
      if (!textures.has(tex.name)) textures.set(tex.name, tex);
      note(tex.name, map);
    }
  }
}

if (!palette) {
  console.error('palette introuvable : gfx/palette.lmp doit être présent dans un .pak');
  process.exit(1);
}

mkdirSync(OUT, { recursive: true });

const familyFromName = await loadFamily();
const rows = [
  ['nom', 'fichier', 'largeur', 'hauteur', 'cartes', 'famille', 'a_refaire', 'exemple'],
];
let written = 0;
for (const [name, tex] of [...textures].sort((a, b) => a[0].localeCompare(b[0]))) {
  const { width, height, pixels } = tex;
  const rgba = new Uint8Array(width * height * 4);
  // Les textures dont le nom commence par une accolade réservent le dernier
  // index de la palette à la transparence.
  const masked = name.startsWith('{');
  for (let i = 0; i < width * height; i++) {
    const index = pixels[i];
    if (masked && index === 255) continue;
    rgba[i * 4] = palette[index * 3];
    rgba[i * 4 + 1] = palette[index * 3 + 1];
    rgba[i * 4 + 2] = palette[index * 3 + 2];
    rgba[i * 4 + 3] = 255;
  }
  const file = `${safeName(name)}.png`;
  writeFileSync(join(OUT, file), encodePng(rgba, width, height));
  const maps = [...(seenIn.get(name) ?? [])].sort();
  rows.push([
    name,
    file,
    width,
    height,
    maps.length,
    familyFromName(name),
    INVISIBLE.has(name) ? 'non' : 'oui',
    maps[0] ?? '',
  ]);
  written++;
}

writeFileSync(
  join(OUT, 'index.csv'),
  rows.map((r) => r.map((c) => (/[",;]/.test(String(c)) ? `"${c}"` : c)).join(';')).join('\n'),
);

console.log(`${written} textures exportées dans ${OUT}`);
console.log(`index : ${join(OUT, 'index.csv')}`);

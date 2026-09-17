/**
 * Produit une petite bibliothèque de matériaux haute définition.
 *
 * Les images sont entièrement calculées ici : elles servent à vérifier que la
 * couche HD remplace bien les textures d'origine, pas à décorer un niveau.
 * Un vrai pack de matériaux se dépose au même endroit, avec le même index.
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(HERE, '../public/materials');
const SIZE = 512;

// ------------------------------------------------------------ encodage PNG

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** PNG couleur vraie avec canal alpha, sans entrelacement. */
function encodePng(rgba, width, height) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filtre nul : les images sont déjà compactes
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // 8 bits par canal
  header[9] = 6; // RVB + alpha
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ------------------------------------------------------------ bruit et relief

function valueNoise(width, height, cells, seed) {
  const grid = new Float32Array((cells + 1) * (cells + 1));
  let s = seed | 1;
  for (let i = 0; i < grid.length; i++) {
    s = (s * 1664525 + 1013904223) & 0x7fffffff;
    grid[i] = ((s >>> 8) % 4096) / 4096;
  }
  const out = new Float32Array(width * height);
  const at = (x, y) => grid[(y % (cells + 1)) * (cells + 1) + (x % (cells + 1))];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const fx = (x / width) * cells;
      const fy = (y / height) * cells;
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const tx = fx - x0;
      const ty = fy - y0;
      const sx = tx * tx * (3 - 2 * tx);
      const sy = ty * ty * (3 - 2 * ty);
      const top = at(x0, y0) * (1 - sx) + at(x0 + 1, y0) * sx;
      const bottom = at(x0, y0 + 1) * (1 - sx) + at(x0 + 1, y0 + 1) * sx;
      out[y * width + x] = top * (1 - sy) + bottom * sy;
    }
  }
  return out;
}

function fbm(width, height, seed) {
  const a = valueNoise(width, height, 4, seed);
  const b = valueNoise(width, height, 10, seed + 31);
  const c = valueNoise(width, height, 24, seed + 97);
  const d = valueNoise(width, height, 64, seed + 251);
  const out = new Float32Array(width * height);
  for (let i = 0; i < out.length; i++) {
    out[i] = a[i] * 0.48 + b[i] * 0.27 + c[i] * 0.16 + d[i] * 0.09;
  }
  return out;
}

/** Normale déduite d'un relief, par différences centrées. */
function heightToNormal(height, size, strength) {
  const rgba = Buffer.alloc(size * size * 4);
  const at = (x, y) => height[((y + size) % size) * size + ((x + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x - 1, y) - at(x + 1, y)) * strength;
      const dy = (at(x, y - 1) - at(x, y + 1)) * strength;
      const inv = 1 / Math.hypot(dx, dy, 1);
      const o = (y * size + x) * 4;
      rgba[o] = Math.round((dx * inv * 0.5 + 0.5) * 255);
      rgba[o + 1] = Math.round((dy * inv * 0.5 + 0.5) * 255);
      rgba[o + 2] = Math.round((inv * 0.5 + 0.5) * 255);
      rgba[o + 3] = 255;
    }
  }
  return rgba;
}

function grayscale(values, size, transform = (v) => v) {
  const rgba = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const v = Math.max(0, Math.min(255, Math.round(transform(values[i]) * 255)));
    rgba[i * 4] = v;
    rgba[i * 4 + 1] = v;
    rgba[i * 4 + 2] = v;
    rgba[i * 4 + 3] = 255;
  }
  return rgba;
}

function colorize(values, size, low, high, detail) {
  const rgba = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const t = Math.max(0, Math.min(1, values[i]));
    const shade = 0.85 + detail[i] * 0.3;
    const o = i * 4;
    for (let c = 0; c < 3; c++) {
      const value = (low[c] + (high[c] - low[c]) * t) * shade;
      rgba[o + c] = Math.max(0, Math.min(255, Math.round(value)));
    }
    rgba[o + 3] = 255;
  }
  return rgba;
}

// ------------------------------------------------------------ matériaux

/** Pierre appareillée : blocs, joints creusés, usure. */
function stone(size) {
  const grain = fbm(size, size, 4242);
  const wear = fbm(size, size, 909);
  const height = new Float32Array(size * size);
  const tone = new Float32Array(size * size);
  const rough = new Float32Array(size * size);
  const occlusion = new Float32Array(size * size);

  const blockH = size / 4;
  const blockW = size / 2;
  const joint = Math.max(3, size / 64);

  for (let y = 0; y < size; y++) {
    const row = Math.floor(y / blockH);
    for (let x = 0; x < size; x++) {
      const localY = y % blockH;
      const localX = (x + (row % 2) * (blockW / 2)) % blockW;
      const inJoint = localY < joint || localX < joint;
      const edge = Math.min(localY, localX, blockH - localY, blockW - localX);

      const i = y * size + x;
      height[i] = inJoint ? 0.15 : 0.62 + grain[i] * 0.3;
      tone[i] = inJoint ? 0.16 : 0.45 + grain[i] * 0.4 + wear[i] * 0.15;
      rough[i] = inJoint ? 0.97 : 0.76 + grain[i] * 0.2;
      // Le creux du joint et le pourtour des blocs reçoivent moins de lumière.
      occlusion[i] = inJoint ? 0.42 : Math.min(1, 0.62 + edge / joint * 0.38);
    }
  }
  return { height, tone, rough, occlusion, grain };
}

/** Plaques métalliques boulonnées, légèrement corrodées. */
function metal(size) {
  const grain = fbm(size, size, 777);
  const rust = fbm(size, size, 1313);
  const height = new Float32Array(size * size);
  const tone = new Float32Array(size * size);
  const rough = new Float32Array(size * size);
  const occlusion = new Float32Array(size * size);

  const panel = size / 2;
  const seam = Math.max(2, size / 128);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const lx = x % panel;
      const ly = y % panel;
      const inSeam = lx < seam || ly < seam;

      const bx = Math.min(lx, panel - lx);
      const by = Math.min(ly, panel - ly);
      const boltDistance = Math.hypot(bx - size / 32, by - size / 32);
      const bolt = boltDistance < size / 90;

      const i = y * size + x;
      const corrosion = Math.max(0, rust[i] - 0.55) * 2;
      height[i] = bolt ? 0.9 : inSeam ? 0.2 : 0.6 + grain[i] * 0.12;
      tone[i] = bolt ? 0.72 : inSeam ? 0.22 : 0.5 + grain[i] * 0.2 + corrosion * 0.25;
      // La corrosion mange le poli : elle est le principal écart de rugosité.
      rough[i] = Math.min(1, (bolt ? 0.42 : inSeam ? 0.8 : 0.34) + corrosion * 0.5);
      occlusion[i] = inSeam ? 0.45 : bolt ? 0.8 : 1;
    }
  }
  return { height, tone, rough, occlusion, grain };
}

const MATERIALS = [
  {
    id: 'test_stone',
    build: stone,
    low: [42, 40, 38],
    high: [178, 172, 160],
    normalStrength: 7,
    surface: 'stone',
    metalness: 0,
  },
  {
    id: 'test_metal',
    build: metal,
    low: [34, 36, 42],
    high: [150, 158, 172],
    normalStrength: 9,
    surface: 'metal',
    metalness: 0.85,
  },
];

const definitions = [];
for (const material of MATERIALS) {
  const dir = resolve(OUT_DIR, material.id);
  mkdirSync(dir, { recursive: true });

  const data = material.build(SIZE);
  const write = (name, rgba) => {
    writeFileSync(resolve(dir, name), encodePng(rgba, SIZE, SIZE));
  };

  write('basecolor.png', colorize(data.tone, SIZE, material.low, material.high, data.grain));
  write('normal.png', heightToNormal(data.height, SIZE, material.normalStrength));
  write('roughness.png', grayscale(data.rough, SIZE));
  write('ao.png', grayscale(data.occlusion, SIZE));

  definitions.push({
    id: material.id,
    baseColor: `${material.id}/basecolor.png`,
    normal: `${material.id}/normal.png`,
    roughness: `${material.id}/roughness.png`,
    ao: `${material.id}/ao.png`,
    metalnessValue: material.metalness,
    normalScale: 0.8,
    textureScale: 1,
    surface: material.surface,
  });
  console.log(`matériau écrit : ${material.id}`);
}

const index = {
  basePath: 'materials/',
  materials: definitions,
  // Textures d'origine converties. Tout ce qui n'est pas cité garde la sienne.
  assign: {
    test_wall: 'test_stone',
    test_floor: 'test_metal',
  },
};

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(resolve(OUT_DIR, 'index.json'), `${JSON.stringify(index, null, 2)}\n`);
console.log(`index écrit : ${resolve(OUT_DIR, 'index.json')}`);

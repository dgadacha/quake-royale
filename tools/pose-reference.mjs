#!/usr/bin/env node
/**
 * Dessine un mannequin de pose à partir des proportions d'un modèle du jeu.
 *
 * Le report d'animation exige que le maillage détaillé soit dans la même pose
 * que le modèle d'origine. Cette image sert de référence pour produire un
 * personnage dans cette pose : elle ne reprend que des mesures — hauteur des
 * épaules, écartement des bras, hauteur et longueur de l'arme — et les rend
 * sous forme de volumes simples. Le dessin du personnage reste à inventer.
 *
 *   node tools/pose-reference.mjs [modele] [sortie.png]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const MODEL = process.argv[2] ?? 'progs/soldier.mdl';
const OUT = process.argv[3] ?? 'reference/pose-reference.png';

// ------------------------------------------------------------------ PNG

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

// ------------------------------------------------- mesures du modèle

function readModel(path) {
  const pak = readFileSync('public/data/pak0.pak');
  const dv = new DataView(pak.buffer, pak.byteOffset, pak.byteLength);
  const off = dv.getInt32(4, true);
  const len = dv.getInt32(8, true);
  for (let i = 0; i < len / 64; i++) {
    const o = off + i * 64;
    let name = '';
    for (let j = 0; j < 56; j++) {
      const c = pak[o + j];
      if (!c) break;
      name += String.fromCharCode(c);
    }
    if (name.toLowerCase() === path) {
      const start = dv.getInt32(o + 56, true);
      return pak.subarray(start, start + dv.getInt32(o + 60, true));
    }
  }
  return null;
}

/** Hauteur du modèle et hauteur à laquelle l'arme est tenue. */
function measure(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  // En-tête MDL v6 : l'échelle et l'origine précèdent les images.
  const scale = [dv.getFloat32(8, true), dv.getFloat32(12, true), dv.getFloat32(16, true)];
  const origin = [dv.getFloat32(20, true), dv.getFloat32(24, true), dv.getFloat32(28, true)];
  const skinCount = dv.getInt32(48, true);
  const skinW = dv.getInt32(52, true);
  const skinH = dv.getInt32(56, true);
  const vertexCount = dv.getInt32(60, true);
  const triangleCount = dv.getInt32(64, true);

  let o = 84;
  for (let i = 0; i < skinCount; i++) {
    const group = dv.getInt32(o, true);
    o += 4;
    if (group === 0) o += skinW * skinH;
    else {
      const n = dv.getInt32(o, true);
      o += 4 + n * 4 + n * skinW * skinH;
    }
  }
  o += vertexCount * 12 + triangleCount * 16;
  o += 4; // type de la première image
  o += 8; // bornes comprimées
  o += 16; // nom

  const y = [];
  for (let v = 0; v < vertexCount; v++) {
    // Repère du rendu : la hauteur du jeu est le troisième octet.
    y.push(buf[o + v * 4 + 2] * scale[2] + origin[2]);
  }
  const min = Math.min(...y);
  const max = Math.max(...y);
  return { height: max - min };
}

// --------------------------------------------------------------- dessin

const W = 1280;
const H = 720;
const SS = 3; // suréchantillonnage
const PIX = W * SS * H * SS;
const id = new Int32Array(PIX).fill(-1);
const depth = new Float32Array(PIX).fill(-Infinity);

/**
 * Volume en forme de segment épais. On garde par pixel le volume le plus
 * proche de la caméra : sans cela, un bras tendu vers l'avant se confond avec
 * le torse, et l'image ne dit plus rien de la pose.
 */
function capsule(project, a, b, radius, index) {
  const p0 = project(a);
  const p1 = project(b);
  const dx = p1[0] - p0[0];
  const dy = p1[1] - p0[1];
  const len2 = dx * dx + dy * dy;
  const x0 = Math.max(0, Math.floor(Math.min(p0[0], p1[0]) - radius - 2));
  const x1 = Math.min(W * SS - 1, Math.ceil(Math.max(p0[0], p1[0]) + radius + 2));
  const y0 = Math.max(0, Math.floor(Math.min(p0[1], p1[1]) - radius - 2));
  const y1 = Math.min(H * SS - 1, Math.ceil(Math.max(p0[1], p1[1]) + radius + 2));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      let t = len2 > 0 ? ((x - p0[0]) * dx + (y - p0[1]) * dy) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      const qx = p0[0] + dx * t;
      const qy = p0[1] + dy * t;
      const d = Math.hypot(x - qx, y - qy);
      if (d > radius) continue;
      // Le renflement du volume rapproche le milieu de la caméra.
      const bulge = Math.sqrt(Math.max(0, 1 - (d / radius) ** 2)) * radius;
      const z = p0[2] + (p1[2] - p0[2]) * t + bulge;
      const o = y * W * SS + x;
      if (z > depth[o]) {
        depth[o] = z;
        id[o] = index;
      }
    }
  }
}

/**
 * Mannequin, en fraction de la hauteur totale. L'origine est aux pieds,
 * X vers l'avant, Y vers le haut, Z sur le côté.
 */
const figure = (unit) => {
  const P = (x, y, z) => [x, y, z];
  const hanche = 0.47;
  const epaule = 0.78;
  const demiEpaule = 0.2;
  const mainY = 0.58;

  const limbs = [
    [P(0, 0.02, -0.08), P(0, 0.26, -0.075), 0.045],
    [P(0, 0.26, -0.075), P(0, hanche, -0.07), 0.05],
    [P(0, 0.02, 0.08), P(0, 0.26, 0.075), 0.045],
    [P(0, 0.26, 0.075), P(0, hanche, 0.07), 0.05],
    [P(0, hanche, 0), P(0, epaule, 0), 0.1],
    [P(0, 0.79, 0), P(0, 0.83, 0), 0.042],
    [P(0.01, 0.85, 0), P(0.02, 0.93, 0), 0.06],
    [P(0, epaule, -demiEpaule), P(0.16, 0.66, -0.18), 0.043],
    [P(0.16, 0.66, -0.18), P(0.27, mainY, -0.07), 0.038],
    [P(0, epaule, demiEpaule), P(0.16, 0.66, 0.18), 0.043],
    [P(0.16, 0.66, 0.18), P(0.27, mainY, 0.07), 0.038],
    // Axe mesuré sur le modèle : presque horizontale, à cinquante-huit degrés
    // de l'axe du regard, longue de près de six dixièmes de la hauteur.
    [P(0.43, 0.573, -0.25), P(0.13, 0.597, 0.25), 0.032],
  ];
  return limbs.map(([a, b, r]) => [a, b, r * unit]);
};

const views = [
  { angle: 0, cx: W * 0.16 },
  { angle: 45, cx: W * 0.48 },
  { angle: 90, cx: W * 0.78 },
];

const unit = H * 0.72;
let index = 0;
for (const view of views) {
  const r = (view.angle * Math.PI) / 180;
  const cs = Math.cos(r);
  const sn = Math.sin(r);
  const project = ([x, y, z]) => {
    const h = z * cs + x * sn;
    const d = x * cs - z * sn;
    return [(view.cx + h * unit) * SS, (H * 0.93 - y * unit) * SS, d * unit * SS];
  };
  for (const [a, b, radius] of figure(unit)) capsule(project, a, b, radius * SS, index++);
}

// Une teinte par profondeur, et un trait là où deux volumes se recouvrent :
// c'est ce qui rend l'espace entre les bras et le torse visible.
let near = -Infinity;
let far = Infinity;
for (let i = 0; i < PIX; i++) {
  if (id[i] < 0) continue;
  if (depth[i] > near) near = depth[i];
  if (depth[i] < far) far = depth[i];
}
const shade = new Float32Array(PIX);
for (let i = 0; i < PIX; i++) {
  if (id[i] < 0) { shade[i] = 1; continue; }
  const t = near > far ? (depth[i] - far) / (near - far) : 0.5;
  shade[i] = 0.34 + 0.34 * t;
}
const w = W * SS;
for (let y = 1; y < H * SS - 1; y++) {
  for (let x = 1; x < w - 1; x++) {
    const o = y * w + x;
    const me = id[o];
    if (me < 0) continue;
    if (id[o - 1] !== me || id[o + 1] !== me || id[o - w] !== me || id[o + w] !== me) shade[o] = 0.1;
  }
}

const rgba = new Uint8Array(W * H * 4);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    let sum = 0;
    for (let j = 0; j < SS; j++) {
      for (let i = 0; i < SS; i++) sum += shade[(y * SS + j) * w + (x * SS + i)];
    }
    const v = Math.round(255 * (sum / (SS * SS)));
    const o = (y * W + x) * 4;
    rgba[o] = v;
    rgba[o + 1] = v;
    rgba[o + 2] = v;
    rgba[o + 3] = 255;
  }
}

const data = readModel(MODEL);
if (data) {
  const m = measure(data);
  console.log(`${MODEL} : hauteur ${m.height.toFixed(1)} unités`);
}
writeFileSync(OUT, encodePng(rgba, W, H));
console.log(`référence de pose écrite dans ${OUT}`);

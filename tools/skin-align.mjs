#!/usr/bin/env node
/**
 * Mesure le recalage d'une peau refaite par rapport à celle du modèle.
 *
 * Une peau du jeu range l'avant à gauche et l'arrière à droite, le moteur
 * passant de l'une à l'autre en ajoutant exactement une demi-largeur. Une peau
 * refaite ailleurs place rarement le raccord au pixel près, et le dos glisse
 * alors tout entier. Juger à l'œil ne suffit pas : de loin, un décalage passe
 * pour une texture mal lue, et inversement.
 *
 * L'outil compare les deux images par leurs contours — ce qui les rend
 * comparables malgré des couleurs différentes — et cherche le décalage qui les
 * fait coïncider, moitié par moitié.
 *
 *   node tools/skin-align.mjs <gabarit.png> <peau-refaite.png>
 */
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

const [templatePath, skinPath] = process.argv.slice(2);
if (!templatePath || !skinPath) {
  console.error('usage : node tools/skin-align.mjs <gabarit.png> <peau-refaite.png>');
  process.exit(1);
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
  const lum = new Float32Array(w * h);
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
      lum[y * w + x] =
        channels >= 3 ? (0.2126 * cur[s] + 0.7152 * cur[s + 1] + 0.0722 * cur[s + 2]) / 255 : cur[s] / 255;
    }
  }
  return { w, h, lum };
}

/** Rééchantillonne au plus proche : la comparaison n'a pas besoin de mieux. */
function resample(img, w, h) {
  const lum = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(img.h - 1, Math.floor((y * img.h) / h));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(img.w - 1, Math.floor((x * img.w) / w));
      lum[y * w + x] = img.lum[sy * img.w + sx];
    }
  }
  return { w, h, lum };
}

/** Contours : comparables même quand les couleurs n'ont rien à voir. */
function edges(img) {
  const { w, h, lum } = img;
  const g = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const dx = lum[y * w + x + 1] - lum[y * w + x - 1];
      const dy = lum[(y + 1) * w + x] - lum[(y - 1) * w + x];
      g[y * w + x] = Math.hypot(dx, dy);
    }
  }
  return g;
}

const template = decodePng(templatePath);
const raw = decodePng(skinPath);
const skin = resample(raw, template.w, template.h);
const a = edges(template);
const b = edges(skin);
const W = template.w;
const H = template.h;

function search(x0, x1) {
  let best = { dx: 0, dy: 0, score: -2 };
  let atZero = -2;
  const range = Math.max(4, Math.round(W * 0.06));
  for (let dy = -range; dy <= range; dy++) {
    for (let dx = -range; dx <= range; dx++) {
      let sa = 0;
      let sb = 0;
      let n = 0;
      for (let y = 4; y < H - 4; y++) {
        for (let x = x0 + 4; x < x1 - 4; x++) {
          const yy = y + dy;
          const xx = x + dx;
          if (yy < 0 || yy >= H || xx < 0 || xx >= W) continue;
          sa += a[y * W + x];
          sb += b[yy * W + xx];
          n++;
        }
      }
      if (n === 0) continue;
      const ma = sa / n;
      const mb = sb / n;
      let num = 0;
      let da = 0;
      let db = 0;
      for (let y = 4; y < H - 4; y++) {
        for (let x = x0 + 4; x < x1 - 4; x++) {
          const yy = y + dy;
          const xx = x + dx;
          if (yy < 0 || yy >= H || xx < 0 || xx >= W) continue;
          const u = a[y * W + x] - ma;
          const v = b[yy * W + xx] - mb;
          num += u * v;
          da += u * u;
          db += v * v;
        }
      }
      const score = num / Math.sqrt(da * db);
      if (dx === 0 && dy === 0) atZero = score;
      if (score > best.score) best = { dx, dy, score };
    }
  }
  return { ...best, atZero };
}

console.log(`gabarit ${template.w}x${template.h}, peau ${raw.w}x${raw.h}`);
console.log('\nmoitié    décalage      coïncidence   sans recalage');
const halves = [
  ['avant', 0, Math.floor(W / 2)],
  ['arrière', Math.floor(W / 2), W],
];
const found = {};
for (const [name, x0, x1] of halves) {
  const r = search(x0, x1);
  found[name] = r;
  console.log(
    `${name.padEnd(9)} dx ${String(r.dx).padStart(3)} dy ${String(r.dy).padStart(3)}   ${r.score.toFixed(3)}         ${r.atZero.toFixed(3)}`,
  );
}

const back = found['arrière'];
// Le contenu de la peau refaite se trouve `dx` pixels plus loin que dans le
// gabarit : il faut donc y puiser d'autant, et le recalage garde ce signe.
const shift = back.dx / W;
console.log(`\nbackShift à inscrire dans detailedEnemySkins : ${shift.toFixed(4)}`);
if (Math.abs(back.dx) <= 1) {
  console.log("La peau tombe juste : aucun recalage n'est nécessaire.");
} else {
  console.log(
    `Soit ${Math.round((Math.abs(back.dx) * raw.w) / W)} pixels sur une largeur de ${raw.w}, ` +
      `à rattraper dans l'image si l'on préfère la corriger à la source.`,
  );
}

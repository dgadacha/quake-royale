import { Palette } from '../formats/palette';
import type { BspMipTexture } from '../formats/bsp';

/** Bruit de valeur déterministe, utilisé par tous les motifs. */
function valueNoise(width: number, height: number, cells: number, seed: number): Float32Array {
  const grid = new Float32Array((cells + 1) * (cells + 1));
  let s = seed | 1;
  for (let i = 0; i < grid.length; i++) {
    s = (s * 1664525 + 1013904223) & 0x7fffffff;
    grid[i] = ((s >>> 8) % 4096) / 4096;
  }
  const out = new Float32Array(width * height);
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
      const at = (ix: number, iy: number) => grid[(iy % (cells + 1)) * (cells + 1) + (ix % (cells + 1))];
      const top = at(x0, y0) * (1 - sx) + at(x0 + 1, y0) * sx;
      const bottom = at(x0, y0 + 1) * (1 - sx) + at(x0 + 1, y0 + 1) * sx;
      out[y * width + x] = top * (1 - sy) + bottom * sy;
    }
  }
  return out;
}

function fbm(width: number, height: number, seed: number): Float32Array {
  const a = valueNoise(width, height, 4, seed);
  const b = valueNoise(width, height, 8, seed + 17);
  const c = valueNoise(width, height, 16, seed + 91);
  const d = valueNoise(width, height, 32, seed + 333);
  const out = new Float32Array(width * height);
  for (let i = 0; i < out.length; i++) {
    out[i] = a[i] * 0.5 + b[i] * 0.26 + c[i] * 0.16 + d[i] * 0.08;
  }
  return out;
}

/**
 * Palette de la démonstration : quatre rampes de matière
 * plus une plage de teintes non affectées par l'éclairage.
 */
export function demoPalette(): Palette {
  const rgb = new Uint8Array(768);
  const ramp = (start: number, from: [number, number, number], to: [number, number, number]) => {
    for (let i = 0; i < 32; i++) {
      const t = i / 31;
      const o = (start + i) * 3;
      rgb[o] = from[0] + (to[0] - from[0]) * t;
      rgb[o + 1] = from[1] + (to[1] - from[1]) * t;
      rgb[o + 2] = from[2] + (to[2] - from[2]) * t;
    }
  };

  ramp(0, [14, 14, 16], [176, 172, 165]); // pierre
  ramp(32, [20, 14, 10], [162, 108, 62]); // métal rouillé
  ramp(64, [12, 16, 20], [140, 158, 176]); // acier
  ramp(96, [8, 14, 10], [96, 132, 92]); // mousse
  ramp(128, [18, 15, 12], [150, 128, 96]); // grès
  ramp(160, [6, 10, 16], [70, 110, 160]); // eau
  ramp(192, [10, 8, 14], [120, 96, 150]); // pourpre

  for (let i = 224; i < 256; i++) {
    const t = (i - 224) / 31;
    const o = i * 3;
    rgb[o] = 255;
    rgb[o + 1] = 120 + 130 * t;
    rgb[o + 2] = 40 + 170 * t * t;
  }
  return new Palette(rgb);
}

type Generator = (width: number, height: number) => Uint8Array;

/** Blocs de pierre appareillés, joints creusés. */
const stone: Generator = (w, h) => {
  const out = new Uint8Array(w * h);
  const noise = fbm(w, h, 1234);
  const grain = fbm(w, h, 777);
  const blockH = h / 4;
  const blockW = w / 2;
  for (let y = 0; y < h; y++) {
    const row = Math.floor(y / blockH);
    const offset = (row % 2) * (blockW / 2);
    for (let x = 0; x < w; x++) {
      const localY = y % blockH;
      const localX = (x + offset) % blockW;
      const joint = localY < 2 || localX < 2;
      let value = 0.35 + noise[y * w + x] * 0.45 + grain[y * w + x] * 0.2;
      if (joint) value *= 0.35;
      // Léger éclaircissement en haut de chaque bloc.
      if (!joint && localY < blockH * 0.18) value *= 1.12;
      out[y * w + x] = Math.max(0, Math.min(31, Math.round(value * 31)));
    }
  }
  return out;
};

/** Dalles larges avec usure centrale. */
const floorSlabs: Generator = (w, h) => {
  const out = new Uint8Array(w * h);
  const noise = fbm(w, h, 55);
  const wear = fbm(w, h, 909);
  const cell = w / 2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const lx = x % cell;
      const ly = y % cell;
      const joint = lx < 3 || ly < 3;
      let value = 0.3 + noise[y * w + x] * 0.35 + wear[y * w + x] * 0.25;
      if (joint) value *= 0.4;
      out[y * w + x] = 128 + Math.max(0, Math.min(31, Math.round(value * 31)));
    }
  }
  return out;
};

/** Plaques d'acier boulonnées. */
const platedMetal: Generator = (w, h) => {
  const out = new Uint8Array(w * h);
  const noise = fbm(w, h, 4242);
  const panel = w / 2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const lx = x % panel;
      const ly = y % panel;
      let value = 0.45 + noise[y * w + x] * 0.35;
      if (lx < 2 || ly < 2) value *= 0.45;

      // Boulons aux quatre coins de chaque plaque.
      const bx = Math.min(lx, panel - lx);
      const by = Math.min(ly, panel - ly);
      const d = Math.hypot(bx - 8, by - 8);
      if (d < 3.5) value = 0.85 - d * 0.06;

      out[y * w + x] = 64 + Math.max(0, Math.min(31, Math.round(value * 31)));
    }
  }
  return out;
};

/** Panneau lumineux : cadre métallique et surface non ombrée. */
const lampPanel: Generator = (w, h) => {
  const out = new Uint8Array(w * h);
  const noise = fbm(w, h, 616);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const edge = Math.min(x, y, w - 1 - x, h - 1 - y);
      if (edge < w * 0.14) {
        out[y * w + x] = 64 + Math.round((0.35 + noise[y * w + x] * 0.3) * 31);
      } else {
        const glow = 1 - Math.hypot(x / w - 0.5, y / h - 0.5) * 1.3;
        out[y * w + x] = 224 + Math.max(0, Math.min(31, Math.round(glow * 31)));
      }
    }
  }
  return out;
};

/** Bandeau de renfort, pour marquer les arêtes. */
const trim: Generator = (w, h) => {
  const out = new Uint8Array(w * h);
  const noise = fbm(w, h, 313);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const band = Math.floor((y / h) * 4) % 2;
      let value = 0.4 + noise[y * w + x] * 0.35;
      if (band === 0) value *= 1.25;
      const rivet = (x % 16 === 8 && y % 16 === 8) ? 0.9 : 0;
      out[y * w + x] = 32 + Math.max(0, Math.min(31, Math.round((rivet || value) * 31)));
    }
  }
  return out;
};

/** Surface d'eau : rides lentes. */
const waterSurface: Generator = (w, h) => {
  const out = new Uint8Array(w * h);
  const noise = fbm(w, h, 2024);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // Rides larges et peu contrastées : une eau trop marquée donne
      // l'impression de bouillir une fois la déformation du shader ajoutée.
      const ripple =
        0.62 + 0.1 * Math.sin((x / w) * Math.PI * 4 + noise[y * w + x] * 3) +
        0.1 * Math.sin((y / h) * Math.PI * 3);
      out[y * w + x] = 160 + Math.max(0, Math.min(31, Math.round(ripple * 31)));
    }
  }
  return out;
};

const GENERATORS: Record<string, { size: number; generator: Generator }> = {
  wall: { size: 128, generator: stone },
  floor: { size: 128, generator: floorSlabs },
  metal: { size: 128, generator: platedMetal },
  lamp: { size: 64, generator: lampPanel },
  trim: { size: 64, generator: trim },
  water: { size: 128, generator: waterSurface },
};

export function demoTexture(name: string): BspMipTexture {
  const entry = GENERATORS[name] ?? GENERATORS.wall;
  const size = entry.size;
  return { name, width: size, height: size, pixels: entry.generator(size, size) };
}

export const DEMO_TEXTURE_NAMES = Object.keys(GENERATORS);

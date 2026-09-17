import * as THREE from 'three';
import { Palette } from '../formats/palette';
import type { BspMipTexture } from '../formats/bsp';

export interface TextureSet {
  /** Couleur de base, agrandie et filtrée. */
  map: THREE.Texture;
  /** RGB = normale tangente, A = rugosité. */
  surfaceMap: THREE.Texture;
  /** Pixels fullbright isolés, null si la texture n'en contient aucun. */
  emissiveMap: THREE.Texture | null;
  width: number;
  height: number;
}

/**
 * Agrandissement x2 par détection de contours sur les indices de palette.
 * Les diagonales deviennent nettes au lieu de rester en marches d'escalier,
 * ce qui est le principal défaut visuel des textures d'origine une fois
 * affichées en haute résolution.
 */
function upscaleIndices(src: Uint8Array, width: number, height: number): {
  data: Uint8Array<ArrayBuffer>;
  width: number;
  height: number;
} {
  const dw = width * 2;
  const dh = height * 2;
  const out = new Uint8Array(dw * dh);
  const at = (x: number, y: number) => src[((y + height) % height) * width + ((x + width) % width)];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = at(x, y);
      const a = at(x, y - 1);
      const b = at(x + 1, y);
      const c = at(x - 1, y);
      const d = at(x, y + 1);

      let e0 = p;
      let e1 = p;
      let e2 = p;
      let e3 = p;
      if (c !== b && a !== d) {
        if (a === c) e0 = a;
        if (a === b) e1 = b;
        if (d === c) e2 = c;
        if (d === b) e3 = d;
      }

      const o = y * 2 * dw + x * 2;
      out[o] = e0;
      out[o + 1] = e1;
      out[o + dw] = e2;
      out[o + dw + 1] = e3;
    }
  }
  return { data: out, width: dw, height: dh };
}

/** Encode une composante de normale [-1,1] en octet. */
function encode(v: number): number {
  return Math.max(0, Math.min(255, Math.round((v * 0.5 + 0.5) * 255)));
}

function luminance(rgba: Uint8Array, width: number, height: number): Float32Array {
  const lum = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    lum[i] =
      (0.2126 * rgba[i * 4] + 0.7152 * rgba[i * 4 + 1] + 0.0722 * rgba[i * 4 + 2]) / 255;
  }
  return lum;
}

/**
 * Normale dérivée du relief apparent de la texture (Sobel sur la luminance)
 * et rugosité déduite du contraste local : les surfaces claires et lisses
 * réfléchissent plus que les zones sales et bruitées.
 */
function buildSurfaceMap(
  rgba: Uint8Array,
  width: number,
  height: number,
  strength: number,
): Uint8Array<ArrayBuffer> {
  const lum = luminance(rgba, width, height);
  const out = new Uint8Array(width * height * 4);
  const at = (x: number, y: number) => lum[((y + height) % height) * width + ((x + width) % width)];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const tl = at(x - 1, y - 1);
      const t = at(x, y - 1);
      const tr = at(x + 1, y - 1);
      const l = at(x - 1, y);
      const r = at(x + 1, y);
      const bl = at(x - 1, y + 1);
      const b = at(x, y + 1);
      const br = at(x + 1, y + 1);

      const dx = tl + 2 * l + bl - (tr + 2 * r + br);
      const dy = tl + 2 * t + tr - (bl + 2 * b + br);

      const nx = dx * strength;
      const ny = dy * strength;
      const nz = 1;
      const inv = 1 / Math.hypot(nx, ny, nz);

      // Contraste local : plus il est fort, plus la surface est traitée comme mate.
      const center = at(x, y);
      const contrast = Math.min(1, Math.abs(dx) + Math.abs(dy));
      const roughness = Math.min(1, 0.55 + contrast * 0.35 - center * 0.15);

      const o = (y * width + x) * 4;
      out[o] = encode(nx * inv);
      out[o + 1] = encode(ny * inv);
      out[o + 2] = encode(nz * inv);
      out[o + 3] = Math.round(roughness * 255);
    }
  }
  return out;
}

function makeTexture(
  data: Uint8Array<ArrayBuffer>,
  width: number,
  height: number,
  colorSpace: THREE.ColorSpace,
  anisotropy: number,
): THREE.DataTexture {
  const texture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = anisotropy;
  texture.colorSpace = colorSpace;
  texture.needsUpdate = true;
  return texture;
}

export interface TextureOptions {
  anisotropy: number;
  /** Nombre de doublements de résolution appliqués aux petites textures. */
  maxUpscale?: number;
  normalStrength?: number;
}

export function buildTextureSet(
  mip: BspMipTexture,
  palette: Palette,
  options: TextureOptions,
): TextureSet {
  const maxUpscale = options.maxUpscale ?? 2;
  const normalStrength = options.normalStrength ?? 2.2;

  let indices =
    mip.pixels && mip.pixels.length >= mip.width * mip.height
      ? mip.pixels
      : checkerboard(mip.width, mip.height);
  let width = mip.width;
  let height = mip.height;

  // Les petites textures profitent le plus de l'agrandissement,
  // on plafonne la taille finale pour garder la mémoire raisonnable.
  for (let pass = 0; pass < maxUpscale; pass++) {
    if (width >= 256 || height >= 256) break;
    const up = upscaleIndices(indices, width, height);
    indices = up.data;
    width = up.width;
    height = up.height;
  }

  const transparent = mip.name.startsWith('{') ? 255 : -1;
  const rgba = palette.expand(indices, width, height, transparent);
  const map = makeTexture(rgba, width, height, THREE.SRGBColorSpace, options.anisotropy);

  const surface = buildSurfaceMap(rgba, width, height, normalStrength);
  const surfaceMap = makeTexture(surface, width, height, THREE.NoColorSpace, options.anisotropy);

  const emissiveData = palette.emissiveMask(indices, width, height);
  const emissiveMap = emissiveData.length
    ? makeTexture(emissiveData, width, height, THREE.SRGBColorSpace, 1)
    : null;

  return { map, surfaceMap, emissiveMap, width, height };
}

/** Damier de secours pour une texture absente des données montées. */
function checkerboard(width: number, height: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      out[y * width + x] = ((x >> 3) + (y >> 3)) % 2 ? 60 : 20;
    }
  }
  return out;
}

/**
 * Bruit de détail appliqué de près par le shader du monde : il casse
 * l'aspect plat des surfaces agrandies sans coûter de mémoire texture.
 */
export function buildDetailTexture(size = 256): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  const noise = new Float32Array(size * size);
  let seed = 0x9e3779b9;
  const rand = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return ((seed >>> 0) % 100000) / 100000;
  };
  for (let i = 0; i < noise.length; i++) noise[i] = rand();

  const sample = (x: number, y: number) => noise[((y + size) % size) * size + ((x + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Deux octaves suffisent : on cherche un grain, pas une structure.
      const fine = sample(x, y);
      const coarse =
        (sample(x >> 2 << 2, y >> 2 << 2) + sample((x >> 2 << 2) + 4, (y >> 2 << 2) + 4)) * 0.5;
      const v = fine * 0.6 + coarse * 0.4;
      const dx = sample(x + 1, y) - sample(x - 1, y);
      const dy = sample(x, y + 1) - sample(x, y - 1);
      const o = (y * size + x) * 4;
      data[o] = encode(dx);
      data[o + 1] = encode(dy);
      data[o + 2] = Math.round(v * 255);
      data[o + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

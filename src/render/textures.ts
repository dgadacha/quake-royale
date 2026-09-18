import * as THREE from 'three';
import { Palette } from '../formats/palette';
import type { BspMipTexture } from '../formats/bsp';
import { profileFor, type MaterialProfile } from './surfaceProfiles';

export interface TextureSet {
  /** Couleur de base, agrandie et filtrée. */
  map: THREE.Texture;
  /** RGB = normale tangente, A = rugosité. */
  surfaceMap: THREE.Texture;
  /** Pixels fullbright isolés, null si la texture n'en contient aucun. */
  emissiveMap: THREE.Texture | null;
  width: number;
  height: number;
  /** Famille de matériau déduite du nom, et ses propriétés. */
  profile: MaterialProfile;
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
 * Champ de flaques : un bruit doux et cyclique, pour que l'humidité se pose
 * par plaques et se répète sans couture d'une dalle à l'autre.
 */
function puddleField(width: number, height: number): Float32Array {
  const cells = 4;
  const seeds = new Float32Array(cells * cells);
  let state = 0x9e3779b9;
  for (let i = 0; i < seeds.length; i++) {
    state = (state * 1664525 + 1013904223) >>> 0;
    seeds[i] = state / 0xffffffff;
  }
  const seed = (cx: number, cy: number) =>
    seeds[((cy + cells) % cells) * cells + ((cx + cells) % cells)];
  const smooth = (t: number) => t * t * (3 - 2 * t);

  const field = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const fy = (y / height) * cells;
    const cy = Math.floor(fy);
    const ty = smooth(fy - cy);
    for (let x = 0; x < width; x++) {
      const fx = (x / width) * cells;
      const cx = Math.floor(fx);
      const tx = smooth(fx - cx);
      const top = seed(cx, cy) * (1 - tx) + seed(cx + 1, cy) * tx;
      const bottom = seed(cx, cy + 1) * (1 - tx) + seed(cx + 1, cy + 1) * tx;
      const value = top * (1 - ty) + bottom * ty;
      // Seul le haut du bruit devient flaque : le reste du sol reste sec.
      field[y * width + x] = Math.max(0, value - 0.58) / 0.42;
    }
  }
  return field;
}

/**
 * Relief et rugosité déduits de la texture.
 *
 * Le relief vient de la pente de la luminance, la rugosité du détail local :
 * un joint creusé, une salissure ou une rayure diffusent, une surface lisse et
 * claire réfléchit. Les deux restent bornés par la famille du matériau, sans
 * quoi toutes les surfaces finissent avec le même aspect verni.
 */
function buildSurfaceMap(
  rgba: Uint8Array,
  width: number,
  height: number,
  strength: number,
  profile: MaterialProfile,
): Uint8Array<ArrayBuffer> {
  const lum = luminance(rgba, width, height);
  const puddles = profile.wetness > 0 ? puddleField(width, height) : null;
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

      // Le noyau de Sobel cumule quatre fois la pente : sans le ramener à
      // l'échelle, le relief part en bas-relief et la rugosité sature au
      // premier détail venu, ce qui rend toutes les surfaces identiques.
      const dx = (tl + 2 * l + bl - (tr + 2 * r + br)) / 4;
      const dy = (tl + 2 * t + tr - (bl + 2 * b + br)) / 4;

      const nx = dx * strength * profile.normalScale;
      const ny = dy * strength * profile.normalScale;
      const nz = 1;
      const inv = 1 / Math.hypot(nx, ny, nz);

      // Le détail local module la rugosité à l'intérieur de la plage du
      // matériau : les creux et les salissures vers le mat, les surfaces
      // lisses et claires vers le poli.
      const center = at(x, y);
      // Le contraste local repère les joints, les rayures et les salissures ;
      // la luminance sépare les zones usées des surfaces propres. C'est de là
      // que vient la rugosité, et non d'une valeur unique par matériau.
      const contrast = Math.min(1, (Math.abs(dx) + Math.abs(dy)) * 4.5);
      const variation = Math.max(0, Math.min(1, contrast * 0.62 + (1 - center) * 0.38));
      let roughness =
        profile.roughnessMin + (profile.roughnessMax - profile.roughnessMin) * variation;

      // L'eau stagne par plaques dans les creux, jamais sur toute la dalle :
      // c'est ce qui distingue un sol humide d'un sol verni.
      if (puddles) {
        const wet = puddles[y * width + x] * profile.wetness * (0.45 + (1 - center) * 0.55);
        roughness = roughness * (1 - wet) + 0.18 * wet;
      }

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
  /** Famille imposée ; sinon déduite du nom de la texture. */
  profile?: MaterialProfile;
}

export function buildTextureSet(
  mip: BspMipTexture,
  palette: Palette,
  options: TextureOptions,
): TextureSet {
  const maxUpscale = options.maxUpscale ?? 2;
  // Amplitude de base, tempérée ensuite par la famille du matériau.
  const normalStrength = options.normalStrength ?? 3.0;
  const profile = options.profile ?? profileFor(mip.name);

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

  const surface = buildSurfaceMap(rgba, width, height, normalStrength, profile);
  const surfaceMap = makeTexture(surface, width, height, THREE.NoColorSpace, options.anisotropy);

  const emissiveData = palette.emissiveMask(indices, width, height);
  const emissiveMap = emissiveData.length
    ? makeTexture(emissiveData, width, height, THREE.SRGBColorSpace, 1)
    : null;

  return { map, surfaceMap, emissiveMap, width, height, profile };
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

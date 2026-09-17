import * as THREE from 'three';

/** Une lightmap d'origine couvre 16 unités de monde par texel. */
export const LIGHTMAP_SCALE = 16;
const PADDING = 1;

export interface LightmapSlot {
  page: number;
  x: number;
  y: number;
}

/**
 * Empile les lightmaps des faces dans de grandes pages RGBA.
 * Chaque canal porte un style d'éclairage différent de la même face,
 * ce qui permet d'animer les torches et les néons sans retoucher la texture.
 */
export class LightmapAtlas {
  readonly pages: Uint8Array<ArrayBuffer>[] = [];
  private readonly skyline: Uint32Array[] = [];
  private textures: THREE.DataTexture[] = [];

  constructor(readonly size = 2048) {}

  private addPage(): number {
    // Fond noir : une face sans donnée reçoit explicitement sa valeur plus bas.
    this.pages.push(new Uint8Array(this.size * this.size * 4));
    this.skyline.push(new Uint32Array(this.size));
    return this.pages.length - 1;
  }

  private allocate(width: number, height: number): LightmapSlot {
    const w = width + PADDING * 2;
    const h = height + PADDING * 2;
    if (w > this.size || h > this.size) throw new Error('lightmap plus grande que la page');

    for (let page = 0; page < this.pages.length; page++) {
      const skyline = this.skyline[page];
      let bestY = Infinity;
      let bestX = -1;
      for (let x = 0; x + w <= this.size; x++) {
        let y = 0;
        for (let i = 0; i < w; i++) y = Math.max(y, skyline[x + i]);
        if (y + h <= this.size && y < bestY) {
          bestY = y;
          bestX = x;
        }
      }
      if (bestX >= 0) {
        for (let i = 0; i < w; i++) skyline[bestX + i] = bestY + h;
        return { page, x: bestX + PADDING, y: bestY + PADDING };
      }
    }
    this.addPage();
    return this.allocate(width, height);
  }

  /**
   * `sources[i]` contient les échantillons du style i, ou null.
   * `fallback` sert aux faces sans éclairage calculé.
   */
  add(width: number, height: number, sources: (Uint8Array | null)[], fallback = 0): LightmapSlot {
    if (this.pages.length === 0) this.addPage();
    const slot = this.allocate(width, height);
    const page = this.pages[slot.page];

    for (let channel = 0; channel < 4; channel++) {
      const source = sources[channel] ?? null;
      for (let y = -PADDING; y < height + PADDING; y++) {
        const sy = Math.min(height - 1, Math.max(0, y));
        for (let x = -PADDING; x < width + PADDING; x++) {
          const sx = Math.min(width - 1, Math.max(0, x));
          const value = source ? source[sy * width + sx] : channel === 0 ? fallback : 0;
          const dst = ((slot.y + y) * this.size + (slot.x + x)) * 4 + channel;
          page[dst] = value;
        }
      }
    }
    return slot;
  }

  build(): THREE.DataTexture[] {
    this.textures = this.pages.map((data) => {
      const texture = new THREE.DataTexture(data, this.size, this.size, THREE.RGBAFormat);
      texture.magFilter = THREE.LinearFilter;
      texture.minFilter = THREE.LinearFilter;
      texture.wrapS = THREE.ClampToEdgeWrapping;
      texture.wrapT = THREE.ClampToEdgeWrapping;
      texture.generateMipmaps = false;
      texture.colorSpace = THREE.NoColorSpace;
      texture.needsUpdate = true;
      return texture;
    });
    return this.textures;
  }

  dispose(): void {
    for (const texture of this.textures) texture.dispose();
  }
}

const STYLE_COUNT = 64;

/**
 * Intensité de chaque style au cours du temps.
 * Les motifs sont générés ici (bruit filtré, créneaux, respirations)
 * plutôt que codés en dur, ce qui les rend réglables.
 */
export class LightStyles {
  readonly texture: THREE.DataTexture;
  private readonly data: Uint8Array<ArrayBuffer>;
  private readonly patterns: ((t: number) => number)[] = [];

  constructor() {
    this.data = new Uint8Array(STYLE_COUNT * 4);
    this.texture = new THREE.DataTexture(this.data, STYLE_COUNT, 1, THREE.RGBAFormat);
    this.texture.magFilter = THREE.NearestFilter;
    this.texture.minFilter = THREE.NearestFilter;
    this.texture.colorSpace = THREE.NoColorSpace;
    this.texture.needsUpdate = true;

    const noise = (seed: number, speed: number, floor: number) => {
      const table = new Float32Array(64);
      let s = seed | 1;
      for (let i = 0; i < table.length; i++) {
        s = (s * 1103515245 + 12345) & 0x7fffffff;
        table[i] = floor + (1 - floor) * ((s >>> 16) % 1000) / 1000;
      }
      return (t: number) => {
        const p = t * speed;
        const i = Math.floor(p) % table.length;
        const j = (i + 1) % table.length;
        const f = p - Math.floor(p);
        return table[i] * (1 - f) + table[j] * f;
      };
    };

    const steady = () => 1;
    const pulse = (speed: number, low: number, high: number) => (t: number) =>
      low + (high - low) * (0.5 + 0.5 * Math.sin(t * speed));
    const strobe = (speed: number, duty: number) => (t: number) =>
      (t * speed) % 1 < duty ? 1 : 0.05;

    this.patterns[0] = steady;
    this.patterns[1] = noise(0x51f3, 10, 0.35); // torche nerveuse
    this.patterns[2] = pulse(1.4, 0.15, 1);
    this.patterns[3] = noise(0x9a2b, 7, 0.55); // bougie
    this.patterns[4] = strobe(9, 0.5);
    this.patterns[5] = pulse(2.6, 0.45, 1);
    this.patterns[6] = noise(0x3cd1, 13, 0.2);
    this.patterns[7] = noise(0x77e5, 6, 0.6);
    this.patterns[8] = noise(0x1bb9, 8, 0.45);
    this.patterns[9] = strobe(2.2, 0.35);
    this.patterns[10] = (t: number) => (noise(0x2f8c, 20, 0)(t) > 0.35 ? 1 : 0.25); // néon fatigué
    this.patterns[11] = pulse(3.4, 0.6, 1);
    for (let i = 12; i < STYLE_COUNT; i++) this.patterns[i] = steady;
    this.update(0);
  }

  /** Intensité courante d'un style, pour les sources dynamiques du même style. */
  intensityOf(style: number): number {
    if (style < 0 || style >= STYLE_COUNT) return 1;
    return this.data[style * 4] / 255;
  }

  update(time: number): void {
    for (let i = 0; i < STYLE_COUNT; i++) {
      const value = Math.max(0, Math.min(1, this.patterns[i](time)));
      this.data[i * 4] = Math.round(value * 255);
      this.data[i * 4 + 3] = 255;
    }
    this.texture.needsUpdate = true;
  }

  dispose(): void {
    this.texture.dispose();
  }
}

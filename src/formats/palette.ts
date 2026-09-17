/**
 * Palette 256 couleurs du jeu (gfx/palette.lmp, 768 octets).
 * Les 32 dernières entrées sont les couleurs "fullbright" : elles ne sont pas
 * assombries par l'éclairage, on s'en sert pour construire la carte émissive.
 */
export const FULLBRIGHT_START = 224;

export class Palette {
  readonly rgb: Uint8Array;

  constructor(data: Uint8Array) {
    if (data.length < 768) throw new Error('palette invalide : 768 octets attendus');
    this.rgb = data.subarray(0, 768);
  }

  /** Palette de repli quand aucune donnée n'est montée : dégradés neutres. */
  static fallback(): Palette {
    const rgb = new Uint8Array(768);
    for (let i = 0; i < 256; i++) {
      const t = i / 255;
      if (i < FULLBRIGHT_START) {
        const v = Math.round(255 * Math.pow(t, 0.75));
        rgb[i * 3] = v;
        rgb[i * 3 + 1] = Math.round(v * 0.95);
        rgb[i * 3 + 2] = Math.round(v * 0.85);
      } else {
        rgb[i * 3] = 255;
        rgb[i * 3 + 1] = Math.round(180 + 75 * t);
        rgb[i * 3 + 2] = 90;
      }
    }
    return new Palette(rgb);
  }

  color(index: number): [number, number, number] {
    const o = (index & 0xff) * 3;
    return [this.rgb[o], this.rgb[o + 1], this.rgb[o + 2]];
  }

  /** Convertit une image indexée en RGBA. L'index 255 est transparent si demandé. */
  expand(indices: Uint8Array, width: number, height: number, transparentIndex = -1): Uint8Array<ArrayBuffer> {
    const out = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      const index = indices[i];
      const o = index * 3;
      const p = i * 4;
      out[p] = this.rgb[o];
      out[p + 1] = this.rgb[o + 1];
      out[p + 2] = this.rgb[o + 2];
      out[p + 3] = index === transparentIndex ? 0 : 255;
    }
    return out;
  }

  /** Masque des pixels fullbright, en niveaux de gris, pour l'émissif. */
  emissiveMask(indices: Uint8Array, width: number, height: number): Uint8Array<ArrayBuffer> {
    const out = new Uint8Array(width * height * 4);
    let any = 0;
    for (let i = 0; i < width * height; i++) {
      const index = indices[i];
      const p = i * 4;
      if (index >= FULLBRIGHT_START) {
        const o = index * 3;
        out[p] = this.rgb[o];
        out[p + 1] = this.rgb[o + 1];
        out[p + 2] = this.rgb[o + 2];
        any = 1;
      }
      out[p + 3] = 255;
    }
    return any ? out : new Uint8Array(0);
  }
}

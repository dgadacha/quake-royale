import { decompressVis, type BspData } from '../formats/bsp';
import type { Vec3 } from '../game/collision';

/**
 * Ensemble des feuilles potentiellement visibles depuis un point.
 *
 * Une carte compilée range dans ses données, pour chaque feuille de l'arbre,
 * la liste de celles qu'on peut apercevoir depuis elle. C'est un travail déjà
 * fait à la compilation : il suffit de le lire pour écarter d'un coup tout ce
 * qui se trouve derrière un mur.
 */
export class VisibilitySet {
  private readonly cache = new Map<number, Uint8Array>();
  private readonly leafCount: number;
  /** Toutes les feuilles visibles, employé quand la carte n'a pas de données. */
  private readonly everything: Uint8Array;

  constructor(private readonly bsp: BspData) {
    this.leafCount = bsp.leafs.length - 1;
    this.everything = new Uint8Array((this.leafCount + 7) >> 3).fill(0xff);
  }

  get hasData(): boolean {
    return this.bsp.visData.length > 0;
  }

  /** Feuille contenant un point, par descente dans l'arbre. */
  findLeaf(point: Vec3): number {
    let num = this.bsp.models[0].headNodes[0];
    while (num >= 0) {
      const node = this.bsp.nodes[num];
      const plane = this.bsp.planes[node.plane];
      const distance =
        plane.type < 3
          ? point[plane.type] - plane.dist
          : point[0] * plane.normal[0] +
            point[1] * plane.normal[1] +
            point[2] * plane.normal[2] -
            plane.dist;
      num = distance < 0 ? node.children[1] : node.children[0];
    }
    return -1 - num;
  }

  /**
   * Liste décompressée des feuilles visibles depuis une feuille donnée.
   * Le résultat est conservé : on repasse sans cesse par les mêmes endroits.
   */
  visibleFrom(leafIndex: number): Uint8Array {
    const leaf = this.bsp.leafs[leafIndex];
    // La feuille pleine, ou une carte sans données de visibilité, ne permet
    // aucun tri : on montre tout plutôt que de risquer des trous.
    if (!leaf || leafIndex === 0 || leaf.visOffset < 0 || !this.hasData) {
      return this.everything;
    }

    const cached = this.cache.get(leafIndex);
    if (cached) return cached;

    const decompressed = decompressVis(this.bsp.visData, leaf.visOffset, this.leafCount);
    this.cache.set(leafIndex, decompressed);
    return decompressed;
  }

  /** La feuille est-elle marquée visible dans cet ensemble ? */
  static isVisible(set: Uint8Array, leafIndex: number): boolean {
    // Les feuilles sont numérotées à partir de 1 dans les données de visibilité.
    const bit = leafIndex - 1;
    if (bit < 0) return false;
    return (set[bit >> 3] & (1 << (bit & 7))) !== 0;
  }

  get cachedRows(): number {
    return this.cache.size;
  }
}

/** Associe chaque face du monde aux feuilles qui la référencent. */
export function buildFaceLeafIndex(bsp: BspData): Map<number, number[]> {
  const index = new Map<number, number[]>();
  for (let leafIndex = 1; leafIndex < bsp.leafs.length; leafIndex++) {
    const leaf = bsp.leafs[leafIndex];
    for (let i = 0; i < leaf.markSurfaceCount; i++) {
      const faceIndex = bsp.markSurfaces[leaf.firstMarkSurface + i];
      const leafs = index.get(faceIndex);
      if (leafs) leafs.push(leafIndex);
      else index.set(faceIndex, [leafIndex]);
    }
  }
  return index;
}

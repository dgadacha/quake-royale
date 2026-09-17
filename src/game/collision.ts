import { Contents, type BspData } from '../formats/bsp';

export type Vec3 = [number, number, number];

const DIST_EPSILON = 0.03125;

export interface TraceResult {
  /** Le trajet entier est dans la matière. */
  allSolid: boolean;
  /** Le point de départ est déjà dans la matière. */
  startSolid: boolean;
  fraction: number;
  endPos: Vec3;
  planeNormal: Vec3;
  planeDist: number;
  /** Vrai si la trace a heurté quelque chose. */
  hit: boolean;
}

export interface Hull {
  headNode: number;
  mins: Vec3;
  maxs: Vec3;
  clipNodes: { plane: number; children: [number, number] }[];
}

/** Gabarits de collision du jeu : point, joueur debout, grande créature. */
export const HULL_POINT = 0;
export const HULL_PLAYER = 1;
export const HULL_LARGE = 2;

export const PLAYER_MINS: Vec3 = [-16, -16, -24];
export const PLAYER_MAXS: Vec3 = [16, 16, 32];

/** Ce dont la physique a besoin, quelle que soit la source de la géométrie. */
export interface CollisionWorld {
  trace(start: Vec3, end: Vec3): TraceResult;
  pointContents(point: Vec3): number;
}

export class BspCollision {
  constructor(private readonly bsp: BspData) {}

  hull(modelIndex: number, hullIndex: number): Hull {
    const model = this.bsp.models[modelIndex];
    const sizes: { mins: Vec3; maxs: Vec3 }[] = [
      { mins: [0, 0, 0], maxs: [0, 0, 0] },
      { mins: [-16, -16, -24], maxs: [16, 16, 32] },
      { mins: [-32, -32, -24], maxs: [32, 32, 64] },
    ];
    const size = sizes[hullIndex] ?? sizes[0];
    return {
      headNode: model.headNodes[hullIndex],
      mins: size.mins,
      maxs: size.maxs,
      clipNodes: this.bsp.clipNodes,
    };
  }

  /** Vue prête à l'emploi sur un gabarit donné. */
  world(modelIndex = 0, hullIndex = HULL_PLAYER): CollisionWorld {
    const hull = this.hull(modelIndex, hullIndex);
    return {
      trace: (start, end) => this.trace(hull, start, end),
      pointContents: (point) => this.pointContents(point, modelIndex),
    };
  }

  /** Contenu du volume à ce point : vide, eau, lave, matière. */
  pointContents(point: Vec3, modelIndex = 0): number {
    let num = this.bsp.models[modelIndex].headNodes[0];
    while (num >= 0) {
      const node = this.bsp.nodes[num];
      const plane = this.bsp.planes[node.plane];
      const d =
        plane.type < 3
          ? point[plane.type] - plane.dist
          : point[0] * plane.normal[0] +
            point[1] * plane.normal[1] +
            point[2] * plane.normal[2] -
            plane.dist;
      num = d < 0 ? node.children[1] : node.children[0];
    }
    const leafIndex = -1 - num;
    const leaf = this.bsp.leafs[leafIndex];
    return leaf ? leaf.contents : Contents.SOLID;
  }

  /** Contenu selon le gabarit de collision, utilisé pour les volumes solides. */
  hullPointContents(hull: Hull, num: number, point: Vec3): number {
    while (num >= 0) {
      const node = hull.clipNodes[num];
      if (!node) return Contents.SOLID;
      const plane = this.bsp.planes[node.plane];
      const d =
        plane.type < 3
          ? point[plane.type] - plane.dist
          : point[0] * plane.normal[0] +
            point[1] * plane.normal[1] +
            point[2] * plane.normal[2] -
            plane.dist;
      num = d < 0 ? node.children[1] : node.children[0];
    }
    return num;
  }

  trace(hull: Hull, start: Vec3, end: Vec3): TraceResult {
    const result: TraceResult = {
      allSolid: true,
      startSolid: false,
      fraction: 1,
      endPos: [end[0], end[1], end[2]],
      planeNormal: [0, 0, 0],
      planeDist: 0,
      hit: false,
    };
    this.recurse(hull, hull.headNode, 0, 1, start, end, result);
    if (result.fraction === 1) {
      result.endPos = [end[0], end[1], end[2]];
    }
    return result;
  }

  /**
   * Descente récursive dans l'arbre de collision.
   * Le trajet est coupé à chaque plan traversé jusqu'à toucher une feuille
   * pleine, ce qui donne la fraction de trajet réellement parcourue.
   */
  private recurse(
    hull: Hull,
    num: number,
    startFraction: number,
    endFraction: number,
    start: Vec3,
    end: Vec3,
    trace: TraceResult,
  ): boolean {
    if (num < 0) {
      if (num !== Contents.SOLID) {
        trace.allSolid = false;
      } else {
        trace.startSolid = true;
      }
      return true;
    }

    const node = hull.clipNodes[num];
    if (!node) return true;
    const plane = this.bsp.planes[node.plane];

    const dot = (p: Vec3) =>
      plane.type < 3
        ? p[plane.type] - plane.dist
        : p[0] * plane.normal[0] + p[1] * plane.normal[1] + p[2] * plane.normal[2] - plane.dist;

    const t1 = dot(start);
    const t2 = dot(end);

    if (t1 >= 0 && t2 >= 0) {
      return this.recurse(hull, node.children[0], startFraction, endFraction, start, end, trace);
    }
    if (t1 < 0 && t2 < 0) {
      return this.recurse(hull, node.children[1], startFraction, endFraction, start, end, trace);
    }

    // Le segment traverse le plan : on le coupe en deux.
    let fraction =
      t1 < 0 ? (t1 + DIST_EPSILON) / (t1 - t2) : (t1 - DIST_EPSILON) / (t1 - t2);
    fraction = Math.max(0, Math.min(1, fraction));

    let midFraction = startFraction + (endFraction - startFraction) * fraction;
    const mid: Vec3 = [
      start[0] + fraction * (end[0] - start[0]),
      start[1] + fraction * (end[1] - start[1]),
      start[2] + fraction * (end[2] - start[2]),
    ];

    const side = t1 < 0 ? 1 : 0;
    if (!this.recurse(hull, node.children[side], startFraction, midFraction, start, mid, trace)) {
      return false;
    }

    if (
      this.hullPointContents(hull, node.children[side ^ 1], mid) !== Contents.SOLID
    ) {
      return this.recurse(hull, node.children[side ^ 1], midFraction, endFraction, mid, end, trace);
    }

    if (trace.allSolid) return false; // entièrement bloqué

    if (side === 0) {
      trace.planeNormal = [plane.normal[0], plane.normal[1], plane.normal[2]];
      trace.planeDist = plane.dist;
    } else {
      trace.planeNormal = [-plane.normal[0], -plane.normal[1], -plane.normal[2]];
      trace.planeDist = -plane.dist;
    }

    // On recule tant que le point d'arrêt reste dans la matière.
    let guard = 0;
    while (this.hullPointContents(hull, hull.headNode, mid) === Contents.SOLID) {
      fraction -= 0.1;
      if (fraction < 0 || guard++ > 16) {
        trace.fraction = midFraction;
        trace.endPos = [mid[0], mid[1], mid[2]];
        trace.hit = true;
        return false;
      }
      midFraction = startFraction + (endFraction - startFraction) * fraction;
      mid[0] = start[0] + fraction * (end[0] - start[0]);
      mid[1] = start[1] + fraction * (end[1] - start[1]);
      mid[2] = start[2] + fraction * (end[2] - start[2]);
    }

    trace.fraction = midFraction;
    trace.endPos = [mid[0], mid[1], mid[2]];
    trace.hit = true;
    return false;
  }
}

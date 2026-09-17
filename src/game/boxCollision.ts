import { Contents } from '../formats/bsp';
import { PLAYER_MAXS, PLAYER_MINS, type CollisionWorld, type TraceResult, type Vec3 } from './collision';

export interface CollisionBox {
  min: Vec3;
  max: Vec3;
  /** Contenu du volume : matière pleine, eau, lave. */
  contents: number;
}

/** Recul appliqué au point d'arrêt, exprimé en unités de monde. */
const EPSILON = 0.03125;

/**
 * Collision par boîtes alignées, utilisée par la carte de démonstration.
 * Le gabarit du joueur est reporté sur les boîtes (somme de Minkowski),
 * ce qui ramène le problème à un simple lancer de rayon.
 */
export class BoxCollision implements CollisionWorld {
  private readonly solids: CollisionBox[] = [];
  private readonly volumes: CollisionBox[] = [];

  constructor(boxes: CollisionBox[]) {
    for (const box of boxes) {
      if (box.contents === Contents.SOLID) this.solids.push(box);
      else this.volumes.push(box);
    }
  }

  pointContents(point: Vec3): number {
    for (const box of this.solids) {
      if (inside(point, box)) return Contents.SOLID;
    }
    for (const box of this.volumes) {
      if (inside(point, box)) return box.contents;
    }
    return Contents.EMPTY;
  }

  trace(start: Vec3, end: Vec3): TraceResult {
    const result: TraceResult = {
      allSolid: false,
      startSolid: false,
      fraction: 1,
      endPos: [...end] as Vec3,
      planeNormal: [0, 0, 0],
      planeDist: 0,
      hit: false,
    };

    for (const box of this.solids) {
      const min: Vec3 = [
        box.min[0] - PLAYER_MAXS[0],
        box.min[1] - PLAYER_MAXS[1],
        box.min[2] - PLAYER_MAXS[2],
      ];
      const max: Vec3 = [
        box.max[0] - PLAYER_MINS[0],
        box.max[1] - PLAYER_MINS[1],
        box.max[2] - PLAYER_MINS[2],
      ];

      if (inside(start, { min, max, contents: Contents.SOLID })) {
        result.startSolid = true;
        result.allSolid = true;
        result.fraction = 0;
        result.endPos = [...start] as Vec3;
        return result;
      }

      const hit = traceBox(start, end, min, max);
      if (hit && hit.fraction < result.fraction) {
        result.fraction = hit.fraction;
        result.planeNormal = hit.normal;
        result.hit = true;
      }
    }

    if (result.hit) {
      result.endPos = [
        start[0] + (end[0] - start[0]) * result.fraction,
        start[1] + (end[1] - start[1]) * result.fraction,
        start[2] + (end[2] - start[2]) * result.fraction,
      ];
    }
    return result;
  }

  /** Lancer de rayon fin, pour l'occultation des lumières. */
  rayBlocked(from: Vec3, to: Vec3): boolean {
    for (const box of this.solids) {
      const hit = traceBox(from, to, box.min, box.max);
      if (hit && hit.fraction < 0.999) return true;
    }
    return false;
  }
}

function inside(point: Vec3, box: CollisionBox | { min: Vec3; max: Vec3; contents: number }): boolean {
  return (
    point[0] >= box.min[0] &&
    point[0] <= box.max[0] &&
    point[1] >= box.min[1] &&
    point[1] <= box.max[1] &&
    point[2] >= box.min[2] &&
    point[2] <= box.max[2]
  );
}

function traceBox(
  start: Vec3,
  end: Vec3,
  min: Vec3,
  max: Vec3,
): { fraction: number; normal: Vec3 } | null {
  let enter = -Infinity;
  let exit = Infinity;
  let normal: Vec3 = [0, 0, 0];

  for (let axis = 0; axis < 3; axis++) {
    const direction = end[axis] - start[axis];
    if (Math.abs(direction) < 1e-8) {
      if (start[axis] < min[axis] || start[axis] > max[axis]) return null;
      continue;
    }
    let t0 = (min[axis] - start[axis]) / direction;
    let t1 = (max[axis] - start[axis]) / direction;
    let sign = -1;
    if (t0 > t1) {
      [t0, t1] = [t1, t0];
      sign = 1;
    }
    if (t0 > enter) {
      enter = t0;
      normal = [0, 0, 0];
      normal[axis] = sign;
    }
    exit = Math.min(exit, t1);
    if (enter > exit) return null;
  }

  if (enter === -Infinity || enter > 1 || exit < 0) return null;

  // Le recul doit valoir la même distance quelle que soit la longueur du
  // trajet : converti en fraction, sinon un long trajet décolle du sol.
  const segment = Math.hypot(end[0] - start[0], end[1] - start[1], end[2] - start[2]);
  const backoff = segment > 1e-6 ? EPSILON / segment : 0;
  return { fraction: Math.max(0, enter - backoff), normal };
}

import type { BspCollision, CollisionWorld, TraceResult, Vec3 } from '../collision';
import { HULL_PLAYER } from '../collision';
import type { Mover } from './BrushEntity';

/**
 * Collision du monde augmentée des sous-modèles mobiles.
 *
 * Le décor fixe et chaque volume mobile sont interrogés séparément, et c'est
 * le contact le plus proche qui l'emporte. Sans cela une porte fermée se
 * traverserait, puisque seule la géométrie du monde est consultée.
 */
export class MoverCollision implements CollisionWorld {
  constructor(
    private readonly world: CollisionWorld,
    private readonly bsp: BspCollision,
    private readonly movers: Mover[],
    private readonly hullIndex = HULL_PLAYER,
  ) {}

  trace(start: Vec3, end: Vec3): TraceResult {
    let closest = this.world.trace(start, end);

    for (const mover of this.movers) {
      // Un volume rangé au ras de son logement ne bloque plus rien d'utile.
      const hit = this.bsp.traceModel(
        mover.modelIndex,
        this.hullIndex,
        start,
        end,
        mover.offset,
      );
      if (hit.startSolid && !closest.startSolid) {
        // Poussé par un volume en mouvement : on reste où l'on est.
        return { ...hit, endPos: [...start] as Vec3, fraction: 0 };
      }
      if (hit.fraction < closest.fraction) closest = hit;
    }

    return closest;
  }

  pointContents(point: Vec3): number {
    return this.world.pointContents(point);
  }
}

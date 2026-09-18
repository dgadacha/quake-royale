import type { Vec3 } from '../collision';
import { distanceToMover, type Mover } from './BrushEntity';

/** Distance à laquelle une porte sans déclencheur nommé réagit au joueur. */
const APPROACH_RANGE = 64;

/**
 * Anime les sous-modèles mobiles d'une carte.
 *
 * Une porte s'ouvre à l'approche, patiente, puis se referme ; une plateforme
 * monte tant que le joueur est dessus ou à proximité et redescend ensuite.
 * Les portes nommées attendent un déclencheur et ne réagissent pas seules.
 */
export interface MoverEvents {
  onOpen?(mover: Mover): void;
  onClose?(mover: Mover): void;
}

export class MoverManager {
  constructor(
    readonly movers: Mover[],
    private readonly events: MoverEvents = {},
  ) {}

  /** Ouvre par son nom, pour les portes commandées par un bouton. */
  trigger(name: string): void {
    for (const mover of this.movers) {
      if (mover.targetName === name) this.open(mover);
    }
  }

  private open(mover: Mover): void {
    if (mover.state === 'open' || mover.state === 'opening') return;
    mover.state = 'opening';
    mover.waited = 0;
    this.events.onOpen?.(mover);
  }

  update(deltaTime: number, playerPosition: Vec3): void {
    for (const mover of this.movers) {
      const distance = distanceToMover(mover, playerPosition);
      const near = distance < APPROACH_RANGE;

      // Une porte nommée est commandée ailleurs : elle ignore la proximité.
      if (near && !mover.targetName && mover.state === 'closed') this.open(mover);
      if (near && mover.kind === 'plat' && mover.state === 'closed') this.open(mover);

      const length = Math.hypot(mover.travel[0], mover.travel[1], mover.travel[2]);
      // Un volume qui ne va nulle part n'a pas à consommer de temps.
      const step = length > 0 ? (mover.speed * deltaTime) / length : 1;

      switch (mover.state) {
        case 'opening':
          mover.progress = Math.min(1, mover.progress + step);
          if (mover.progress >= 1) {
            mover.state = 'open';
            mover.waited = 0;
          }
          break;

        case 'open':
          mover.waited += deltaTime;
          // Une attente négative signale un volume qui reste ouvert.
          if (mover.wait >= 0 && mover.waited >= mover.wait && !near) {
            mover.state = 'closing';
            this.events.onClose?.(mover);
          }
          break;

        case 'closing':
          // Revenir alors que le joueur est encore là l'écraserait.
          if (near && mover.kind !== 'button') {
            mover.state = 'opening';
            break;
          }
          mover.progress = Math.max(0, mover.progress - step);
          if (mover.progress <= 0) mover.state = 'closed';
          break;

        case 'closed':
          break;
      }

      mover.offset[0] = mover.travel[0] * mover.progress;
      mover.offset[1] = mover.travel[1] * mover.progress;
      mover.offset[2] = mover.travel[2] * mover.progress;
    }
  }

  get movingCount(): number {
    return this.movers.filter((mover) => mover.state === 'opening' || mover.state === 'closing')
      .length;
  }

  get openCount(): number {
    return this.movers.filter((mover) => mover.state === 'open' || mover.progress > 0).length;
  }
}

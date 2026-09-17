import type { BspData, BspEntity } from '../../formats/bsp';
import type { Vec3 } from '../collision';

export type MoverKind = 'door' | 'plat' | 'button';
export type MoverState = 'closed' | 'opening' | 'open' | 'closing';

/**
 * Sous-modèle mobile d'une carte : porte, plateforme ou bouton.
 *
 * La carte ne décrit que la position fermée et la manière de bouger ; la
 * trajectoire se déduit de la taille du volume et de la direction donnée.
 */
export interface Mover {
  modelIndex: number;
  kind: MoverKind;
  /** Décalage courant par rapport à la position compilée. */
  offset: Vec3;
  /** Décalage une fois ouvert ou monté. */
  travel: Vec3;
  /** Avancement du mouvement, de 0 fermé à 1 ouvert. */
  progress: number;
  state: MoverState;
  speed: number;
  /** Temps d'attente avant le retour ; négatif pour rester ouvert. */
  wait: number;
  waited: number;
  mins: Vec3;
  maxs: Vec3;
  /** Une porte nommée attend un déclencheur, pas la proximité du joueur. */
  targetName: string | null;
}

function parseNumber(value: string | undefined, fallback: number): number {
  const parsed = Number.parseFloat(value ?? '');
  return Number.isNaN(parsed) ? fallback : parsed;
}

/**
 * Direction d'ouverture. Deux valeurs d'angle sont réservées aux mouvements
 * verticaux, les autres décrivent un cap en degrés.
 */
function openingDirection(entity: BspEntity): Vec3 {
  const angle = parseNumber(entity.angle, 0);
  if (angle === -1) return [0, 0, 1];
  if (angle === -2) return [0, 0, -1];
  const radians = angle * (Math.PI / 180);
  return [Math.cos(radians), Math.sin(radians), 0];
}

export function collectMovers(bsp: BspData): Mover[] {
  const movers: Mover[] = [];

  for (const entity of bsp.entities) {
    const match = /^\*(\d+)$/.exec(entity.model ?? '');
    if (!match) continue;
    const modelIndex = Number.parseInt(match[1], 10);
    const model = bsp.models[modelIndex];
    if (!model) continue;

    const classname = entity.classname ?? '';
    const kind: MoverKind | null = classname.startsWith('func_door')
      ? 'door'
      : classname.startsWith('func_plat')
        ? 'plat'
        : classname.startsWith('func_button')
          ? 'button'
          : null;
    if (!kind) continue;

    const size: Vec3 = [
      model.maxs[0] - model.mins[0],
      model.maxs[1] - model.mins[1],
      model.maxs[2] - model.mins[2],
    ];

    // Le volume ne se retire jamais complètement : il laisse dépasser une
    // lèvre, sans quoi une porte disparaîtrait entièrement dans le mur.
    const lip = parseNumber(entity.lip, 8);
    let direction: Vec3;
    let distance: number;

    if (kind === 'plat') {
      direction = [0, 0, 1];
      const height = parseNumber(entity.height, 0);
      distance = height > 0 ? height : size[2] - lip;
    } else {
      direction = openingDirection(entity);
      distance =
        Math.abs(direction[0] * size[0]) +
        Math.abs(direction[1] * size[1]) +
        Math.abs(direction[2] * size[2]) -
        lip;
    }
    distance = Math.max(0, distance);

    movers.push({
      modelIndex,
      kind,
      offset: [0, 0, 0],
      travel: [direction[0] * distance, direction[1] * distance, direction[2] * distance],
      progress: 0,
      state: 'closed',
      speed: parseNumber(entity.speed, kind === 'plat' ? 150 : 100),
      wait: parseNumber(entity.wait, kind === 'button' ? 1 : 3),
      waited: 0,
      mins: [...model.mins] as Vec3,
      maxs: [...model.maxs] as Vec3,
      targetName: entity.targetname ?? null,
    });
  }

  return movers;
}

/** Distance du joueur au volume du sous-modèle, dans sa position courante. */
export function distanceToMover(mover: Mover, point: Vec3): number {
  let squared = 0;
  for (let axis = 0; axis < 3; axis++) {
    const min = mover.mins[axis] + mover.offset[axis];
    const max = mover.maxs[axis] + mover.offset[axis];
    const outside = point[axis] < min ? min - point[axis] : point[axis] > max ? point[axis] - max : 0;
    squared += outside * outside;
  }
  return Math.sqrt(squared);
}

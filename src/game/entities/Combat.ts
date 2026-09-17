import type { CollisionWorld, Vec3 } from '../collision';
import type { Enemy } from './Enemy';

export interface HitResult {
  enemy: Enemy | null;
  /** Point d'impact, sur une créature ou sur le décor. */
  point: Vec3;
  distance: number;
  killed: boolean;
}

/** Intersection d'un rayon avec la boîte d'une créature. */
function intersectEnemy(origin: Vec3, direction: Vec3, enemy: Enemy, maxDistance: number): number | null {
  const radius = enemy.profile.radius;
  const min: Vec3 = [
    enemy.origin[0] - radius,
    enemy.origin[1] - radius,
    enemy.origin[2],
  ];
  const max: Vec3 = [
    enemy.origin[0] + radius,
    enemy.origin[1] + radius,
    enemy.origin[2] + enemy.profile.height,
  ];

  let enter = 0;
  let exit = maxDistance;
  for (let axis = 0; axis < 3; axis++) {
    if (Math.abs(direction[axis]) < 1e-8) {
      if (origin[axis] < min[axis] || origin[axis] > max[axis]) return null;
      continue;
    }
    let t0 = (min[axis] - origin[axis]) / direction[axis];
    let t1 = (max[axis] - origin[axis]) / direction[axis];
    if (t0 > t1) [t0, t1] = [t1, t0];
    enter = Math.max(enter, t0);
    exit = Math.min(exit, t1);
    if (enter > exit) return null;
  }
  return enter >= 0 && enter <= maxDistance ? enter : null;
}

/**
 * Tir instantané.
 *
 * Le décor est consulté d'abord : il fixe la portée utile du tir. Une créature
 * située derrière le mur touché ne peut donc pas être atteinte, sans avoir à
 * la tester elle-même contre la géométrie.
 */
export function fireRay(
  collision: CollisionWorld,
  enemies: Enemy[],
  origin: Vec3,
  direction: Vec3,
  range: number,
  damage: number,
  onDamage: (enemy: Enemy, amount: number) => boolean,
): HitResult {
  const end: Vec3 = [
    origin[0] + direction[0] * range,
    origin[1] + direction[1] * range,
    origin[2] + direction[2] * range,
  ];

  const worldTrace = collision.trace(origin, end);
  const wallDistance = worldTrace.fraction * range;

  let closest: Enemy | null = null;
  let closestDistance = wallDistance;

  for (const enemy of enemies) {
    if (enemy.state === 'dead' || enemy.state === 'dying') continue;
    const distance = intersectEnemy(origin, direction, enemy, closestDistance);
    if (distance !== null && distance < closestDistance) {
      closest = enemy;
      closestDistance = distance;
    }
  }

  const point: Vec3 = [
    origin[0] + direction[0] * closestDistance,
    origin[1] + direction[1] * closestDistance,
    origin[2] + direction[2] * closestDistance,
  ];

  const killed = closest ? onDamage(closest, damage) : false;
  return { enemy: closest, point, distance: closestDistance, killed };
}

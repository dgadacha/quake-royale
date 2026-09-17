import type { CollisionWorld, Vec3 } from '../collision';
import type { Enemy } from './Enemy';

const GRAVITY = 800;
const STEP_HEIGHT = 18;

export interface EnemyWorld {
  collision: CollisionWorld;
  /** Deux points se voient-ils ? Sert à la perception des créatures. */
  isVisible(from: Vec3, to: Vec3): boolean;
}

export interface EnemyEvents {
  onPlayerHit(damage: number, from: Vec3): void;
}

/**
 * Comportement des adversaires.
 *
 * Chacun dort jusqu'à ce que le joueur entre dans son champ, le poursuit tant
 * qu'il le voit, retient sa dernière position connue quand il le perd, et
 * frappe une fois à portée. Rien de plus : c'est le minimum pour qu'une carte
 * peuplée devienne hostile, et cela tient sans plan de navigation.
 */
export class EnemyManager {
  constructor(
    readonly enemies: Enemy[],
    private readonly world: EnemyWorld,
    private readonly events: EnemyEvents,
  ) {}

  get aliveCount(): number {
    return this.enemies.filter((enemy) => enemy.state !== 'dead' && enemy.state !== 'dying').length;
  }

  get awakeCount(): number {
    return this.enemies.filter(
      (enemy) => enemy.state === 'chasing' || enemy.state === 'attacking',
    ).length;
  }

  /** Inflige des dégâts et renvoie vrai si le coup est fatal. */
  damage(enemy: Enemy, amount: number): boolean {
    if (enemy.state === 'dead' || enemy.state === 'dying') return false;
    enemy.health -= amount;
    // Être touché réveille, même hors de vue.
    if (enemy.state === 'dormant') enemy.state = 'chasing';
    if (enemy.health <= 0) {
      enemy.state = 'dying';
      enemy.deathProgress = 0;
      return true;
    }
    return false;
  }

  update(deltaTime: number, playerPosition: Vec3): void {
    for (const enemy of this.enemies) {
      if (enemy.state === 'dead') continue;

      if (enemy.state === 'dying') {
        enemy.deathProgress = Math.min(1, enemy.deathProgress + deltaTime * 2.2);
        if (enemy.deathProgress >= 1) enemy.state = 'dead';
        this.applyGravity(enemy, deltaTime);
        continue;
      }

      const eye: Vec3 = [enemy.origin[0], enemy.origin[1], enemy.origin[2] + enemy.profile.height * 0.8];
      const target: Vec3 = [playerPosition[0], playerPosition[1], playerPosition[2] + 22];
      const distance = Math.hypot(
        target[0] - eye[0],
        target[1] - eye[1],
        target[2] - eye[2],
      );

      const sees =
        distance < enemy.profile.sightRange && this.world.isVisible(eye, target);
      if (sees) enemy.lastSeen = [...playerPosition] as Vec3;

      switch (enemy.state) {
        case 'dormant':
          if (sees) enemy.state = 'alerted';
          break;

        case 'alerted':
          // Court temps de réaction : une créature qui charge à l'instant même
          // où elle aperçoit le joueur ne laisse aucune chance de l'éviter.
          enemy.sinceAttack += deltaTime;
          if (enemy.sinceAttack > 0.35) {
            enemy.state = 'chasing';
            enemy.sinceAttack = 0;
          }
          break;

        case 'chasing':
          if (sees && distance <= enemy.profile.attackRange) {
            enemy.state = 'attacking';
            break;
          }
          this.moveToward(enemy, enemy.lastSeen ?? playerPosition, deltaTime);
          // Sans rien à poursuivre, la créature se rendort.
          if (!sees && !enemy.lastSeen) enemy.state = 'dormant';
          break;

        case 'attacking':
          enemy.sinceAttack += deltaTime;
          if (!sees || distance > enemy.profile.attackRange * 1.15) {
            enemy.state = 'chasing';
            break;
          }
          this.faceTarget(enemy, target);
          if (enemy.sinceAttack >= enemy.profile.attackDelay) {
            enemy.sinceAttack = 0;
            this.events.onPlayerHit(enemy.profile.damage, enemy.origin);
          }
          break;
      }

      this.applyGravity(enemy, deltaTime);
    }
  }

  private faceTarget(enemy: Enemy, target: Vec3): void {
    enemy.yaw = Math.atan2(target[1] - enemy.origin[1], target[0] - enemy.origin[0]);
  }

  /** Avance vers un point, en glissant le long de ce qui bloque. */
  private moveToward(enemy: Enemy, target: Vec3, deltaTime: number): void {
    const dx = target[0] - enemy.origin[0];
    const dy = target[1] - enemy.origin[1];
    const length = Math.hypot(dx, dy);
    if (length < 1) {
      enemy.lastSeen = null;
      return;
    }

    this.faceTarget(enemy, target);
    const step = enemy.profile.speed * deltaTime;
    const wish: Vec3 = [
      enemy.origin[0] + (dx / length) * step,
      enemy.origin[1] + (dy / length) * step,
      enemy.origin[2],
    ];

    const trace = this.world.collision.trace(enemy.origin, wish);
    if (trace.fraction >= 1) {
      enemy.origin = trace.endPos;
      return;
    }

    // Obstacle : on tente de le franchir comme une marche, puis on longe.
    const raised: Vec3 = [enemy.origin[0], enemy.origin[1], enemy.origin[2] + STEP_HEIGHT];
    const upTrace = this.world.collision.trace(enemy.origin, raised);
    if (!upTrace.startSolid) {
      const overStep: Vec3 = [wish[0], wish[1], upTrace.endPos[2]];
      const stepTrace = this.world.collision.trace(upTrace.endPos, overStep);
      if (stepTrace.fraction > trace.fraction) {
        enemy.origin = stepTrace.endPos;
        return;
      }
    }

    enemy.origin = trace.endPos;
    const normal = trace.planeNormal;
    const slide: Vec3 = [
      wish[0] - normal[0] * (normal[0] * (wish[0] - enemy.origin[0])),
      wish[1] - normal[1] * (normal[1] * (wish[1] - enemy.origin[1])),
      enemy.origin[2],
    ];
    const slideTrace = this.world.collision.trace(enemy.origin, slide);
    if (slideTrace.fraction > 0) enemy.origin = slideTrace.endPos;
  }

  /** Maintient la créature au sol et la fait tomber dans le vide. */
  private applyGravity(enemy: Enemy, deltaTime: number): void {
    enemy.velocity[2] -= GRAVITY * deltaTime;
    const below: Vec3 = [
      enemy.origin[0],
      enemy.origin[1],
      enemy.origin[2] + enemy.velocity[2] * deltaTime,
    ];
    const trace = this.world.collision.trace(enemy.origin, below);
    enemy.origin = trace.endPos;
    enemy.onGround = trace.fraction < 1 && trace.planeNormal[2] >= 0.7;
    if (enemy.onGround) enemy.velocity[2] = 0;
  }
}

import type { CollisionWorld, Vec3 } from '../collision';
import type { Enemy } from './Enemy';

const GRAVITY = 800;
const STEP_HEIGHT = 18;

/**
 * Ouverture du regard, en cosinus de l'écart au droit devant : trois dixièmes
 * valent environ cent quarante-cinq degrés. C'est la valeur du jeu d'origine,
 * et elle suffit à ce qu'on puisse contourner une sentinelle sans être vu.
 */
const SIGHT_DOT = 0.3;

/** En deçà, la créature sent le joueur même dans son dos. */
const SENSE_RANGE = 80;

/** Un bruit récent dispense du regard, mais seulement à portée moyenne. */
const NOISE_MEMORY = 2;
const NOISE_RANGE = 500;

export interface EnemyWorld {
  collision: CollisionWorld;
  /** Deux points se voient-ils ? Sert à la perception des créatures. */
  isVisible(from: Vec3, to: Vec3): boolean;
}

export interface EnemyEvents {
  onPlayerHit(damage: number, from: Vec3): void;
  /** Transitions notables, pour les accompagner d'un son. */
  onSight?(enemy: Enemy): void;
  onAttack?(enemy: Enemy): void;
  onPain?(enemy: Enemy): void;
  onDeath?(enemy: Enemy): void;
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
  /**
   * Ce que chaque créature percevait à la dernière image.
   * Deviner la perception depuis l'extérieur ne marche pas : un tracé lancé
   * depuis le joueur ne part pas des mêmes hauteurs que le regard de la
   * créature, et conclut le contraire.
   */
  private readonly perception = new WeakMap<
    Enemy,
    { sees: boolean; inFront: boolean; noticed: boolean; distance: number }
  >();

  /** Temps écoulé depuis le début du niveau, pour dater les bruits. */
  private elapsed = 0;
  private lastNoise = -Infinity;
  private noiseOrigin: Vec3 | null = null;

  constructor(
    readonly enemies: Enemy[],
    private readonly world: EnemyWorld,
    private readonly events: EnemyEvents,
  ) {}

  /**
   * Signale un bruit fait par le joueur, un tir par exemple.
   *
   * Sans cela, le champ de vision ferait du niveau un parcours d'infiltration :
   * on pourrait vider son chargeur derrière une sentinelle sans qu'elle se
   * retourne. Le bruit ne réveille personne à lui seul, il dispense seulement
   * les créatures proches d'avoir le joueur droit devant.
   */
  hear(origin: Vec3): void {
    this.lastNoise = this.elapsed;
    this.noiseOrigin = [...origin] as Vec3;
  }

  /** Perception de la créature à la dernière image, pour la mise au point. */
  perceptionOf(enemy: Enemy): { sees: boolean; inFront: boolean; noticed: boolean; distance: number } | null {
    return this.perception.get(enemy) ?? null;
  }

  /** Le joueur est-il dans le champ de la créature ? */
  private inFront(enemy: Enemy, target: Vec3): boolean {
    const dx = target[0] - enemy.origin[0];
    const dy = target[1] - enemy.origin[1];
    const length = Math.hypot(dx, dy);
    if (length < 1e-3) return true;
    // Les créatures regardent à l'horizontale : le tangage ne compte pas.
    return (Math.cos(enemy.yaw) * dx + Math.sin(enemy.yaw) * dy) / length > SIGHT_DOT;
  }

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
      this.events.onDeath?.(enemy);
      return true;
    }
    this.events.onPain?.(enemy);
    return false;
  }

  update(deltaTime: number, playerPosition: Vec3): void {
    this.elapsed += deltaTime;

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

      // Repérer demande d'avoir le joueur devant soi ; le poursuivre, non.
      // Une créature lancée ne perd pas sa proie parce qu'elle tourne la tête,
      // et celle qu'on approche de trop près finit par sentir une présence.
      const noiseHeard =
        this.noiseOrigin !== null &&
        this.elapsed - this.lastNoise < NOISE_MEMORY &&
        Math.hypot(
          this.noiseOrigin[0] - enemy.origin[0],
          this.noiseOrigin[1] - enemy.origin[1],
          this.noiseOrigin[2] - enemy.origin[2],
        ) < NOISE_RANGE;
      const inFront = this.inFront(enemy, target);
      const notices = sees && (distance < SENSE_RANGE || noiseHeard || inFront);
      this.perception.set(enemy, { sees, inFront, noticed: notices, distance });

      switch (enemy.state) {
        case 'dormant':
          if (notices) {
            enemy.state = 'alerted';
            // Le cri d'éveil est la seule alerte quand la créature est hors champ.
            this.events.onSight?.(enemy);
          }
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
            this.events.onAttack?.(enemy);
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

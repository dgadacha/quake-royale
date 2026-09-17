import type { BspData } from '../../formats/bsp';
import type { Vec3 } from '../collision';

export type EnemyState = 'dormant' | 'alerted' | 'chasing' | 'attacking' | 'dying' | 'dead';

/**
 * Profil de comportement d'un adversaire.
 *
 * Les cartes ne décrivent que le nom et la position des créatures : tout ce
 * qui suit relève du jeu, pas des données, et se règle ici.
 */
export interface EnemyProfile {
  id: string;
  health: number;
  /** Vitesse de déplacement, en unités par seconde. */
  speed: number;
  /** Distance à laquelle la créature engage le combat. */
  attackRange: number;
  /** Distance au-delà de laquelle elle cesse de voir le joueur. */
  sightRange: number;
  damage: number;
  /** Temps entre deux attaques. */
  attackDelay: number;
  /** Demi-largeur et hauteur du gabarit. */
  radius: number;
  height: number;
  /** Teinte de la silhouette de substitution. */
  color: [number, number, number];
}

/**
 * Profils par défaut. Les valeurs sont volontairement lisibles et séparées du
 * reste : c'est ce qu'on ajuste en premier quand le combat ne va pas.
 */
export const enemyProfiles: Record<string, EnemyProfile> = {
  soldier: {
    id: 'soldier',
    health: 30,
    speed: 110,
    attackRange: 600,
    sightRange: 1400,
    damage: 9,
    attackDelay: 1.4,
    radius: 16,
    height: 56,
    color: [0.55, 0.52, 0.45],
  },
  hound: {
    id: 'hound',
    health: 25,
    speed: 220,
    // Une créature rapide combat au contact : elle doit rejoindre sa cible.
    attackRange: 60,
    sightRange: 1100,
    damage: 7,
    attackDelay: 0.9,
    radius: 16,
    height: 32,
    color: [0.42, 0.3, 0.24],
  },
  brute: {
    id: 'brute',
    health: 80,
    speed: 90,
    attackRange: 420,
    sightRange: 1300,
    damage: 16,
    attackDelay: 2,
    radius: 24,
    height: 72,
    color: [0.5, 0.36, 0.38],
  },
};

/**
 * Association entre le nom d'entité d'une carte et un profil.
 * Un nom inconnu reçoit le profil de base plutôt que d'être ignoré : mieux
 * vaut un adversaire générique qu'une carte vidée de ses occupants.
 */
export function profileFor(classname: string): EnemyProfile {
  if (/dog|hound|rott/.test(classname)) return enemyProfiles.hound;
  if (/ogre|shambler|demon|knight|zombie|fiend|boss/.test(classname)) return enemyProfiles.brute;
  return enemyProfiles.soldier;
}

export interface Enemy {
  profile: EnemyProfile;
  classname: string;
  origin: Vec3;
  /** Orientation courante, en radians. */
  yaw: number;
  health: number;
  state: EnemyState;
  /** Temps écoulé depuis la dernière attaque. */
  sinceAttack: number;
  /** Avancement de la chute, de 0 à 1. */
  deathProgress: number;
  velocity: Vec3;
  onGround: boolean;
  /** Dernière position connue de la cible, suivie quand elle disparaît. */
  lastSeen: Vec3 | null;
}

function parseVector(value: string | undefined): Vec3 | null {
  if (!value) return null;
  const parts = value.trim().split(/\s+/).map(Number);
  if (parts.length < 3 || parts.some(Number.isNaN)) return null;
  return [parts[0], parts[1], parts[2]];
}

export function collectEnemies(bsp: BspData): Enemy[] {
  const enemies: Enemy[] = [];

  for (const entity of bsp.entities) {
    const classname = entity.classname ?? '';
    if (!classname.startsWith('monster_')) continue;

    const origin = parseVector(entity.origin);
    if (!origin) continue;

    const profile = profileFor(classname);
    const angle = Number.parseFloat(entity.angle ?? '0');

    enemies.push({
      profile,
      classname,
      // Les créatures sont posées un peu au-dessus du sol dans les données.
      origin: [origin[0], origin[1], origin[2] + 1],
      yaw: (Number.isNaN(angle) ? 0 : angle) * (Math.PI / 180),
      health: profile.health,
      state: 'dormant',
      sinceAttack: 0,
      deathProgress: 0,
      velocity: [0, 0, 0],
      onGround: false,
      lastSeen: null,
    });
  }

  return enemies;
}

import shotgunUrl from '../../assets/shotgun.glb?url';
import superShotgunUrl from '../../assets/super_shotgun.glb?url';
import type { ViewmodelPose } from '../render/viewmodel';

export interface WeaponDefinition {
  id: string;
  name: string;
  /** Fichier du modèle tenu en main. */
  url: string;
  /** Placement à l'écran, propre à chaque arme. */
  pose: ViewmodelPose;
  /** Position de la bouche dans le repère du modèle normalisé. */
  muzzle: [number, number, number];
  damage: number;
  /** Nombre de projectiles par tir : au-delà de un, la gerbe se disperse. */
  pellets: number;
  /** Dispersion, en unités à cent de distance. */
  spread: number;
  /** Délai minimal entre deux tirs, en secondes. */
  cooldown: number;
  /** Force du recul ressenti. */
  recoil: number;
  /** Sons possibles au tir ; le premier présent est retenu. */
  fireSounds: string[];
}

/**
 * Armes disponibles.
 *
 * Chaque entrée porte à la fois son apparence et son comportement : c'est ce
 * qui permet d'en ajouter une sans toucher au reste du jeu. Les modèles sont
 * fournis à part et chargés à la demande, leur poids interdisant de tout
 * mettre en mémoire au démarrage.
 */
export const weapons: WeaponDefinition[] = [
  {
    id: 'shotgun',
    name: 'Fusil',
    url: shotgunUrl,
    pose: {
      position: [0, -0.225, -0.235],
      rotation: [0, -Math.PI / 2, 0],
      scale: 0.72,
    },
    muzzle: [-0.52, 0.055, 0],
    damage: 24,
    pellets: 6,
    spread: 14,
    cooldown: 0.62,
    recoil: 7.5,
    fireSounds: ['sound/weapons/sgun1.wav'],
  },
  {
    id: 'super_shotgun',
    name: 'Fusil à canon double',
    url: superShotgunUrl,
    // Un peu plus bas et plus court : l'arme est moins haute que la première.
    pose: {
      position: [0, -0.215, -0.24],
      rotation: [0, -Math.PI / 2, 0],
      scale: 0.7,
    },
    muzzle: [-0.52, 0.04, 0],
    damage: 22,
    pellets: 14,
    spread: 22,
    cooldown: 0.95,
    recoil: 12,
    fireSounds: ['sound/weapons/shotgn2.wav', 'sound/weapons/sgun1.wav'],
  },
];

export function weaponAt(index: number): WeaponDefinition {
  const count = weapons.length;
  return weapons[((index % count) + count) % count];
}

export function weaponIndex(id: string): number {
  const found = weapons.findIndex((weapon) => weapon.id === id);
  return found === -1 ? 0 : found;
}

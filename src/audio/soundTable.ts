import type { ImpactSurface } from '../render/decals';

/**
 * Événements sonores du jeu et fichiers correspondants.
 *
 * Les chemins désignent des fichiers de la copie du jeu de l'utilisateur,
 * montée localement : aucun n'est fourni ici. Plusieurs variantes par
 * événement évitent la répétition mécanique ; une entrée dont le fichier
 * manque reste silencieuse sans rien interrompre.
 */
export const soundTable = {
  weaponFire: ['sound/weapons/sgun1.wav'],
  weaponEmpty: ['sound/weapons/tink1.wav'],

  // Ricochets pour les matières dures, choc mat pour les autres.
  impact: {
    stone: ['sound/weapons/ric1.wav', 'sound/weapons/ric2.wav', 'sound/weapons/ric3.wav'],
    metal: ['sound/weapons/tink1.wav', 'sound/weapons/ric1.wav'],
    wood: ['sound/weapons/tink1.wav'],
    liquid: ['sound/misc/h2ohit1.wav'],
    flesh: ['sound/player/axhit1.wav', 'sound/player/axhit2.wav'],
  } satisfies Record<ImpactSurface, string[]>,

  playerLand: ['sound/player/land.wav', 'sound/player/land2.wav'],
  playerJump: ['sound/player/plyrjmp8.wav'],
  playerPain: [
    'sound/player/pain1.wav',
    'sound/player/pain2.wav',
    'sound/player/pain3.wav',
    'sound/player/pain4.wav',
    'sound/player/pain5.wav',
    'sound/player/pain6.wav',
  ],
  playerDeath: [
    'sound/player/death1.wav',
    'sound/player/death2.wav',
    'sound/player/death3.wav',
    'sound/player/death4.wav',
    'sound/player/death5.wav',
  ],
  playerEnterWater: ['sound/player/h2ojump.wav'],
  playerLeaveWater: ['sound/misc/outwater.wav'],
  underwater: ['sound/player/inh2o.wav'],

  doorOpen: ['sound/doors/medtry.wav', 'sound/doors/stndr1.wav', 'sound/doors/hydro1.wav'],
  doorClose: ['sound/doors/drclos4.wav', 'sound/doors/stndr2.wav', 'sound/doors/hydro2.wav'],
  platMove: ['sound/plats/medplat1.wav', 'sound/plats/plat1.wav'],
  platStop: ['sound/plats/medplat2.wav', 'sound/plats/plat2.wav'],
} as const;

/**
 * Sons propres à chaque créature.
 *
 * Les dossiers portent le nom de la créature et le même jeu de fichiers se
 * retrouve d'une à l'autre : la table se déduit donc du dossier, sans une
 * entrée par créature.
 */
const CREATURE_FOLDERS: Record<string, string> = {
  monster_army: 'soldier',
  monster_dog: 'dog',
  monster_enforcer: 'enforcer',
  monster_ogre: 'ogre',
  monster_ogre_marksman: 'ogre',
  monster_knight: 'knight',
  monster_hell_knight: 'hknight',
  monster_wizard: 'wizard',
  monster_demon1: 'demon',
  monster_shambler: 'shambler',
  monster_zombie: 'zombie',
  monster_tarbaby: 'blob',
  monster_fish: 'fish',
  monster_shalrath: 'shalrath',
  monster_boss: 'boss1',
  monster_oldone: 'boss2',
};

export type CreatureEvent = 'sight' | 'attack' | 'pain' | 'death' | 'idle';

/**
 * Noms de fichiers possibles pour un événement de créature.
 * Les conventions varient d'un dossier à l'autre, avec ou sans initiale du
 * nom de la créature : on propose donc plusieurs candidats et le premier
 * présent l'emporte.
 */
export function creatureSounds(classname: string, event: CreatureEvent): string[] {
  const folder = CREATURE_FOLDERS[classname];
  if (!folder) return [];
  const initial = folder[0];

  const names: Record<CreatureEvent, string[]> = {
    sight: ['sight1', 'sight', `${initial}sight`, `${initial}sight1`, 'idle1'],
    attack: ['sattck1', 'attack1', `${initial}attack1`, `${initial}attck1`, 'fire1'],
    pain: ['pain1', `${initial}pain1`, 'pain'],
    death: ['death1', `${initial}death`, `${initial}death1`, 'ddeath'],
    idle: ['idle', 'idle1', `${initial}idle`],
  };

  return names[event].map((name) => `sound/${folder}/${name}.wav`);
}

/** Tous les chemins cités, pour un préchargement au lancement d'une carte. */
export function allSoundPaths(classnames: string[]): string[] {
  const paths = new Set<string>();
  const add = (list: readonly string[]) => list.forEach((path) => paths.add(path));

  add(soundTable.weaponFire);
  add(soundTable.weaponEmpty);
  for (const list of Object.values(soundTable.impact)) add(list);
  add(soundTable.playerLand);
  add(soundTable.playerJump);
  add(soundTable.playerPain);
  add(soundTable.playerDeath);
  add(soundTable.playerEnterWater);
  add(soundTable.playerLeaveWater);
  add(soundTable.doorOpen);
  add(soundTable.doorClose);
  add(soundTable.platMove);
  add(soundTable.platStop);

  for (const classname of new Set(classnames)) {
    for (const event of ['sight', 'attack', 'pain', 'death'] as CreatureEvent[]) {
      add(creatureSounds(classname, event));
    }
  }

  return [...paths];
}

/** Tire une variante au sort dans une liste. */
export function pick(list: readonly string[]): string | null {
  if (list.length === 0) return null;
  return list[Math.floor(Math.random() * list.length)];
}

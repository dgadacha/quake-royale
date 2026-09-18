/**
 * Familles de matériaux et leurs propriétés physiques.
 *
 * Sans elles, toutes les surfaces reçoivent la même plage de rugosité et le
 * même relief : la pierre brille comme le métal, et le décor entier paraît
 * verni. C'est l'écart entre ces familles qui fait qu'un mur se distingue
 * d'une plaque d'acier.
 */
export type MaterialFamily =
  | 'stone'
  | 'brick'
  | 'concrete'
  | 'wood'
  | 'floor'
  | 'paintedMetal'
  | 'bareMetal'
  | 'tech'
  | 'liquid'
  | 'organic';

export interface MaterialProfile {
  family: MaterialFamily;
  /** Bornes de rugosité : le détail de la texture module à l'intérieur. */
  roughnessMin: number;
  roughnessMax: number;
  /** Amplitude du relief déduit de la texture. */
  normalScale: number;
  metalness: number;
  /** Part de reflet spéculaire admise. */
  specular: number;
  /**
   * Force du modelé que le relief imprime à l'éclairage diffus.
   * C'est lui qui fait ressortir les rivets : au-delà du raisonnable, la
   * moindre aspérité se met à sculpter la surface comme un bas-relief.
   */
  relief: number;
  /**
   * Part de la surface qui peut porter des traces humides.
   * Réservée aux sols : ailleurs, l'humidité uniforme donne le vernis.
   */
  wetness: number;
}

/**
 * Valeurs choisies pour que les familles se distinguent nettement.
 * Les rugosités basses, en dessous de trois dixièmes, sont réservées à ce qui
 * est réellement poli ou mouillé.
 */
export const materialProfiles: Record<MaterialFamily, MaterialProfile> = {
  stone: {
    family: 'stone',
    roughnessMin: 0.82,
    roughnessMax: 0.96,
    normalScale: 0.38,
    metalness: 0,
    specular: 0.16,
    relief: 0.5,
    wetness: 0,
  },
  brick: {
    family: 'brick',
    roughnessMin: 0.8,
    roughnessMax: 0.94,
    // Les joints creusés donnent déjà du relief : inutile d'en rajouter.
    normalScale: 0.44,
    metalness: 0,
    specular: 0.15,
    relief: 0.55,
    wetness: 0,
  },
  // Les panneaux des bases militaires : du béton peint, pas de la tôle.
  // Ils couvrent l'essentiel du premier épisode, d'où leur importance.
  concrete: {
    family: 'concrete',
    roughnessMin: 0.76,
    roughnessMax: 0.93,
    normalScale: 0.32,
    metalness: 0,
    specular: 0.2,
    relief: 0.45,
    wetness: 0,
  },
  wood: {
    family: 'wood',
    roughnessMin: 0.7,
    roughnessMax: 0.9,
    normalScale: 0.45,
    metalness: 0,
    specular: 0.24,
    relief: 0.5,
    wetness: 0,
  },
  // Un sol est piétiné, donc mat, mais garde des flaques par endroits.
  floor: {
    family: 'floor',
    roughnessMin: 0.62,
    roughnessMax: 0.93,
    normalScale: 0.34,
    metalness: 0,
    specular: 0.3,
    relief: 0.4,
    wetness: 0.38,
  },
  paintedMetal: {
    family: 'paintedMetal',
    roughnessMin: 0.48,
    roughnessMax: 0.72,
    normalScale: 0.5,
    metalness: 0.2,
    specular: 0.5,
    relief: 0.7,
    wetness: 0,
  },
  bareMetal: {
    family: 'bareMetal',
    roughnessMin: 0.3,
    roughnessMax: 0.54,
    normalScale: 0.58,
    metalness: 0.7,
    specular: 0.85,
    relief: 0.8,
    wetness: 0,
  },
  tech: {
    family: 'tech',
    roughnessMin: 0.36,
    roughnessMax: 0.62,
    normalScale: 0.4,
    metalness: 0.28,
    specular: 0.55,
    relief: 0.6,
    wetness: 0,
  },
  liquid: {
    family: 'liquid',
    roughnessMin: 0.06,
    roughnessMax: 0.22,
    normalScale: 0.4,
    metalness: 0.1,
    specular: 1,
    relief: 0.5,
    wetness: 1,
  },
  organic: {
    family: 'organic',
    roughnessMin: 0.62,
    roughnessMax: 0.88,
    normalScale: 0.45,
    metalness: 0,
    specular: 0.3,
    relief: 0.55,
    wetness: 0,
  },
};

/**
 * Préfixes réels relevés dans les cartes d'origine, famille par famille.
 *
 * Deviner la matière à partir de mots courants ne marche pas ici : « tech »
 * désigne des murs de béton, « cop » de la pierre de château, et « light »
 * un panneau lumineux. Le classement suit donc le vocabulaire des cartes,
 * pas le sens ordinaire des mots.
 */
const familyPrefixes: [MaterialFamily, string[]][] = [
  [
    'organic',
    ['bodies', 'flesh', 'meat', 'blood', 'organ', 'skin', 'bodi'],
  ],
  [
    'wood',
    ['wood', 'wizwood', 'woodflr', 'crate', 'plank', 'barrel', 'timber', 'dem'],
  ],
  [
    // Écrans, cadrans et panneaux lumineux : les seules surfaces réellement
    // technologiques, et elles occupent peu de place.
    'tech',
    [
      'comp',
      'tlight',
      'light',
      'screen',
      'monitor',
      'dig',
      'planet',
      'skill',
      'exit',
      'z_exit',
      'slip',
      'sym',
    ],
  ],
  [
    'bareMetal',
    [
      'grate',
      'grill',
      'grill2',
      'fence',
      'vent',
      'pipe',
      'duct',
      'girder',
      'chain',
      'cable',
      'rust',
      'lgmetal',
    ],
  ],
  [
    'floor',
    ['floor', 'sfloor', 'afloor', 'ground', 'wgrnd', 'metflor', 'plat_top', 'sflor'],
  ],
  [
    'paintedMetal',
    [
      'metal',
      'metalt',
      'mmetal',
      'nmetal',
      'wmet',
      'wizmet',
      'met5',
      'door',
      'adoor',
      'dr0',
      'elev',
      'trim',
      'shoot',
      'mtlsw',
      'mswtch',
      'floorsw',
      'butn',
      'butnn',
      'button',
      'basebtn',
      'key',
      'wkey',
      'nail',
      'shot',
      'edoor',
      'switch',
      'basebutn',
      'wswitch',
      'batt',
      'med',
      '_med',
      '_box',
      'plat',
    ],
  ],
  ['brick', ['brick', 'wbrick', 'bricka', 'cbrick']],
  [
    // Les panneaux de base : murs, plafonds et cloisons de béton peint.
    'concrete',
    ['tech', 'twall', 'uwall', 'azwall', 'elwall', 'wall', 'ceil', 'ceiling', 'wceiling'],
  ],
  [
    'stone',
    [
      'city',
      'cop',
      'ecop',
      'grave',
      'rune',
      'dung',
      'altar',
      'altarb',
      'church',
      'column',
      'carch',
      'rock',
      'stone',
      'wiz',
      'wswamp',
      'window',
      'arch',
      'm5',
      'ktower',
      'quake',
    ],
  ],
];

/**
 * Retire les marques d'animation et de transparence qui précèdent le nom.
 * Seules les textures animées portent un numéro de trame après le signe,
 * et lui seul doit sauter : ailleurs, la première lettre fait partie du nom.
 */
function baseName(name: string): string {
  const lower = name.toLowerCase();
  if (lower.startsWith('+')) return lower.slice(1).replace(/^[0-9a]/, '');
  if (lower.startsWith('{') || lower.startsWith('*')) return lower.slice(1);
  return lower;
}

/**
 * Famille déduite du nom de la texture.
 *
 * C'est la seule information disponible : une carte ne décrit pas la matière
 * de ses surfaces. Les préfixes les plus longs gagnent, pour que « metflor »
 * ne se fasse pas prendre pour « met ».
 */
export function familyFromName(name: string): MaterialFamily {
  const lower = name.toLowerCase();

  // Les liquides se reconnaissent à leur marque de tête.
  if (lower.startsWith('*') || /water|slime|lava|tele/.test(lower)) return 'liquid';

  const base = baseName(name);

  let best: MaterialFamily = 'stone';
  let bestLength = 0;
  for (const [family, prefixes] of familyPrefixes) {
    for (const prefix of prefixes) {
      if (base.startsWith(prefix) && prefix.length > bestLength) {
        best = family;
        bestLength = prefix.length;
      }
    }
  }

  // Le reste est traité comme de la pierre : c'est la matière dominante.
  return bestLength > 0 ? best : 'stone';
}

export function profileFor(name: string): MaterialProfile {
  return materialProfiles[familyFromName(name)];
}

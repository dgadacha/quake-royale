import type { MdlModel } from '../formats/mdl';

export type AnimationKind = 'idle' | 'walk' | 'run' | 'attack' | 'pain' | 'death';

export interface AnimationRange {
  kind: AnimationKind;
  first: number;
  count: number;
  /** Images par seconde, propre à la nature du mouvement. */
  fps: number;
  /** Une mort ne boucle pas : elle se fige sur sa dernière image. */
  loop: boolean;
}

/**
 * Vitesses par nature de mouvement. Une marche lente et une attaque vive ne
 * se lisent pas au même rythme, et les fichiers ne portent pas cette
 * information.
 */
const SPEEDS: Record<AnimationKind, number> = {
  idle: 5,
  walk: 8,
  run: 12,
  attack: 10,
  pain: 12,
  death: 10,
};

/**
 * Reconnaît la nature d'une image d'après son nom.
 * Les noms suivent une convention lisible, un préfixe suivi d'un numéro, ce
 * qui permet de retrouver les séquences sans table propre à chaque créature.
 */
function kindFromName(name: string): AnimationKind | null {
  const lower = name.toLowerCase();
  if (/^(death|die|deth)/.test(lower)) return 'death';
  if (/^pain/.test(lower)) return 'pain';
  if (/^(attack|shoot|atk|fire|magic|smash|swing|charge|fight)/.test(lower)) return 'attack';
  if (/^(run|leap|jump)/.test(lower)) return 'run';
  if (/^(walk|move|slide|pace)/.test(lower)) return 'walk';
  if (/^(stand|idle|wait|look|crucified|paus)/.test(lower)) return 'idle';
  return null;
}

/**
 * Découpe les images d'un modèle en séquences jouables.
 *
 * Les images d'un même mouvement se suivent : on regroupe donc les images
 * consécutives de même nature, et on ne retient que la plus longue séquence
 * de chaque sorte, les autres étant le plus souvent des variantes.
 */
export function detectAnimations(model: MdlModel): Map<AnimationKind, AnimationRange> {
  const ranges = new Map<AnimationKind, AnimationRange>();
  if (model.frames.length === 0) return ranges;

  let currentKind: AnimationKind | null = null;
  let start = 0;

  const flush = (end: number) => {
    if (currentKind === null) return;
    const count = end - start;
    if (count <= 0) return;
    const existing = ranges.get(currentKind);
    if (!existing || count > existing.count) {
      ranges.set(currentKind, {
        kind: currentKind,
        first: start,
        count,
        fps: SPEEDS[currentKind],
        loop: currentKind !== 'death',
      });
    }
  };

  model.frames.forEach((frame, index) => {
    const kind = kindFromName(frame.name);
    if (kind !== currentKind) {
      flush(index);
      currentKind = kind;
      start = index;
    }
  });
  flush(model.frames.length);

  // Sans image au repos identifiable, la première fait l'affaire : un modèle
  // figé sur une pose de combat serait pire.
  if (!ranges.has('idle')) {
    ranges.set('idle', { kind: 'idle', first: 0, count: 1, fps: 1, loop: true });
  }
  return ranges;
}

/** Séquence à jouer pour un état de créature, avec repli sur ce qui existe. */
export function rangeForState(
  ranges: Map<AnimationKind, AnimationRange>,
  wanted: AnimationKind[],
): AnimationRange {
  for (const kind of wanted) {
    const range = ranges.get(kind);
    if (range) return range;
  }
  return ranges.get('idle')!;
}

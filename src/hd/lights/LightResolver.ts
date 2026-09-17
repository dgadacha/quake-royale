import * as THREE from 'three';
import type { BspEntity } from '../../formats/bsp';
import type { Vec3 } from '../../game/collision';

/**
 * Importance d'une source, qui décide de ce qu'on lui accorde.
 * Une carte peut compter des centaines de lumières : toutes ne méritent pas
 * d'être calculées à chaque image, encore moins de projeter des ombres.
 */
export type LightCategory = 'primary' | 'secondary' | 'decorative';

export interface HDLight {
  position: Vec3;
  color: THREE.Color;
  /** Intensité relative, 1 correspondant à une source ordinaire. */
  intensity: number;
  radius: number;
  category: LightCategory;
  /** Style d'animation du niveau, 0 pour une lumière fixe. */
  style: number;
  classname: string;
}

/**
 * Températures par nature de source. Une carte dont toutes les lumières ont
 * la même couleur paraît morte : c'est l'écart entre une torche et un tube
 * fluorescent qui donne sa lecture à un lieu.
 */
const TEMPERATURES: { match: RegExp; color: [number, number, number]; category?: LightCategory }[] = [
  { match: /torch|flame|fire/, color: [1.0, 0.72, 0.38] },
  { match: /fluoro|fluor/, color: [0.82, 0.9, 1.0] },
  { match: /lava/, color: [1.0, 0.48, 0.18], category: 'primary' },
  { match: /slime/, color: [0.62, 1.0, 0.55] },
  { match: /tele/, color: [0.72, 0.6, 1.0] },
  { match: /rune|altar|demon/, color: [1.0, 0.32, 0.26] },
];

const DEFAULT_COLOR: [number, number, number] = [1.0, 0.94, 0.86];

function parseVector(value: string | undefined): Vec3 | null {
  if (!value) return null;
  const parts = value.trim().split(/\s+/).map(Number);
  if (parts.length < 3 || parts.some(Number.isNaN)) return null;
  return [parts[0], parts[1], parts[2]];
}

/** Couleur déclarée par l'entité, exprimée en 0-1 ou en 0-255 selon l'outil. */
function explicitColor(entity: BspEntity): THREE.Color | null {
  const parsed = parseVector(entity._color ?? entity.color ?? entity._light_color);
  if (!parsed) return null;
  const scale = Math.max(...parsed) > 1.01 ? 1 / 255 : 1;
  return new THREE.Color(parsed[0] * scale, parsed[1] * scale, parsed[2] * scale);
}

function temperatureFor(classname: string): { color: THREE.Color; category?: LightCategory } {
  for (const entry of TEMPERATURES) {
    if (entry.match.test(classname)) {
      return { color: new THREE.Color(...entry.color), category: entry.category };
    }
  }
  return { color: new THREE.Color(...DEFAULT_COLOR) };
}

/**
 * Convertit les entités d'éclairage d'une carte en sources exploitables.
 * Le lecteur de niveaux n'est pas touché : il ne fait que livrer ses entités.
 */
export function resolveLights(entities: BspEntity[]): HDLight[] {
  const lights: HDLight[] = [];

  for (const entity of entities) {
    const classname = entity.classname ?? '';
    if (!classname.startsWith('light')) continue;

    const position = parseVector(entity.origin);
    if (!position) continue;

    const declared = Number.parseFloat(entity.light ?? entity._light ?? '300');
    const value = Number.isNaN(declared) ? 300 : declared;

    const temperature = temperatureFor(classname);
    const color = explicitColor(entity) ?? temperature.color;

    const style = Number.parseInt(entity.style ?? '0', 10);

    // Une source puissante porte la lecture de la salle, une petite ne fait
    // qu'accompagner : l'écart d'intensité décide du budget qu'on lui donne.
    const category: LightCategory =
      temperature.category ?? (value >= 300 ? 'primary' : value >= 150 ? 'secondary' : 'decorative');

    lights.push({
      position,
      color,
      intensity: Math.min(2.2, value / 300),
      // La portée d'origine est proportionnelle à l'intensité déclarée.
      radius: Math.max(160, value * 1.9),
      category,
      style: Number.isNaN(style) ? 0 : style,
      classname,
    });
  }

  return lights;
}

/** Sources émises par les surfaces liquides ou lumineuses d'une carte. */
export function lightFromSurface(
  position: Vec3,
  kind: 'lava' | 'slime' | 'teleport',
  radius: number,
): HDLight {
  const temperature = temperatureFor(kind);
  return {
    position,
    color: temperature.color,
    intensity: kind === 'lava' ? 1.1 : 0.75,
    radius,
    category: 'secondary',
    style: 0,
    classname: kind,
  };
}

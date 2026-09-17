import * as THREE from 'three';
import { parseBsp, type BspEntity } from '../formats/bsp';
import { Palette } from '../formats/palette';
import type { VirtualFileSystem } from '../formats/pak';
import { buildWorld, type WorldOptions } from '../render/world';
import { BspCollision, HULL_POINT, type CollisionWorld, type Vec3 } from './collision';
import { buildDemoMap } from './demoMap';
import { placeEntities, type EntityModelMap } from './entityModels';
import { resolveLights, type HDLight } from '../hd/lights/LightResolver';

/** Ce qu'une carte doit fournir, qu'elle vienne d'un fichier ou du code. */
export interface Level {
  name: string;
  root: THREE.Group;
  collision: CollisionWorld;
  spawn: Vec3;
  spawnYaw: number;
  entities: BspEntity[];
  setFlashlight(position: THREE.Vector3, color: THREE.Color, radius: number): void;
  /** Éclairage estimé à un point, pour accorder l'arme tenue au décor. */
  sampleLighting(position: Vec3): LightingSample;
  /** Sources dynamiques de la carte. */
  hdLights: HDLight[];
  setDynamicLights(count: number, diffuse: number, specular: number): void;
  setShadow(
    map: THREE.Texture,
    matrix: THREE.Matrix4,
    view: THREE.Matrix4,
    strength: number,
    texel: number,
  ): void;
  styleIntensity(style: number): number;
  /** Deux points se voient-ils, sans mur entre eux ? */
  isVisible(from: Vec3, to: Vec3): boolean;
  update(time: number): void;
  dispose(): void;
  stats: { faces: number; draws: number; textures: number; lightmapPages: number; entities?: number };
}

function parseVector(value: string | undefined): Vec3 | null {
  if (!value) return null;
  const parts = value.trim().split(/\s+/).map(Number);
  if (parts.length < 3 || parts.some(Number.isNaN)) return null;
  return [parts[0], parts[1], parts[2]];
}

/** Point de départ du joueur, avec repli au centre de la carte. */
function findSpawn(entities: BspEntity[]): { origin: Vec3; yaw: number } {
  const preferred = ['info_player_start', 'info_player_deathmatch', 'info_player_coop'];
  for (const classname of preferred) {
    const entity = entities.find((item) => item.classname === classname);
    const origin = parseVector(entity?.origin);
    if (origin) {
      const angle = Number.parseFloat(entity?.angle ?? '0');
      return {
        origin: [origin[0], origin[1], origin[2] + 8],
        yaw: (Number.isNaN(angle) ? 0 : angle) * (Math.PI / 180),
      };
    }
  }
  return { origin: [0, 0, 64], yaw: 0 };
}

interface PointLight {
  position: Vec3;
  radius: number;
  intensity: number;
  color: THREE.Color;
}

/**
 * Éclairage reçu en un point : sa force, la direction d'où il vient et sa
 * teinte. L'arme tenue en main ne peut pas s'accorder au décor sans ces trois
 * informations ; la seule intensité laisse une lumière qui tombe toujours du
 * même côté, quelle que soit la disposition réelle du niveau.
 */
export interface LightingSample {
  intensity: number;
  /** Direction du point vers la lumière dominante, dans le repère du jeu. */
  direction: Vec3;
  color: THREE.Color;
}

/**
 * Les entités d'éclairage donnent une bonne approximation de l'éclairage d'un
 * point, sans avoir à relire l'atlas de lightmaps image par image.
 */
export function lightingSampler(lights: PointLight[]): (position: Vec3) => LightingSample {
  const fallback = (): LightingSample => ({
    intensity: 0.4,
    direction: [0, 0, 1],
    color: new THREE.Color(1, 0.96, 0.9),
  });
  if (lights.length === 0) return fallback;

  return (position: Vec3) => {
    let total = 0;
    const direction: Vec3 = [0, 0, 0];
    const color = new THREE.Color(0, 0, 0);

    for (const light of lights) {
      const dx = light.position[0] - position[0];
      const dy = light.position[1] - position[1];
      const dz = light.position[2] - position[2];
      const distance = Math.hypot(dx, dy, dz);
      if (distance >= light.radius || distance < 1e-3) continue;

      const contribution = light.intensity * Math.pow(1 - distance / light.radius, 1.5);
      total += contribution;
      direction[0] += (dx / distance) * contribution;
      direction[1] += (dy / distance) * contribution;
      direction[2] += (dz / distance) * contribution;
      color.r += light.color.r * contribution;
      color.g += light.color.g * contribution;
      color.b += light.color.b * contribution;
    }

    if (total <= 1e-4) return fallback();

    const length = Math.hypot(direction[0], direction[1], direction[2]);
    const unit: Vec3 =
      length > 1e-4
        ? [direction[0] / length, direction[1] / length, direction[2] / length]
        : [0, 0, 1];
    color.multiplyScalar(1 / total);

    return { intensity: Math.min(1, total), direction: unit, color };
  };
}

/** Teinte d'une entité d'éclairage, exprimée en 0-1 ou en 0-255 selon l'outil. */
function parseLightColor(entity: BspEntity): THREE.Color {
  const raw = entity._color ?? entity.color ?? entity._light_color;
  const parsed = parseVector(raw);
  if (!parsed) return new THREE.Color(1, 0.95, 0.88);
  const scale = Math.max(...parsed) > 1.01 ? 1 / 255 : 1;
  return new THREE.Color(parsed[0] * scale, parsed[1] * scale, parsed[2] * scale);
}

function lightsFromEntities(entities: BspEntity[]): PointLight[] {
  const lights: PointLight[] = [];
  for (const entity of entities) {
    if (!entity.classname.startsWith('light')) continue;
    const origin = parseVector(entity.origin);
    if (!origin) continue;
    const value = Number.parseFloat(entity.light ?? entity._light ?? '300');
    const intensity = Number.isNaN(value) ? 300 : value;
    lights.push({
      position: origin,
      radius: Math.max(120, intensity * 1.7),
      intensity: 0.85,
      color: parseLightColor(entity),
    });
  }
  return lights;
}

export function loadBspLevel(
  vfs: VirtualFileSystem,
  path: string,
  options: WorldOptions,
  entityModels: EntityModelMap = {},
): Level {
  const data = vfs.readOrThrow(path);
  const bsp = parseBsp(data);

  const paletteData = vfs.read('gfx/palette.lmp');
  const palette = paletteData ? new Palette(paletteData) : Palette.fallback();

  const world = buildWorld(bsp, palette, options);
  const collision = new BspCollision(bsp);
  const spawn = findSpawn(bsp.entities);

  const sampleLighting = lightingSampler(lightsFromEntities(bsp.entities));
  const pointTrace = collision.world(0, HULL_POINT);

  const { group, placed } = placeEntities(bsp.entities, vfs, palette, entityModels, {
    anisotropy: options.anisotropy,
    ambient: options.ambient,
    fogColor: options.fogColor,
    fogDensity: options.fogDensity,
    lightScale: options.lightScale,
    emissiveStrength: options.emissiveStrength,
  });
  world.root.add(group);

  return {
    name: path,
    root: world.root,
    collision: collision.world(0),
    spawn: spawn.origin,
    spawnYaw: spawn.yaw,
    entities: bsp.entities,
    setFlashlight(position, color, radius) {
      world.setFlashlight(position, color, radius);
      for (const entity of placed) entity.model.setFlashlight(position, color, radius);
    },
    sampleLighting,
    // Entités d'éclairage et surfaces émettrices alimentent la même liste.
    hdLights: [...resolveLights(bsp.entities), ...world.surfaceLights],
    isVisible: (from, to) => {
      // Gabarit ponctuel : on suit un rayon de lumière, pas un joueur.
      const trace = pointTrace.trace(from, to);
      return trace.fraction >= 0.999;
    },
    setDynamicLights: world.setDynamicLights,
    setShadow: world.setShadow,
    styleIntensity: world.styleIntensity,
    update(time) {
      world.update(time);
      for (const entity of placed) entity.model.animate(time, entity.fps);
    },
    dispose() {
      for (const entity of placed) entity.model.dispose();
      world.dispose();
    },
    stats: { ...world.stats, entities: placed.length },
  };
}

export function loadDemoLevel(options: WorldOptions): Level {
  const demo = buildDemoMap(options);
  return {
    name: 'arène de démonstration',
    root: demo.root,
    collision: demo.collision,
    spawn: demo.spawn,
    spawnYaw: demo.spawnYaw,
    entities: [],
    setFlashlight: demo.setFlashlight,
    sampleLighting: demo.sampleLighting,
    hdLights: demo.hdLights,
    isVisible: demo.isVisible,
    setDynamicLights: demo.setDynamicLights,
    setShadow: demo.setShadow,
    styleIntensity: demo.styleIntensity,
    update: demo.update,
    dispose: demo.dispose,
    stats: demo.stats,
  };
}

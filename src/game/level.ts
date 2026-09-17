import * as THREE from 'three';
import { parseBsp, type BspEntity } from '../formats/bsp';
import { Palette } from '../formats/palette';
import type { VirtualFileSystem } from '../formats/pak';
import { buildWorld, type WorldOptions } from '../render/world';
import { BspCollision, type CollisionWorld, type Vec3 } from './collision';
import { buildDemoMap } from './demoMap';
import { placeEntities, type EntityModelMap } from './entityModels';

/** Ce qu'une carte doit fournir, qu'elle vienne d'un fichier ou du code. */
export interface Level {
  name: string;
  root: THREE.Group;
  collision: CollisionWorld;
  spawn: Vec3;
  spawnYaw: number;
  entities: BspEntity[];
  setFlashlight(position: THREE.Vector3, color: THREE.Color, radius: number): void;
  /** Clarté estimée à un point, entre 0 et 1, pour accorder l'arme au décor. */
  sampleBrightness(position: Vec3): number;
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
}

/**
 * Les entités d'éclairage donnent une bonne approximation de la clarté d'un
 * point, sans avoir à relire l'atlas de lightmaps image par image.
 */
function brightnessSampler(lights: PointLight[]): (position: Vec3) => number {
  if (lights.length === 0) return () => 0.4;
  return (position: Vec3) => {
    let total = 0;
    for (const light of lights) {
      const distance = Math.hypot(
        light.position[0] - position[0],
        light.position[1] - position[1],
        light.position[2] - position[2],
      );
      if (distance >= light.radius) continue;
      total += light.intensity * Math.pow(1 - distance / light.radius, 1.5);
      if (total >= 1) return 1;
    }
    return Math.min(1, total);
  };
}

function lightsFromEntities(entities: BspEntity[]): PointLight[] {
  const lights: PointLight[] = [];
  for (const entity of entities) {
    if (!entity.classname.startsWith('light')) continue;
    const origin = parseVector(entity.origin);
    if (!origin) continue;
    const value = Number.parseFloat(entity.light ?? entity._light ?? '300');
    const intensity = Number.isNaN(value) ? 300 : value;
    lights.push({ position: origin, radius: Math.max(120, intensity * 1.7), intensity: 0.85 });
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

  const sampleBrightness = brightnessSampler(lightsFromEntities(bsp.entities));

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
    sampleBrightness,
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
    sampleBrightness: demo.sampleBrightness,
    update: demo.update,
    dispose: demo.dispose,
    stats: demo.stats,
  };
}

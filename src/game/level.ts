import * as THREE from 'three';
import { parseBsp, type BspEntity } from '../formats/bsp';
import { Palette } from '../formats/palette';
import type { VirtualFileSystem } from '../formats/pak';
import { buildWorld, quakeToThree, type WorldOptions } from '../render/world';
import { BspCollision, HULL_POINT, type CollisionWorld, type Vec3 } from './collision';
import { buildDemoMap } from './demoMap';
import { placeEntities, type EntityModelMap } from './entityModels';
import { resolveLights, type HDLight } from '../hd/lights/LightResolver';
import { buildFaceLeafIndex, VisibilitySet } from '../render/pvs';
import { DecalPool } from '../render/decals';
import { ImpactParticles } from '../render/impactParticles';
import { surfaceAt } from './entities/SurfaceProbe';
import { collectEnemies } from './entities/Enemy';
import { EnemyManager } from './entities/EnemyManager';
import { EnemyRenderer } from '../render/enemyRenderer';
import { fireRay } from './entities/Combat';
import { collectMovers } from './entities/BrushEntity';
import { MoverManager } from './entities/MoverManager';
import { MoverCollision } from './entities/MoverCollision';

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
  /** Anime les portes et plateformes ; sans effet sur une carte qui n'en a pas. */
  updateEntities(deltaTime: number, playerPosition: Vec3): void;
  /** État des volumes mobiles, pour la mise au point. */
  moverStates(): { kind: string; state: string; progress: number; center: Vec3 }[];
  /** Fait vivre les adversaires ; renvoie les dégâts infligés au joueur. */
  updateEnemies(deltaTime: number, playerPosition: Vec3): number;
  /** Tir instantané depuis un point ; renvoie le point d'impact. */
  fire(origin: Vec3, direction: Vec3, damage: number): { point: Vec3; hit: boolean; killed: boolean };
  enemyInfo(): { total: number; alive: number; awake: number };
  /** Marques et éclats actuellement à l'écran. */
  effectsInfo(): { decals: number; particles: number };
  /** Détail des adversaires, pour la mise au point. */
  enemyStates(): { kind: string; state: string; health: number; origin: Vec3 }[];
  /** Restreint le dessin à ce qui est visible depuis un point. */
  updateVisibility(playerPosition: Vec3): void;
  visibilityInfo(): { leaf: number; drawn: number; total: number; enabled: boolean };
  setVisibilityEnabled(enabled: boolean): void;
  update(time: number): void;
  dispose(): void;
  stats: {
    faces: number;
    draws: number;
    textures: number;
    lightmapPages: number;
    entities?: number;
    /** Faces écartées du rendu : volumes de déclenchement et de service. */
    hiddenFaces?: number;
    /** Vrai quand aucune palette n'est montée : les teintes sont inventées. */
    paletteMissing?: boolean;
    /** Portes, plateformes et boutons animés. */
    movers?: number;
    enemies?: number;
  };
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

  // Sans palette, les index des textures ne peuvent pas être convertis en
  // couleurs justes : le rendu reste lisible mais les teintes sont inventées.
  const paletteData = vfs.read('gfx/palette.lmp');
  const palette = paletteData ? new Palette(paletteData) : Palette.fallback();
  const paletteMissing = !paletteData;

  const world = buildWorld(bsp, palette, options);
  const collision = new BspCollision(bsp);
  const spawn = findSpawn(bsp.entities);

  const sampleLighting = lightingSampler(lightsFromEntities(bsp.entities));
  const pointTrace = collision.world(0, HULL_POINT);

  // Portes, plateformes et boutons : leur géométrie est déjà construite à sa
  // position fermée, il reste à la déplacer et à la rendre solide.
  // Visibilité précalculée : la carte sait déjà ce qu'on peut apercevoir
  // depuis chaque endroit, il suffit de s'en servir.
  const visibility = new VisibilitySet(bsp);
  const faceLeafs = buildFaceLeafIndex(bsp);
  const visibleFaces = new Uint8Array(bsp.faces.length);
  let currentLeaf = -1;
  let visibilityEnabled = visibility.hasData;
  void faceLeafs;

  // Adversaires : la carte donne leur nom et leur position, le comportement
  // vient du jeu.
  const enemies = collectEnemies(bsp);
  let pendingDamage = 0;
  const enemyManager = new EnemyManager(
    enemies,
    {
      collision: collision.world(0),
      isVisible: (from, to) => collision.world(0, HULL_POINT).trace(from, to).fraction >= 0.999,
    },
    { onPlayerHit: (damage) => { pendingDamage += damage; } },
  );
  const enemyRenderer = new EnemyRenderer(enemies);

  // Traces laissées par les tirs et éclats projetés à l'impact.
  const decals = new DecalPool();
  const particles = new ImpactParticles();

  const movers = collectMovers(bsp);
  const moverManager = new MoverManager(movers);
  const playerCollision = movers.length
    ? new MoverCollision(collision.world(0), collision, movers)
    : collision.world(0);

  const { group, placed } = placeEntities(bsp.entities, vfs, palette, entityModels, {
    anisotropy: options.anisotropy,
    ambient: options.ambient,
    fogColor: options.fogColor,
    fogDensity: options.fogDensity,
    lightScale: options.lightScale,
    emissiveStrength: options.emissiveStrength,
  });
  world.root.add(group);
  world.root.add(enemyRenderer.root);
  world.root.add(decals.mesh);
  world.root.add(particles.points);

  return {
    name: path,
    root: world.root,
    collision: playerCollision,
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
    updateEntities(deltaTime, playerPosition) {
      if (movers.length === 0) return;
      moverManager.update(deltaTime, playerPosition);
      for (const mover of movers) {
        const group = world.models[mover.modelIndex];
        if (!group) continue;
        const [x, y, z] = quakeToThree(mover.offset[0], mover.offset[1], mover.offset[2]);
        group.position.set(x, y, z);
      }
    },
    updateEnemies(deltaTime, playerPosition) {
      decals.update(deltaTime);
      particles.update(deltaTime);
      if (enemies.length === 0) return 0;
      enemyManager.update(deltaTime, playerPosition);
      enemyRenderer.update();
      const damage = pendingDamage;
      pendingDamage = 0;
      return damage;
    },
    fire(origin, direction, damage) {
      const result = fireRay(
        playerCollision,
        enemies,
        origin,
        direction,
        4000,
        damage,
        (enemy, amount) => enemyManager.damage(enemy, amount),
      );

      const point = new THREE.Vector3(
        ...quakeToThree(result.point[0], result.point[1], result.point[2]),
      );
      const normal = new THREE.Vector3(
        ...quakeToThree(result.normal[0], result.normal[1], result.normal[2]),
      ).normalize();

      if (result.enemy) {
        // Une créature ne garde pas de marque : seuls les éclats la signalent.
        particles.burst(point, normal, 'flesh');
      } else {
        const surface = surfaceAt(bsp, visibility, result.point, result.normal);
        // Un liquide avale la marque, il n'en reste que la gerbe.
        if (surface !== 'liquid') decals.add(point, normal, 5.5);
        particles.burst(point, normal, surface);
      }

      return { point: result.point, hit: result.enemy !== null, killed: result.killed };
    },
    enemyStates: () =>
      enemies.map((enemy) => ({
        kind: enemy.profile.id,
        state: enemy.state,
        health: enemy.health,
        origin: [...enemy.origin] as Vec3,
      })),
    enemyInfo: () => ({
      total: enemies.length,
      alive: enemyManager.aliveCount,
      awake: enemyManager.awakeCount,
    }),
    updateVisibility(playerPosition) {
      if (!visibilityEnabled) return;

      const leaf = visibility.findLeaf(playerPosition);
      // Rien ne change tant qu'on reste dans la même feuille : inutile de
      // reconstruire les index à chaque image.
      if (leaf === currentLeaf) return;
      currentLeaf = leaf;

      const set = visibility.visibleFrom(leaf);
      visibleFaces.fill(0);
      for (let index = 1; index < bsp.leafs.length; index++) {
        if (!VisibilitySet.isVisible(set, index)) continue;
        const candidate = bsp.leafs[index];
        for (let i = 0; i < candidate.markSurfaceCount; i++) {
          visibleFaces[bsp.markSurfaces[candidate.firstMarkSurface + i]] = 1;
        }
      }
      world.setVisibleFaces(visibleFaces);
    },
    visibilityInfo: () => ({
      leaf: currentLeaf,
      drawn: world.getDrawnFaces(),
      total: world.stats.faces,
      enabled: visibilityEnabled,
    }),
    setVisibilityEnabled(enabled) {
      visibilityEnabled = enabled && visibility.hasData;
      if (!visibilityEnabled) {
        world.setVisibleFaces(null);
        currentLeaf = -1;
      }
    },
    moverStates: () =>
      movers.map((mover) => ({
        kind: mover.kind,
        state: mover.state,
        progress: Number(mover.progress.toFixed(2)),
        center: [
          (mover.mins[0] + mover.maxs[0]) / 2,
          (mover.mins[1] + mover.maxs[1]) / 2,
          (mover.mins[2] + mover.maxs[2]) / 2,
        ] as Vec3,
      })),
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
      decals.dispose();
      particles.dispose();
      enemyRenderer.dispose();
      world.dispose();
    },
    stats: {
      ...world.stats,
      entities: placed.length,
      paletteMissing,
      movers: movers.length,
      enemies: enemies.length,
    },
    effectsInfo: () => ({ decals: decals.activeCount, particles: particles.activeCount }),
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
    updateEntities: () => {
      // L'arène de démonstration n'a pas de volume mobile.
    },
    updateEnemies: () => 0,
    fire: (origin, direction) => ({
      point: [
        origin[0] + direction[0] * 2000,
        origin[1] + direction[1] * 2000,
        origin[2] + direction[2] * 2000,
      ] as Vec3,
      hit: false,
      killed: false,
    }),
    enemyInfo: () => ({ total: 0, alive: 0, awake: 0 }),
    enemyStates: () => [],
    effectsInfo: () => ({ decals: 0, particles: 0 }),
    updateVisibility: () => {
      // L'arène de démonstration est construite par le code : elle n'a pas
      // d'arbre de visibilité, tout y est dessiné.
    },
    visibilityInfo: () => ({
      leaf: -1,
      drawn: demo.stats.faces,
      total: demo.stats.faces,
      enabled: false,
    }),
    setVisibilityEnabled: () => {},
    moverStates: () => [],
    styleIntensity: demo.styleIntensity,
    update: demo.update,
    dispose: demo.dispose,
    stats: demo.stats,
  };
}

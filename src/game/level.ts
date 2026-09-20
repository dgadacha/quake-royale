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
import type { AudioEngine } from '../audio/AudioEngine';
import { creatureSounds, pick, soundTable, type CreatureEvent } from '../audio/soundTable';
import {
  collectEnemies,
  detailedEnemyModels,
  detailedEnemySkins,
  enemyModels,
} from './entities/Enemy';
import { parseMdl, type MdlModel } from '../formats/mdl';
import { EnemyManager } from './entities/EnemyManager';
import { loadTransferredModel, type TransferredSource } from '../render/transferredModel';
import { subdivideModel } from '../render/subdivideModel';
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
  setLighting(brightness: number, contrast: number): void;
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
  enemyStates(): {
    kind: string;
    state: string;
    health: number;
    origin: Vec3;
    yaw: number;
    perception: { sees: boolean; inFront: boolean; noticed: boolean; distance: number } | null;
  }[];
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
    /** Créatures affichées avec leur modèle plutôt qu'une silhouette. */
    enemyModels?: number;
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

/** Rend la main au navigateur, pour qu'il puisse redessiner l'écran. */
const breathe = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

export async function loadBspLevel(
  vfs: VirtualFileSystem,
  path: string,
  options: WorldOptions,
  entityModels: EntityModelMap = {},
  audio: AudioEngine | null = null,
  onProgress: (value: number, step: string) => void = () => {},
): Promise<Level> {
  // Les étapes rendent la main entre elles : sans cela le navigateur ne
  // redessine rien et la progression resterait figée jusqu'à la fin.
  onProgress(0.1, 'Lecture du fichier');
  await breathe();
  const data = vfs.readOrThrow(path);
  const bsp = parseBsp(data);

  onProgress(0.25, 'Construction des surfaces');
  await breathe();

  // Sans palette, les index des textures ne peuvent pas être convertis en
  // couleurs justes : le rendu reste lisible mais les teintes sont inventées.
  const paletteData = vfs.read('gfx/palette.lmp');
  const palette = paletteData ? new Palette(paletteData) : Palette.fallback();
  const paletteMissing = !paletteData;

  const world = buildWorld(bsp, palette, options);

  onProgress(0.7, 'Volumes de collision');
  await breathe();
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

  /** Position d'une source sonore, dans le repère de rendu. */
  const soundAt = (origin: Vec3) =>
    new THREE.Vector3(...quakeToThree(origin[0], origin[1], origin[2]));

  /** Premier fichier réellement présent parmi les candidats proposés. */
  const firstAvailable = (candidates: string[]): string | null => {
    for (const candidate of candidates) {
      if (vfs.read(candidate)) return candidate;
    }
    return null;
  };

  const playCreature = (classname: string, event: CreatureEvent, origin: Vec3) => {
    if (!audio) return;
    const file = firstAvailable(creatureSounds(classname, event));
    if (file) audio.play(file, { position: soundAt(origin), volume: 0.9, range: 2600 });
  };
  const enemyManager = new EnemyManager(
    enemies,
    {
      collision: collision.world(0),
      isVisible: (from, to) => collision.world(0, HULL_POINT).trace(from, to).fraction >= 0.999,
    },
    {
      onPlayerHit: (damage) => {
        pendingDamage += damage;
      },
      onSight: (enemy) => playCreature(enemy.classname, 'sight', enemy.origin),
      onAttack: (enemy) => playCreature(enemy.classname, 'attack', enemy.origin),
      onPain: (enemy) => playCreature(enemy.classname, 'pain', enemy.origin),
      onDeath: (enemy) => playCreature(enemy.classname, 'death', enemy.origin),
    },
  );
  // Modèles des créatures, lus dans les données montées. Chaque fichier n'est
  // analysé qu'une fois, même s'il sert à trente occupants.
  const modelCache = new Map<string, MdlModel | null>();
  const loadEnemyModel = (classname: string): MdlModel | null => {
    const path = enemyModels[classname];
    if (!path) return null;
    if (!modelCache.has(path)) {
      const data = vfs.read(path);
      try {
        modelCache.set(path, data ? parseMdl(data) : null);
      } catch (error) {
        console.warn(`[quake-hd] modèle illisible ${path} : ${(error as Error).message}`);
        modelCache.set(path, null);
      }
    }
    return modelCache.get(path) ?? null;
  };

  /**
   * Finesse des modèles d'adversaires.
   * Chaque niveau quadruple le nombre de faces et la place occupée par les
   * images clés : deux suffisent à effacer les angles.
   */
  const ENEMY_SUBDIVISIONS = 2;

  // Modèle affiné, partagé par tous ceux qui emploient le même fichier.
  const displayCache = new Map<string, MdlModel | null>();
  const loadDisplayModel = (classname: string): MdlModel | null => {
    const path = enemyModels[classname];
    if (!path) return null;
    if (!displayCache.has(path)) {
      const raw = loadEnemyModel(classname);
      displayCache.set(path, raw ? subdivideModel(raw, ENEMY_SUBDIVISIONS) : null);
    }
    return displayCache.get(path) ?? null;
  };

  onProgress(0.82, 'Occupants du niveau');
  await breathe();

  // Maillages détaillés : seulement pour les adversaires réellement présents,
  // et seulement s'ils ont été préparés. Leur absence ne change rien au jeu.
  const detailed = new Map<string, TransferredSource>();
  const present = new Set(enemies.map((enemy) => enemy.classname));
  for (const [classname, url] of Object.entries(detailedEnemyModels)) {
    if (!present.has(classname)) continue;
    const source = loadEnemyModel(classname);
    if (!source) continue;
    try {
      const model = await loadTransferredModel(url, source);
      detailed.set(classname, model);
      const info = model.info;
      console.info(
        `[quake-hd] ${classname} : maillage détaillé de ${info.vertexCount} sommets, ` +
          `${info.frameCount} images, ${Math.round(info.weaponShare * 100)} % rattachés à l'arme, ` +
          `quart de tour ${info.turn}°, ${Math.round(info.elapsed)} ms`,
      );
    } catch (error) {
      // Sans maillage détaillé, le modèle d'origine fait l'affaire : on le dit
      // plutôt que de laisser croire que le remplacement a eu lieu.
      console.warn(`[quake-hd] maillage détaillé ignoré pour ${classname} : ${(error as Error).message}`);
    }
    await breathe();
  }

  // Peaux refaites : facultatives, et sans effet sur le jeu. Les coordonnées
  // de texture restent celles du modèle, donc une image au même agencement se
  // pose exactement où il faut.
  const skins = new Map<string, { texture: THREE.Texture; backShift: number }>();
  for (const [classname, entry] of Object.entries(detailedEnemySkins)) {
    if (!present.has(classname)) continue;
    try {
      const texture = await new THREE.TextureLoader().loadAsync(entry.url);
      // La peau d'origine n'est pas retournée : celle-ci ne doit pas l'être.
      texture.flipY = false;
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.wrapS = THREE.ClampToEdgeWrapping;
      texture.wrapT = THREE.ClampToEdgeWrapping;
      texture.anisotropy = options.anisotropy;
      texture.needsUpdate = true;
      skins.set(classname, { texture, backShift: entry.backShift ?? 0 });
      console.info(
        `[quake-hd] ${classname} : peau refaite ${texture.image.width}x${texture.image.height}` +
          (entry.backShift ? `, dos recalé de ${(entry.backShift * 100).toFixed(1)} %` : ''),
      );
    } catch {
      // Sans image, la peau d'origine fait l'affaire.
    }
    await breathe();
  }

  const enemyRenderer = new EnemyRenderer(enemies, loadDisplayModel, palette, {
    anisotropy: options.anisotropy,
    ambient: options.ambient,
    fogColor: options.fogColor,
    fogDensity: options.fogDensity,
    lightScale: options.lightScale,
    emissiveStrength: options.emissiveStrength,
  }, detailed, skins);

  // Traces laissées par les tirs et éclats projetés à l'impact.
  const decals = new DecalPool();
  const particles = new ImpactParticles();

  onProgress(0.93, 'Portes et mécanismes');
  await breathe();
  const movers = collectMovers(bsp);
  const moverManager = new MoverManager(movers, {
    onOpen: (mover) => {
      if (!audio) return;
      const list = mover.kind === 'plat' ? soundTable.platMove : soundTable.doorOpen;
      const file = firstAvailable([...list]);
      const center: Vec3 = [
        (mover.mins[0] + mover.maxs[0]) / 2,
        (mover.mins[1] + mover.maxs[1]) / 2,
        (mover.mins[2] + mover.maxs[2]) / 2,
      ];
      if (file) audio.play(file, { position: soundAt(center), volume: 0.75, range: 2000 });
    },
    onClose: (mover) => {
      if (!audio) return;
      const list = mover.kind === 'plat' ? soundTable.platStop : soundTable.doorClose;
      const file = firstAvailable([...list]);
      const center: Vec3 = [
        (mover.mins[0] + mover.maxs[0]) / 2,
        (mover.mins[1] + mover.maxs[1]) / 2,
        (mover.mins[2] + mover.maxs[2]) / 2,
      ];
      if (file) audio.play(file, { position: soundAt(center), volume: 0.7, range: 2000 });
    },
  });
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
      enemyRenderer.setFlashlight(position, color, radius);
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
      enemyRenderer.update(deltaTime);
      const damage = pendingDamage;
      pendingDamage = 0;
      return damage;
    },
    fire(origin, direction, damage) {
      // Une détonation ne passe pas inaperçue : les créatures proches n'ont
      // plus besoin d'avoir le joueur droit devant pour le remarquer.
      enemyManager.hear(origin);

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

      const impactSurface = result.enemy
        ? 'flesh'
        : surfaceAt(bsp, visibility, result.point, result.normal);

      if (result.enemy) {
        // Une créature ne garde pas de marque : seuls les éclats la signalent.
        particles.burst(point, normal, 'flesh');
      } else {
        // Un liquide avale la marque, il n'en reste que la gerbe.
        if (impactSurface !== 'liquid') decals.add(point, normal, 5.5);
        particles.burst(point, normal, impactSurface);
      }

      if (audio) {
        const file = pick(soundTable.impact[impactSurface]);
        if (file) {
          // La hauteur varie légèrement : des impacts identiques s'entendent.
          audio.play(file, {
            position: point,
            volume: 0.55,
            rate: 0.9 + Math.random() * 0.25,
            range: 1800,
          });
        }
      }

      return { point: result.point, hit: result.enemy !== null, killed: result.killed };
    },
    enemyStates: () =>
      enemies.map((enemy) => ({
        kind: enemy.profile.id,
        state: enemy.state,
        health: enemy.health,
        origin: [...enemy.origin] as Vec3,
        // Le lacet dit où la créature regarde : sans lui, impossible de
        // vérifier qu'elle ignore bien ce qui se passe dans son dos.
        yaw: enemy.yaw,
        perception: enemyManager.perceptionOf(enemy),
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
    setLighting: world.setLighting,
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
      enemyModels: enemyRenderer.modelCount,
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
    setLighting: demo.setLighting,
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

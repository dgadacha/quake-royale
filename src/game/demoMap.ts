import * as THREE from 'three';
import { Contents } from '../formats/bsp';
import { LightmapAtlas, LightStyles, LIGHTMAP_SCALE } from '../render/lightmap';
import { createLiquidMaterial, createWorldMaterial } from '../render/materials';
import { buildDetailTexture, buildTextureSet, type TextureSet } from '../render/textures';
import { quakeToThree, type WorldOptions } from '../render/world';
import { BoxCollision, type CollisionBox } from './boxCollision';
import type { CollisionWorld, Vec3 } from './collision';
import { lightingSampler, type LightingSample } from './level';
import { demoPalette, demoTexture } from './demoTextures';
import type { HDLight } from '../hd/lights/LightResolver';

type Axis = '+x' | '-x' | '+y' | '-y' | '+z' | '-z';

interface Brush {
  min: Vec3;
  max: Vec3;
  texture: string;
  /** Faces à générer ; toutes par défaut. */
  faces?: Axis[];
  contents?: number;
  /** Une face d'eau se contente de sa surface supérieure. */
  liquid?: boolean;
}

interface Face {
  corner: Vec3;
  sDir: Vec3;
  tDir: Vec3;
  normal: Vec3;
  width: number;
  height: number;
  texture: string;
}

interface DemoLight {
  position: Vec3;
  radius: number;
  intensity: number;
  style: number;
  /** Teinte émise, qui déteint sur ce que la salle éclaire. */
  color: THREE.Color;
}

const ALL_FACES: Axis[] = ['+x', '-x', '+y', '-y', '+z', '-z'];

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

function faceFor(brush: Brush, axis: Axis): Face {
  const [x0, y0, z0] = brush.min;
  const [x1, y1, z1] = brush.max;
  const dx = x1 - x0;
  const dy = y1 - y0;
  const dz = z1 - z0;

  // Les repères sont choisis pour que le produit vectoriel sDir x tDir
  // redonne la normale sortante, et que t descende sur les murs.
  switch (axis) {
    case '+x':
      return { corner: [x1, y1, z1], sDir: [0, -1, 0], tDir: [0, 0, -1], normal: [1, 0, 0], width: dy, height: dz, texture: brush.texture };
    case '-x':
      return { corner: [x0, y0, z1], sDir: [0, 1, 0], tDir: [0, 0, -1], normal: [-1, 0, 0], width: dy, height: dz, texture: brush.texture };
    case '+y':
      return { corner: [x0, y1, z1], sDir: [1, 0, 0], tDir: [0, 0, -1], normal: [0, 1, 0], width: dx, height: dz, texture: brush.texture };
    case '-y':
      return { corner: [x1, y0, z1], sDir: [-1, 0, 0], tDir: [0, 0, -1], normal: [0, -1, 0], width: dx, height: dz, texture: brush.texture };
    case '+z':
      return { corner: [x0, y0, z1], sDir: [1, 0, 0], tDir: [0, 1, 0], normal: [0, 0, 1], width: dx, height: dy, texture: brush.texture };
    default:
      return { corner: [x0, y1, z0], sDir: [1, 0, 0], tDir: [0, -1, 0], normal: [0, 0, -1], width: dx, height: dy, texture: brush.texture };
  }
}

/** Salle d'essai : escalier, passerelle, bassin, piliers et panneaux lumineux. */
function arena(): { brushes: Brush[]; lights: DemoLight[]; spawn: Vec3; spawnYaw: number } {
  const brushes: Brush[] = [];
  const lights: DemoLight[] = [];

  const HALF = 640;
  const HEIGHT = 448;
  const WALL = 32;
  const POOL = 192;
  const POOL_BOTTOM = -128;
  const WATER_LEVEL = -24;

  // Sol en quatre dalles autour du bassin.
  const floorParts: [number, number, number, number][] = [
    [-HALF, -HALF, HALF, -POOL],
    [-HALF, POOL, HALF, HALF],
    [-HALF, -POOL, -POOL, POOL],
    [POOL, -POOL, HALF, POOL],
  ];
  for (const [ax, ay, bx, by] of floorParts) {
    brushes.push({ min: [ax, ay, -64], max: [bx, by, 0], texture: 'floor', faces: ['+z'] });
  }

  // Bassin : fond et parois.
  brushes.push({ min: [-POOL, -POOL, POOL_BOTTOM - 32], max: [POOL, POOL, POOL_BOTTOM], texture: 'metal', faces: ['+z'] });
  brushes.push({ min: [-POOL - WALL, -POOL, -64], max: [-POOL, POOL, 0], texture: 'metal', faces: ['+x'] });
  brushes.push({ min: [POOL, -POOL, -64], max: [POOL + WALL, POOL, 0], texture: 'metal', faces: ['-x'] });
  brushes.push({ min: [-POOL, -POOL - WALL, -64], max: [POOL, -POOL, 0], texture: 'metal', faces: ['+y'] });
  brushes.push({ min: [-POOL, POOL, -64], max: [POOL, POOL + WALL, 0], texture: 'metal', faces: ['-y'] });
  brushes.push({
    min: [-POOL, -POOL, POOL_BOTTOM],
    max: [POOL, POOL, WATER_LEVEL],
    texture: 'water',
    contents: Contents.WATER,
    liquid: true,
  });

  // Murs et plafond.
  brushes.push({ min: [-HALF - WALL, -HALF, -64], max: [-HALF, HALF, HEIGHT], texture: 'wall', faces: ['+x'] });
  brushes.push({ min: [HALF, -HALF, -64], max: [HALF + WALL, HALF, HEIGHT], texture: 'wall', faces: ['-x'] });
  brushes.push({ min: [-HALF, -HALF - WALL, -64], max: [HALF, -HALF, HEIGHT], texture: 'wall', faces: ['+y'] });
  brushes.push({ min: [-HALF, HALF, -64], max: [HALF, HALF + WALL, HEIGHT], texture: 'wall', faces: ['-y'] });
  brushes.push({ min: [-HALF, -HALF, HEIGHT], max: [HALF, HALF, HEIGHT + WALL], texture: 'metal', faces: ['-z'] });

  // Piliers.
  for (const [px, py] of [
    [-384, -384],
    [384, -384],
    [-384, 384],
    [384, 384],
  ]) {
    brushes.push({ min: [px - 48, py - 48, 0], max: [px + 48, py + 48, HEIGHT], texture: 'trim' });
    lights.push({
      position: [px, py, 300],
      radius: 560,
      intensity: 0.85,
      style: 1,
      color: new THREE.Color(1, 0.86, 0.66),
    });
  }

  // Escalier le long du mur ouest, menant à la passerelle.
  const STEP_H = 16;
  const STEP_D = 40;
  for (let i = 0; i < 12; i++) {
    const z = i * STEP_H;
    brushes.push({
      min: [-HALF + 40, -560 + i * STEP_D, -64],
      max: [-HALF + 296, -560 + (i + 1) * STEP_D, z + STEP_H],
      texture: 'trim',
      faces: ['+z', '-y', '+x'],
    });
  }

  // Passerelle suspendue.
  brushes.push({
    min: [-HALF + 40, -80, 176],
    max: [-HALF + 296, HALF, 192],
    texture: 'metal',
    faces: ['+z', '+x', '-z', '+y'],
  });
  brushes.push({
    min: [-HALF + 280, -80, 192],
    max: [-HALF + 296, HALF, 240],
    texture: 'trim',
    faces: ['+x', '-x', '+z'],
  });

  // Panneaux lumineux encastrés dans les murs.
  const panels: [Vec3, Axis, number][] = [
    [[-HALF + 1, -200, 240], '+x', 0],
    [[-HALF + 1, 200, 240], '+x', 5],
    [[HALF - 1, -200, 240], '-x', 0],
    [[HALF - 1, 200, 240], '-x', 10],
    [[0, -HALF + 1, 300], '+y', 0],
    [[0, HALF - 1, 300], '-y', 3],
  ];
  for (const [position, axis, style] of panels) {
    const [px, py, pz] = position;
    const w = 64;
    const h = 96;
    const thin = 2;
    const brush: Brush =
      axis === '+x' || axis === '-x'
        ? { min: [px - thin, py - w, pz - h], max: [px + thin, py + w, pz + h], texture: 'lamp', faces: [axis] }
        : { min: [px - w, py - thin, pz - h], max: [px + w, py + thin, pz + h], texture: 'lamp', faces: [axis] };
    brushes.push(brush);

    const normal: Vec3 =
      axis === '+x' ? [1, 0, 0] : axis === '-x' ? [-1, 0, 0] : axis === '+y' ? [0, 1, 0] : [0, -1, 0];
    lights.push({
      position: [px + normal[0] * 48, py + normal[1] * 48, pz],
      radius: 760,
      intensity: 1.15,
      style,
      // Les panneaux sont franchement chauds : c'est eux qui donnent
      // sa dominante à la salle, et donc aux reflets de l'arme.
      color: new THREE.Color(1, 0.82, 0.55),
    });
  }

  // Lumière large au-dessus du bassin.
  lights.push({
    position: [0, 0, 380],
    radius: 900,
    intensity: 0.95,
    style: 0,
    color: new THREE.Color(0.92, 0.95, 1),
  });
  lights.push({
    position: [-380, 0, 300],
    radius: 520,
    intensity: 0.6,
    style: 0,
    color: new THREE.Color(1, 0.9, 0.75),
  });

  return { brushes, lights, spawn: [0, -480, 40], spawnYaw: Math.PI / 2 };
}

export interface DemoWorld {
  root: THREE.Group;
  collision: CollisionWorld;
  spawn: Vec3;
  spawnYaw: number;
  setFlashlight(position: THREE.Vector3, color: THREE.Color, radius: number): void;
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
  /** Sources de la salle, converties pour l'éclairage dynamique. */
  hdLights: HDLight[];
  isVisible(from: Vec3, to: Vec3): boolean;
  sampleLighting(position: Vec3): LightingSample;
  update(time: number): void;
  dispose(): void;
  stats: { faces: number; draws: number; textures: number; lightmapPages: number };
}

export function buildDemoMap(options: WorldOptions): DemoWorld {
  const { brushes, lights, spawn, spawnYaw } = arena();
  const palette = demoPalette();
  const atlas = new LightmapAtlas(options.atlasSize);
  const styles = new LightStyles();
  const detail = buildDetailTexture();

  const collisionBoxes: CollisionBox[] = brushes.map((brush) => ({
    min: brush.min,
    max: brush.max,
    contents: brush.contents ?? Contents.SOLID,
  }));
  const collision = new BoxCollision(collisionBoxes);
  const sampleLighting = lightingSampler(lights);

  const faces: Face[] = [];
  const liquidFaces: Face[] = [];
  for (const brush of brushes) {
    if (brush.liquid) {
      liquidFaces.push(faceFor(brush, '+z'));
      continue;
    }
    for (const axis of brush.faces ?? ALL_FACES) faces.push(faceFor(brush, axis));
  }

  const textureSets = new Map<string, TextureSet>();
  const getTextureSet = (name: string): TextureSet => {
    let set = textureSets.get(name);
    if (!set) {
      set = buildTextureSet(demoTexture(name), palette, { anisotropy: options.anisotropy });
      textureSets.set(name, set);
    }
    return set;
  };

  interface Bucket {
    positions: number[];
    normals: number[];
    uvs: number[];
    lightUvs: number[];
    styleAttr: number[];
    tangents: number[];
    indices: number[];
    count: number;
  }
  const buckets = new Map<string, Bucket>();
  const bucketFor = (name: string): Bucket => {
    let bucket = buckets.get(name);
    if (!bucket) {
      bucket = { positions: [], normals: [], uvs: [], lightUvs: [], styleAttr: [], tangents: [], indices: [], count: 0 };
      buckets.set(name, bucket);
    }
    return bucket;
  };

  for (const face of faces) {
    const set = getTextureSet(face.texture);
    const bucket = bucketFor(face.texture);

    const s0 = dot(face.corner, face.sDir);
    const t0 = dot(face.corner, face.tDir);
    const texMinS = Math.floor(s0 / LIGHTMAP_SCALE) * LIGHTMAP_SCALE;
    const texMinT = Math.floor(t0 / LIGHTMAP_SCALE) * LIGHTMAP_SCALE;
    const lightWidth = Math.min(96, Math.ceil((s0 + face.width - texMinS) / LIGHTMAP_SCALE) + 1);
    const lightHeight = Math.min(96, Math.ceil((t0 + face.height - texMinT) / LIGHTMAP_SCALE) + 1);

    const baked = bakeFace(face, lights, collision, texMinS, texMinT, lightWidth, lightHeight);
    const slot = atlas.add(lightWidth, lightHeight, baked.channels, 0);

    // La texture est en pixels de 128 unités : on divise par sa taille réelle.
    const texScale = 1 / set.width;
    const corners: Vec3[] = [
      face.corner,
      add(face.corner, scale(face.sDir, face.width)),
      add(add(face.corner, scale(face.sDir, face.width)), scale(face.tDir, face.height)),
      add(face.corner, scale(face.tDir, face.height)),
    ];

    const first = bucket.count;
    for (const vertex of corners) {
      const s = dot(vertex, face.sDir);
      const t = dot(vertex, face.tDir);
      const [px, py, pz] = quakeToThree(vertex[0], vertex[1], vertex[2]);
      const [nx, ny, nz] = quakeToThree(face.normal[0], face.normal[1], face.normal[2]);
      const [tx, ty, tz] = quakeToThree(face.sDir[0], face.sDir[1], face.sDir[2]);
      const bitangent = new THREE.Vector3(
        ...quakeToThree(face.tDir[0], face.tDir[1], face.tDir[2]),
      );
      const handedness =
        new THREE.Vector3(nx, ny, nz).cross(new THREE.Vector3(tx, ty, tz)).dot(bitangent) < 0 ? -1 : 1;

      bucket.positions.push(px, py, pz);
      bucket.normals.push(nx, ny, nz);
      bucket.uvs.push(s * texScale * (set.width / 128), t * texScale * (set.width / 128));
      bucket.tangents.push(tx, ty, tz, handedness);
      bucket.styleAttr.push(baked.styles[0], baked.styles[1], baked.styles[2], baked.styles[3]);
      bucket.lightUvs.push(
        ((s - texMinS) / LIGHTMAP_SCALE + 0.5 + slot.x) / atlas.size,
        ((t - texMinT) / LIGHTMAP_SCALE + 0.5 + slot.y) / atlas.size,
      );
    }
    bucket.indices.push(first, first + 1, first + 2, first, first + 2, first + 3);
    bucket.count += 4;
  }

  const root = new THREE.Group();
  root.name = 'demo';
  const materials: THREE.ShaderMaterial[] = [];
  const pages = atlas.build();
  const emptyTexture = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
  emptyTexture.needsUpdate = true;

  for (const [name, bucket] of buckets) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(bucket.positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(bucket.normals, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(bucket.uvs, 2));
    geometry.setAttribute('aLightUv', new THREE.Float32BufferAttribute(bucket.lightUvs, 2));
    geometry.setAttribute('aStyles', new THREE.Float32BufferAttribute(bucket.styleAttr, 4));
    geometry.setAttribute('aTangent', new THREE.Float32BufferAttribute(bucket.tangents, 4));
    geometry.setIndex(bucket.indices);
    geometry.computeBoundingSphere();

    const material = createWorldMaterial(
      getTextureSet(name),
      pages[0] ?? emptyTexture,
      styles.texture,
      detail,
      emptyTexture,
      options,
    );
    materials.push(material);
    root.add(new THREE.Mesh(geometry, material));
  }

  // Surface d'eau.
  for (const face of liquidFaces) {
    const set = getTextureSet('water');
    const geometry = new THREE.BufferGeometry();
    const corners: Vec3[] = [
      face.corner,
      add(face.corner, scale(face.sDir, face.width)),
      add(add(face.corner, scale(face.sDir, face.width)), scale(face.tDir, face.height)),
      add(face.corner, scale(face.tDir, face.height)),
    ];
    const positions: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];
    for (const vertex of corners) {
      const [px, py, pz] = quakeToThree(vertex[0], vertex[1], vertex[2]);
      positions.push(px, py, pz);
      normals.push(0, 1, 0);
      uvs.push(dot(vertex, face.sDir) / 128, dot(vertex, face.tDir) / 128);
    }
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    geometry.computeBoundingSphere();

    const material = createLiquidMaterial(set.map, 'water', options);
    materials.push(material);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.renderOrder = 1;
    root.add(mesh);
  }

  return {
    root,
    collision,
    spawn,
    spawnYaw,
    sampleLighting,
    styleIntensity: (style: number) => styles.intensityOf(style),
    isVisible: (from: Vec3, to: Vec3) => !collision.rayBlocked(from, to),
    hdLights: lights.map((light) => ({
      position: light.position,
      color: light.color.clone(),
      intensity: light.intensity,
      radius: light.radius,
      category: light.intensity >= 1 ? 'primary' : 'secondary',
      style: light.style,
      classname: 'light',
    })),
    setShadow(
      map: THREE.Texture,
      matrix: THREE.Matrix4,
      view: THREE.Matrix4,
      strength: number,
      texel: number,
    ) {
      for (const material of materials) {
        const uniforms = material.uniforms;
        if (!uniforms.uShadowStrength) continue;
        uniforms.uShadowMap.value = map;
        (uniforms.uShadowMatrix.value as THREE.Matrix4).copy(matrix);
        (uniforms.uShadowView.value as THREE.Matrix4).copy(view);
        uniforms.uShadowStrength.value = strength;
        uniforms.uShadowTexel.value = texel;
      }
    },
    setLighting(brightness: number, contrast: number) {
      for (const material of materials) {
        const uniforms = material.uniforms;
        if (uniforms.uLightScale) uniforms.uLightScale.value = brightness;
        if (uniforms.uLightGamma) uniforms.uLightGamma.value = contrast;
      }
    },
    setDynamicLights(count: number, diffuse: number, specular: number) {
      for (const material of materials) {
        const uniforms = material.uniforms;
        if (!uniforms.uLightCount) continue;
        uniforms.uLightCount.value = count;
        uniforms.uDynamicDiffuse.value = diffuse;
        uniforms.uDynamicSpecular.value = specular;
      }
    },
    setFlashlight(position, color, radius) {
      for (const material of materials) {
        const uniforms = material.uniforms;
        if (uniforms.uFlashPos) uniforms.uFlashPos.value.copy(position);
        if (uniforms.uFlashColor) uniforms.uFlashColor.value.copy(color);
        if (uniforms.uFlashRadius) uniforms.uFlashRadius.value = radius;
      }
    },
    update(time) {
      styles.update(time);
      for (const material of materials) {
        if (material.uniforms.uTime) material.uniforms.uTime.value = time;
      }
    },
    dispose() {
      root.traverse((object) => {
        if (object instanceof THREE.Mesh) {
          object.geometry.dispose();
          (object.material as THREE.Material).dispose();
        }
      });
      for (const set of textureSets.values()) {
        set.map.dispose();
        set.surfaceMap.dispose();
        set.emissiveMap?.dispose();
      }
      atlas.dispose();
      styles.dispose();
      detail.dispose();
      emptyTexture.dispose();
    },
    stats: {
      faces: faces.length + liquidFaces.length,
      draws: materials.length,
      textures: textureSets.size,
      lightmapPages: pages.length,
    },
  };
}

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];

/**
 * Calcule l'éclairage d'une face. Chaque style d'animation présent occupe
 * un canal, exactement comme les lightmaps d'une carte compilée.
 */
function bakeFace(
  face: Face,
  lights: DemoLight[],
  collision: BoxCollision,
  texMinS: number,
  texMinT: number,
  width: number,
  height: number,
): { channels: (Uint8Array | null)[]; styles: [number, number, number, number] } {
  const s0 = dot(face.corner, face.sDir);
  const t0 = dot(face.corner, face.tDir);

  // Sélection des styles réellement utiles à cette face.
  const relevant = lights.filter((light) => {
    const toFace =
      (light.position[0] - face.corner[0]) * face.normal[0] +
      (light.position[1] - face.corner[1]) * face.normal[1] +
      (light.position[2] - face.corner[2]) * face.normal[2];
    if (toFace <= 0) return false;
    const center: Vec3 = add(
      add(face.corner, scale(face.sDir, face.width / 2)),
      scale(face.tDir, face.height / 2),
    );
    const distance = Math.hypot(
      light.position[0] - center[0],
      light.position[1] - center[1],
      light.position[2] - center[2],
    );
    return distance < light.radius + Math.max(face.width, face.height);
  });

  const usedStyles = [...new Set(relevant.map((light) => light.style))].slice(0, 4);
  const styles: [number, number, number, number] = [
    usedStyles[0] ?? 255,
    usedStyles[1] ?? 255,
    usedStyles[2] ?? 255,
    usedStyles[3] ?? 255,
  ];

  const channels: (Uint8Array | null)[] = [null, null, null, null];
  for (let channel = 0; channel < usedStyles.length; channel++) {
    channels[channel] = new Uint8Array(width * height);
  }

  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      const s = texMinS + i * LIGHTMAP_SCALE;
      const t = texMinT + j * LIGHTMAP_SCALE;
      const point: Vec3 = add(
        add(face.corner, scale(face.sDir, s - s0)),
        scale(face.tDir, t - t0),
      );
      const origin: Vec3 = add(point, scale(face.normal, 2));

      for (let channel = 0; channel < usedStyles.length; channel++) {
        const style = usedStyles[channel];
        let total = 0;
        for (const light of relevant) {
          if (light.style !== style) continue;
          const delta: Vec3 = [
            light.position[0] - origin[0],
            light.position[1] - origin[1],
            light.position[2] - origin[2],
          ];
          const distance = Math.hypot(delta[0], delta[1], delta[2]);
          if (distance > light.radius) continue;
          const lambert =
            (delta[0] * face.normal[0] + delta[1] * face.normal[1] + delta[2] * face.normal[2]) /
            distance;
          if (lambert <= 0) continue;
          const attenuation = Math.pow(1 - distance / light.radius, 1.6);
          if (collision.rayBlocked(origin, light.position)) continue;
          total += light.intensity * attenuation * lambert;
        }
        channels[channel]![j * width + i] = Math.min(255, Math.round(total * 255));
      }
    }
  }

  // Adoucissement : les ombres calculées par échantillon unique sont trop dures.
  for (const channel of channels) {
    if (channel) blur(channel, width, height);
  }
  return { channels, styles };
}

function blur(data: Uint8Array, width: number, height: number): void {
  const source = data.slice();
  const at = (x: number, y: number) =>
    source[Math.min(height - 1, Math.max(0, y)) * width + Math.min(width - 1, Math.max(0, x))];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sum =
        at(x - 1, y - 1) + at(x, y - 1) * 2 + at(x + 1, y - 1) +
        at(x - 1, y) * 2 + at(x, y) * 4 + at(x + 1, y) * 2 +
        at(x - 1, y + 1) + at(x, y + 1) * 2 + at(x + 1, y + 1);
      data[y * width + x] = Math.round(sum / 16);
    }
  }
}

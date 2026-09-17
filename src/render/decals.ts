import * as THREE from 'three';

/** Nature de la surface touchée, qui décide de l'aspect de l'impact. */
export type ImpactSurface = 'stone' | 'metal' | 'wood' | 'liquid' | 'flesh';

const MAX_DECALS = 96;

/**
 * Marque d'impact : un cratère sombre, une auréole de poussière et quelques
 * éclats. Dessinée ici plutôt que chargée, pour rester indépendante de toute
 * donnée extérieure.
 */
function buildDecalTexture(size = 128): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  let seed = 0x1f2e3d4c;
  const random = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return ((seed >>> 0) % 100000) / 100000;
  };

  // Quelques éclats disposés une fois pour toutes autour du point d'impact.
  const chips = Array.from({ length: 9 }, () => ({
    angle: random() * Math.PI * 2,
    distance: 0.28 + random() * 0.22,
    radius: 0.03 + random() * 0.05,
  }));

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const nx = (x / size) * 2 - 1;
      const ny = (y / size) * 2 - 1;
      const radius = Math.hypot(nx, ny);

      // Cratère central, franc au centre et estompé sur les bords.
      let alpha = Math.max(0, 1 - Math.pow(radius / 0.34, 2.2));
      // Poussière autour, beaucoup plus légère.
      alpha = Math.max(alpha, Math.max(0, 1 - radius / 0.95) * 0.22);

      for (const chip of chips) {
        const cx = Math.cos(chip.angle) * chip.distance;
        const cy = Math.sin(chip.angle) * chip.distance;
        const d = Math.hypot(nx - cx, ny - cy);
        if (d < chip.radius) alpha = Math.max(alpha, 1 - d / chip.radius);
      }

      if (radius > 1) alpha = 0;

      const o = (y * size + x) * 4;
      // Le centre est presque noir, le pourtour grisonne.
      const shade = Math.round(20 + Math.min(1, radius) * 45);
      data[o] = shade;
      data[o + 1] = shade;
      data[o + 2] = shade;
      data[o + 3] = Math.round(Math.min(1, alpha) * 255);
    }
  }

  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Marques d'impact accumulées sur le décor.
 *
 * Toutes partagent une seule géométrie : les quatre sommets de chaque marque
 * sont recalculés à la pose, et un tour de rôle recycle la plus ancienne. Le
 * coût de rendu ne dépend donc pas du nombre de tirs.
 */
export class DecalPool {
  readonly mesh: THREE.Mesh;
  private readonly positions: THREE.BufferAttribute;
  private readonly alphas: THREE.BufferAttribute;
  private readonly material: THREE.ShaderMaterial;
  private readonly texture: THREE.DataTexture;
  private readonly ages = new Float32Array(MAX_DECALS);
  private readonly used = new Uint8Array(MAX_DECALS);
  private next = 0;

  /** Durée avant effacement complet, en secondes. */
  lifetime = 26;

  constructor() {
    this.texture = buildDecalTexture();

    const geometry = new THREE.BufferGeometry();
    this.positions = new THREE.BufferAttribute(new Float32Array(MAX_DECALS * 4 * 3), 3);
    this.positions.setUsage(THREE.DynamicDrawUsage);
    this.alphas = new THREE.BufferAttribute(new Float32Array(MAX_DECALS * 4), 1);
    this.alphas.setUsage(THREE.DynamicDrawUsage);

    const uvs = new Float32Array(MAX_DECALS * 4 * 2);
    const indices = new Uint16Array(MAX_DECALS * 6);
    for (let i = 0; i < MAX_DECALS; i++) {
      uvs.set([0, 0, 1, 0, 1, 1, 0, 1], i * 8);
      const v = i * 4;
      indices.set([v, v + 1, v + 2, v, v + 2, v + 3], i * 6);
    }

    geometry.setAttribute('position', this.positions);
    geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geometry.setAttribute('aAlpha', this.alphas);
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));

    this.material = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: this.texture } },
      vertexShader: /* glsl */ `
        attribute float aAlpha;
        varying vec2 vUv;
        varying float vAlpha;
        void main() {
          vUv = uv;
          vAlpha = aAlpha;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform sampler2D uMap;
        varying vec2 vUv;
        varying float vAlpha;
        void main() {
          vec4 texel = texture2D(uMap, vUv);
          float alpha = texel.a * vAlpha;
          if (alpha < 0.01) discard;
          gl_FragColor = vec4(texel.rgb, alpha);
        }
      `,
      transparent: true,
      depthWrite: false,
      // Les marques se posent sur une surface déjà dessinée : sans décalage
      // elles clignoteraient contre elle.
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    });

    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
  }

  /** Pose une marque sur une surface, orientée par sa normale. */
  add(point: THREE.Vector3, normal: THREE.Vector3, size: number): void {
    const slot = this.next;
    this.next = (this.next + 1) % MAX_DECALS;
    this.ages[slot] = 0;
    this.used[slot] = 1;

    // Repère du quad : n'importe quelle base orthogonale à la normale convient,
    // l'orientation de la marque n'ayant pas de sens privilégié.
    const tangent = new THREE.Vector3(0, 1, 0);
    if (Math.abs(normal.dot(tangent)) > 0.92) tangent.set(1, 0, 0);
    const right = new THREE.Vector3().crossVectors(normal, tangent).normalize();
    const up = new THREE.Vector3().crossVectors(right, normal).normalize();

    right.multiplyScalar(size);
    up.multiplyScalar(size);
    // Léger décollement pour passer devant la surface porteuse.
    const base = point.clone().addScaledVector(normal, 0.6);

    const array = this.positions.array as Float32Array;
    const corners = [
      base.clone().sub(right).sub(up),
      base.clone().add(right).sub(up),
      base.clone().add(right).add(up),
      base.clone().sub(right).add(up),
    ];
    corners.forEach((corner, i) => {
      array.set([corner.x, corner.y, corner.z], (slot * 4 + i) * 3);
    });

    const alphas = this.alphas.array as Float32Array;
    alphas.fill(1, slot * 4, slot * 4 + 4);

    this.positions.needsUpdate = true;
    this.alphas.needsUpdate = true;
  }

  /** Fait pâlir les marques avec le temps, puis les libère. */
  update(deltaTime: number): void {
    const alphas = this.alphas.array as Float32Array;
    let changed = false;

    for (let slot = 0; slot < MAX_DECALS; slot++) {
      if (!this.used[slot]) continue;
      this.ages[slot] += deltaTime;

      const remaining = 1 - this.ages[slot] / this.lifetime;
      if (remaining <= 0) {
        this.used[slot] = 0;
        alphas.fill(0, slot * 4, slot * 4 + 4);
        changed = true;
        continue;
      }

      // Le fondu ne commence que sur le dernier quart de la durée.
      const alpha = Math.min(1, remaining * 4);
      if (alpha < 1) {
        alphas.fill(alpha, slot * 4, slot * 4 + 4);
        changed = true;
      }
    }

    if (changed) this.alphas.needsUpdate = true;
  }

  get activeCount(): number {
    return this.used.reduce((total, value) => total + value, 0);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.texture.dispose();
  }
}

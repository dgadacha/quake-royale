import * as THREE from 'three';
import type { ImpactSurface } from './decals';

const MAX_PARTICLES = 512;
const GRAVITY = 520;

interface SurfaceLook {
  /** Couleurs tirées au sort à chaque éclat. */
  colors: [number, number, number][];
  speed: number;
  lifetime: number;
  size: number;
  count: number;
  /** Une matière incandescente ne s'assombrit pas en tombant. */
  glowing: boolean;
}

/**
 * Aspect des éclats selon la matière.
 * C'est ce qui donne à chaque surface son identité au tir, bien plus que la
 * marque laissée derrière.
 */
const LOOKS: Record<ImpactSurface, SurfaceLook> = {
  stone: {
    colors: [
      [0.62, 0.58, 0.52],
      [0.45, 0.42, 0.38],
      [0.75, 0.72, 0.66],
    ],
    speed: 150,
    lifetime: 0.8,
    size: 2.2,
    count: 12,
    glowing: false,
  },
  metal: {
    // Le métal jette des étincelles vives, qui restent lumineuses.
    colors: [
      [2.6, 1.5, 0.5],
      [2.2, 0.9, 0.25],
      [2.8, 2.2, 1.1],
    ],
    speed: 260,
    lifetime: 0.55,
    size: 1.6,
    count: 18,
    glowing: true,
  },
  wood: {
    colors: [
      [0.5, 0.34, 0.2],
      [0.36, 0.24, 0.14],
      [0.62, 0.46, 0.3],
    ],
    speed: 130,
    lifetime: 0.9,
    size: 2.6,
    count: 10,
    glowing: false,
  },
  liquid: {
    colors: [
      [0.6, 0.78, 0.95],
      [0.8, 0.9, 1.0],
    ],
    speed: 190,
    lifetime: 0.7,
    size: 2.4,
    count: 14,
    glowing: false,
  },
  flesh: {
    colors: [
      [0.5, 0.06, 0.06],
      [0.34, 0.03, 0.04],
    ],
    speed: 170,
    lifetime: 0.6,
    size: 2.8,
    count: 14,
    glowing: false,
  },
};

/**
 * Éclats projetés par un impact.
 *
 * Toutes les particules vivent dans un seul nuage de points recyclé en
 * continu : leur nombre n'influe ni sur les appels de dessin ni sur la
 * mémoire allouée.
 */
export class ImpactParticles {
  readonly points: THREE.Points;
  private readonly positions: THREE.BufferAttribute;
  private readonly colors: THREE.BufferAttribute;
  private readonly sizes: THREE.BufferAttribute;
  private readonly velocities = new Float32Array(MAX_PARTICLES * 3);
  private readonly ages = new Float32Array(MAX_PARTICLES);
  private readonly lifetimes = new Float32Array(MAX_PARTICLES);
  private readonly glow = new Uint8Array(MAX_PARTICLES);
  private readonly material: THREE.ShaderMaterial;
  private next = 0;

  constructor() {
    const geometry = new THREE.BufferGeometry();
    this.positions = new THREE.BufferAttribute(new Float32Array(MAX_PARTICLES * 3), 3);
    this.colors = new THREE.BufferAttribute(new Float32Array(MAX_PARTICLES * 3), 3);
    this.sizes = new THREE.BufferAttribute(new Float32Array(MAX_PARTICLES), 1);
    for (const attribute of [this.positions, this.colors, this.sizes]) {
      attribute.setUsage(THREE.DynamicDrawUsage);
    }
    geometry.setAttribute('position', this.positions);
    geometry.setAttribute('aColor', this.colors);
    geometry.setAttribute('aSize', this.sizes);

    this.material = new THREE.ShaderMaterial({
      vertexShader: /* glsl */ `
        attribute vec3 aColor;
        attribute float aSize;
        varying vec3 vColor;
        void main() {
          vColor = aColor;
          vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
          // La taille à l'écran suit la distance, comme un objet réel.
          gl_PointSize = aSize * 220.0 / max(1.0, -viewPosition.z);
          gl_Position = projectionMatrix * viewPosition;
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        varying vec3 vColor;
        void main() {
          // Chaque point est un disque adouci, pas un carré.
          vec2 offset = gl_PointCoord - vec2(0.5);
          float distance = length(offset);
          if (distance > 0.5) discard;
          float alpha = 1.0 - smoothstep(0.24, 0.5, distance);
          gl_FragColor = vec4(vColor, alpha);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.points = new THREE.Points(geometry, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 3;
  }

  /** Projette une gerbe d'éclats depuis un impact. */
  burst(point: THREE.Vector3, normal: THREE.Vector3, surface: ImpactSurface): void {
    const look = LOOKS[surface];
    const positions = this.positions.array as Float32Array;
    const colors = this.colors.array as Float32Array;
    const sizes = this.sizes.array as Float32Array;

    for (let i = 0; i < look.count; i++) {
      const slot = this.next;
      this.next = (this.next + 1) % MAX_PARTICLES;

      positions.set([point.x, point.y, point.z], slot * 3);

      // Direction dispersée autour de la normale, jamais vers la surface.
      const spread = 0.85;
      const dx = normal.x + (Math.random() - 0.5) * spread * 2;
      const dy = normal.y + (Math.random() - 0.5) * spread * 2;
      const dz = normal.z + (Math.random() - 0.5) * spread * 2;
      const length = Math.hypot(dx, dy, dz) || 1;
      const speed = look.speed * (0.45 + Math.random() * 0.75);
      this.velocities.set(
        [(dx / length) * speed, (dy / length) * speed, (dz / length) * speed],
        slot * 3,
      );

      const color = look.colors[Math.floor(Math.random() * look.colors.length)];
      colors.set(color, slot * 3);
      sizes[slot] = look.size * (0.7 + Math.random() * 0.6);
      this.lifetimes[slot] = look.lifetime * (0.7 + Math.random() * 0.6);
      this.ages[slot] = 0;
      this.glow[slot] = look.glowing ? 1 : 0;
    }

    this.positions.needsUpdate = true;
    this.colors.needsUpdate = true;
    this.sizes.needsUpdate = true;
  }

  update(deltaTime: number): void {
    const positions = this.positions.array as Float32Array;
    const sizes = this.sizes.array as Float32Array;

    for (let slot = 0; slot < MAX_PARTICLES; slot++) {
      if (this.lifetimes[slot] <= 0) continue;

      this.ages[slot] += deltaTime;
      if (this.ages[slot] >= this.lifetimes[slot]) {
        this.lifetimes[slot] = 0;
        sizes[slot] = 0;
        continue;
      }

      const base = slot * 3;
      // Repère de rendu : la pesanteur agit sur l'axe vertical.
      this.velocities[base + 1] -= GRAVITY * deltaTime;
      positions[base] += this.velocities[base] * deltaTime;
      positions[base + 1] += this.velocities[base + 1] * deltaTime;
      positions[base + 2] += this.velocities[base + 2] * deltaTime;

      // L'éclat s'amenuise en fin de course ; une étincelle garde son éclat.
      const remaining = 1 - this.ages[slot] / this.lifetimes[slot];
      sizes[slot] *= this.glow[slot] ? 0.985 : 0.97;
      if (remaining < 0.3) sizes[slot] *= 0.92;
    }

    this.positions.needsUpdate = true;
    this.sizes.needsUpdate = true;
  }

  get activeCount(): number {
    let total = 0;
    for (let slot = 0; slot < MAX_PARTICLES; slot++) if (this.lifetimes[slot] > 0) total++;
    return total;
  }

  dispose(): void {
    this.points.geometry.dispose();
    this.material.dispose();
  }
}

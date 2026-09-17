import * as THREE from 'three';
import type { Vec3 } from '../../game/collision';
import type { HDLight } from './LightResolver';

/** Nombre maximal de sources transmises au shader en une image. */
export const MAX_ACTIVE_LIGHTS = 12;

export interface LightUniformArrays {
  /** xyz position dans le repère de rendu, w portée. */
  positions: THREE.Vector4[];
  /** rgb couleur, a intensité courante. */
  colors: THREE.Vector4[];
  count: number;
}

export interface LightBudget {
  /** Sources calculées simultanément ; au-delà, seules les plus utiles comptent. */
  maxLights: number;
  /** Part de diffus apportée par les sources dynamiques. */
  diffuse: number;
  /** Part de spéculaire, qui est leur vrai apport sur un éclairage déjà cuit. */
  specular: number;
}

export const defaultLightBudget = (): LightBudget => ({
  maxLights: 8,
  // Les lightmaps portent déjà le diffus de ces mêmes sources : en remettre
  // une pleine dose délaverait la scène au lieu de l'éclairer.
  diffuse: 0.32,
  specular: 1.0,
});

/**
 * Choisit, parmi toutes les sources d'une carte, celles qui méritent d'être
 * calculées autour du joueur, et suit leur animation.
 *
 * Une carte peut déclarer des centaines de lumières ; seules quelques-unes
 * éclairent réellement l'endroit où l'on se trouve.
 */
export class HDLightManager {
  private lights: HDLight[] = [];
  private active: HDLight[] = [];
  /**
   * Avancement de l'entrée ou de la sortie de chaque source.
   * Sans lui, franchir une porte ou passer sous une passerelle allumerait et
   * éteindrait les sources d'un coup, ce qui se voit immédiatement.
   */
  private readonly fade = new Map<HDLight, number>();
  private readonly positions: THREE.Vector4[] = [];
  private readonly colors: THREE.Vector4[] = [];
  private budget = defaultLightBudget();
  private lastSort = new THREE.Vector3(Infinity, Infinity, Infinity);
  private sortAge = Infinity;
  private selected = new Set<HDLight>();
  /** Test d'occultation, évalué au classement et non par pixel. */
  private visible: ((from: Vec3, to: Vec3) => boolean) | null = null;

  constructor() {
    for (let i = 0; i < MAX_ACTIVE_LIGHTS; i++) {
      this.positions.push(new THREE.Vector4());
      this.colors.push(new THREE.Vector4());
    }
  }

  setVisibilityTest(test: ((from: Vec3, to: Vec3) => boolean) | null): void {
    this.visible = test;
  }

  setLights(lights: HDLight[]): void {
    this.lights = lights;
    this.active = [];
    this.fade.clear();
    this.sortAge = Infinity;
    this.lastSort.set(Infinity, Infinity, Infinity);
  }

  setBudget(budget: Partial<LightBudget>): LightBudget {
    this.budget = { ...this.budget, ...budget };
    this.budget.maxLights = Math.max(0, Math.min(MAX_ACTIVE_LIGHTS, this.budget.maxLights));
    return { ...this.budget };
  }

  get currentBudget(): LightBudget {
    return { ...this.budget };
  }

  get totalCount(): number {
    return this.lights.length;
  }

  get activeCount(): number {
    return this.active.length;
  }

  /**
   * Met à jour la sélection et les intensités.
   * `styleIntensity` renvoie l'intensité courante d'un style d'animation, ce
   * qui fait vaciller une torche dynamique comme sa lightmap.
   */
  update(
    playerPosition: Vec3,
    deltaTime: number,
    styleIntensity: (style: number) => number,
  ): void {
    this.sortAge += deltaTime;

    // Le classement ne change pas d'une image à l'autre : le refaire sans
    // arrêt coûterait plus cher que les lumières elles-mêmes.
    const moved = Math.hypot(
      playerPosition[0] - this.lastSort.x,
      playerPosition[1] - this.lastSort.y,
      playerPosition[2] - this.lastSort.z,
    );
    if (moved > 96 || this.sortAge > 0.4) {
      this.selectLights(playerPosition);
      this.lastSort.set(playerPosition[0], playerPosition[1], playerPosition[2]);
      this.sortAge = 0;
    }

    this.updateFades(deltaTime);

    for (let i = 0; i < this.active.length; i++) {
      const light = this.active[i];
      const animated = light.style > 0 ? styleIntensity(light.style) : 1;
      const blend = this.fade.get(light) ?? 1;
      // Repère de rendu : le jeu place la hauteur sur le troisième axe.
      this.positions[i].set(light.position[0], light.position[2], -light.position[1], light.radius);
      this.colors[i].set(
        light.color.r,
        light.color.g,
        light.color.b,
        light.intensity * animated * blend,
      );
    }
  }

  /** Fait monter les sources retenues et redescendre celles qui sortent. */
  private updateFades(deltaTime: number): void {
    const speed = Math.min(1, deltaTime * 5);
    for (const [light, value] of this.fade) {
      const target = this.selected.has(light) ? 1 : 0;
      const next = value + (target - value) * speed;
      if (next <= 0.01 && target === 0) this.fade.delete(light);
      else this.fade.set(light, next);
    }

    // Les sources encore visibles, même en train de s'éteindre, gardent
    // leur place le temps de la transition.
    this.active = [...this.fade.keys()].slice(0, MAX_ACTIVE_LIGHTS);
  }

  private selectLights(playerPosition: Vec3): void {
    const scored: { light: HDLight; score: number }[] = [];

    for (const light of this.lights) {
      const distance = Math.hypot(
        light.position[0] - playerPosition[0],
        light.position[1] - playerPosition[1],
        light.position[2] - playerPosition[2],
      );
      if (distance >= light.radius) continue;

      // Une source proche et forte prime ; l'importance déclarée départage
      // deux sources comparables.
      // Une source séparée du joueur par un mur n'a rien à faire dans la
      // sélection : faute de ce test, elle éclairerait au travers.
      if (this.visible && !this.visible(light.position, playerPosition)) continue;

      const falloff = 1 - distance / light.radius;
      const weight =
        light.category === 'primary' ? 1.35 : light.category === 'secondary' ? 1 : 0.7;
      scored.push({ light, score: falloff * falloff * light.intensity * weight });
    }

    scored.sort((a, b) => b.score - a.score);
    this.selected = new Set(scored.slice(0, this.budget.maxLights).map((entry) => entry.light));
    for (const light of this.selected) {
      if (!this.fade.has(light)) this.fade.set(light, 0);
    }
  }

  get uniforms(): LightUniformArrays {
    return { positions: this.positions, colors: this.colors, count: this.active.length };
  }

  get diffuseAmount(): number {
    return this.budget.diffuse;
  }

  get specularAmount(): number {
    return this.budget.specular;
  }
}

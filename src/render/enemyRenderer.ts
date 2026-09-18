import * as THREE from 'three';
import type { Enemy } from '../game/entities/Enemy';
import { quakeToThree } from './world';
import { SHADOW_CASTER_LAYER } from './shadows';
import { AliasModel, type AliasModelOptions } from './aliasModel';
import type { TransferredModel, TransferredSource } from './transferredModel';
import {
  detectAnimations,
  rangeForState,
  type AnimationKind,
  type AnimationRange,
} from './aliasAnimation';
import type { MdlModel } from '../formats/mdl';
import type { Palette } from '../formats/palette';

/**
 * Silhouette de substitution.
 *
 * Tant que les modèles de la copie du jeu ne sont pas montés, les adversaires
 * sont représentés par une forme anguleuse construite ici : un fût trapu, une
 * tête inclinée et un point lumineux qui indique où ils regardent. Elle sert
 * à lire une présence et une orientation, pas à ressembler à quoi que ce soit.
 * Dès qu'un modèle est disponible, il prend sa place.
 */
function buildSilhouette(color: THREE.Color, radius: number, height: number): THREE.Group {
  const group = new THREE.Group();

  const body = new THREE.Mesh(
    new THREE.CylinderGeometry(radius * 0.72, radius, height * 0.62, 6),
    new THREE.MeshStandardMaterial({ color, roughness: 0.82, metalness: 0.08, flatShading: true }),
  );
  body.position.y = height * 0.31;
  group.add(body);

  const head = new THREE.Mesh(
    new THREE.OctahedronGeometry(radius * 0.55, 0),
    new THREE.MeshStandardMaterial({
      color: color.clone().multiplyScalar(0.72),
      roughness: 0.65,
      metalness: 0.15,
      flatShading: true,
    }),
  );
  head.position.y = height * 0.78;
  head.rotation.z = 0.32;
  group.add(head);

  // Le point lumineux donne la direction du regard d'un seul coup d'oeil.
  const eye = new THREE.Mesh(
    new THREE.SphereGeometry(radius * 0.16, 8, 6),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(1.6, 0.5, 0.25) }),
  );
  eye.position.set(0, height * 0.78, -radius * 0.5);
  group.add(eye);

  for (const child of group.children) child.layers.enable(SHADOW_CASTER_LAYER);
  return group;
}

export interface EnemyView {
  enemy: Enemy;
  group: THREE.Group;
  /** Présent seulement sur la silhouette de substitution. */
  eyeMaterial: THREE.MeshBasicMaterial | null;
  /** Présent quand un modèle a pu être chargé, détaillé ou d'origine. */
  model: AliasModel | TransferredModel | null;
  animations: Map<AnimationKind, AnimationRange> | null;
  current: AnimationRange | null;
  elapsed: number;
}

/** Fournit le modèle d'une créature, ou rien s'il n'est pas disponible. */
export type EnemyModelLoader = (classname: string) => MdlModel | null;

/** Affiche les adversaires et suit leur état image par image. */
export class EnemyRenderer {
  readonly root = new THREE.Group();
  private readonly views: EnemyView[] = [];

  constructor(
    enemies: Enemy[],
    loader: EnemyModelLoader | null = null,
    palette: Palette | null = null,
    options: AliasModelOptions | null = null,
    detailed: Map<string, TransferredSource> | null = null,
  ) {
    this.root.name = 'enemies';

    for (const enemy of enemies) {
      const parsed = loader && palette && options ? loader(enemy.classname) : null;

      if (parsed) {
        // Le maillage détaillé, quand il existe, remplace celui d'origine sans
        // rien changer aux séquences : elles sont lues sur le même modèle.
        const source = detailed?.get(enemy.classname) ?? null;
        const model = source ? source.create(options!) : new AliasModel(parsed, palette!, options!);
        model.mesh.layers.enable(SHADOW_CASTER_LAYER);
        const group = new THREE.Group();
        group.add(model.mesh);
        const animations = detectAnimations(parsed);
        this.views.push({
          enemy,
          group,
          eyeMaterial: null,
          model,
          animations,
          current: animations.get('idle') ?? null,
          elapsed: 0,
        });
        this.root.add(group);
        continue;
      }

      const group = buildSilhouette(
        new THREE.Color(...enemy.profile.color),
        enemy.profile.radius,
        enemy.profile.height,
      );
      const eyeMesh = group.children[2] as THREE.Mesh;
      this.views.push({
        enemy,
        group,
        eyeMaterial: eyeMesh.material as THREE.MeshBasicMaterial,
        model: null,
        animations: null,
        current: null,
        elapsed: 0,
      });
      this.root.add(group);
    }
  }

  /** Séquence correspondant à l'état courant, par ordre de préférence. */
  private wantedFor(enemy: Enemy): AnimationKind[] {
    switch (enemy.state) {
      case 'dying':
      case 'dead':
        return ['death', 'pain', 'idle'];
      case 'attacking':
        return ['attack', 'idle'];
      case 'chasing':
        return ['run', 'walk', 'idle'];
      default:
        return ['idle'];
    }
  }

  update(deltaTime = 0): void {
    for (const view of this.views) {
      const { enemy, group } = view;

      // Un corps abattu reste visible s'il a une image de mort à montrer.
      if (enemy.state === 'dead' && !view.model) {
        group.visible = false;
        continue;
      }

      const [x, y, z] = quakeToThree(enemy.origin[0], enemy.origin[1], enemy.origin[2]);
      group.position.set(x, y, z);
      // Le passage au repère de rendu est une rotation, qui conserve le sens :
      // le lacet se transmet tel quel. L'inverser retournait les créatures en
      // miroir, et l'on voyait tirer de dos un adversaire qui vous visait.
      group.rotation.y = enemy.yaw;

      if (view.model && view.animations) {
        // Changer de séquence remet le compteur à zéro, sinon une mort
        // reprendrait au milieu de son mouvement.
        const wanted = rangeForState(view.animations, this.wantedFor(enemy));
        if (wanted !== view.current) {
          view.current = wanted;
          view.elapsed = 0;
        }
        view.elapsed += deltaTime;
        view.model.playRange(view.elapsed, wanted.first, wanted.count, wanted.fps, wanted.loop);
        continue;
      }

      if (!view.eyeMaterial) continue;

      if (enemy.state === 'dying') {
        // La créature s'affaisse et s'enfonce légèrement.
        group.rotation.x = -enemy.deathProgress * Math.PI * 0.42;
        group.position.y -= enemy.deathProgress * enemy.profile.height * 0.22;
        view.eyeMaterial.color.setRGB(0.2, 0.05, 0.05);
      } else {
        // L'oeil s'allume dès que la créature a repéré le joueur.
        const awake = enemy.state === 'chasing' || enemy.state === 'attacking';
        view.eyeMaterial.color.setRGB(awake ? 2.2 : 0.5, awake ? 0.5 : 0.18, 0.2);
      }
    }
  }

  /** Transmet la lampe portée aux modèles, comme pour l'arme. */
  setFlashlight(position: THREE.Vector3, color: THREE.Color, radius: number): void {
    for (const view of this.views) view.model?.setFlashlight(position, color, radius);
  }

  get modelCount(): number {
    return this.views.filter((view) => view.model !== null).length;
  }

  dispose(): void {
    for (const view of this.views) view.model?.dispose();
    this.root.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        object.geometry.dispose();
        (object.material as THREE.Material).dispose();
      }
    });
  }
}

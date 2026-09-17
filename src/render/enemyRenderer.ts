import * as THREE from 'three';
import type { Enemy } from '../game/entities/Enemy';
import { quakeToThree } from './world';
import { SHADOW_CASTER_LAYER } from './shadows';

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
  eyeMaterial: THREE.MeshBasicMaterial;
}

/** Affiche les adversaires et suit leur état image par image. */
export class EnemyRenderer {
  readonly root = new THREE.Group();
  private readonly views: EnemyView[] = [];

  constructor(enemies: Enemy[]) {
    this.root.name = 'enemies';

    for (const enemy of enemies) {
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
      });
      this.root.add(group);
    }
  }

  update(): void {
    for (const view of this.views) {
      const { enemy, group } = view;

      if (enemy.state === 'dead') {
        group.visible = false;
        continue;
      }

      const [x, y, z] = quakeToThree(enemy.origin[0], enemy.origin[1], enemy.origin[2]);
      group.position.set(x, y, z);
      // Le lacet du jeu tourne autour de la verticale, inversé au passage
      // dans le repère de rendu.
      group.rotation.y = -enemy.yaw;

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

  dispose(): void {
    this.root.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        object.geometry.dispose();
        (object.material as THREE.Material).dispose();
      }
    });
  }
}

import type * as THREE from 'three';

/** Jeu de cartes résolu pour un matériau, prêt à alimenter un rendu. */
export interface ResolvedMaterial {
  id: string;
  baseColor: THREE.Texture | null;
  normal: THREE.Texture | null;
  roughness: THREE.Texture | null;
  ao: THREE.Texture | null;
  metallic: THREE.Texture | null;
  emissive: THREE.Texture | null;
  roughnessValue: number;
  metalnessValue: number;
  normalScale: number;
  textureScale: number;
  emissiveIntensity: number;
}

/**
 * Un matériau résolu est partagé par toutes les surfaces qui le réclament :
 * une carte peut compter des centaines de faces pour une poignée de matériaux.
 */
export class MaterialCache {
  private readonly entries = new Map<string, ResolvedMaterial>();

  get(id: string): ResolvedMaterial | null {
    return this.entries.get(id) ?? null;
  }

  set(id: string, material: ResolvedMaterial): void {
    this.entries.set(id, material);
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  get size(): number {
    return this.entries.size;
  }

  dispose(): void {
    for (const material of this.entries.values()) {
      material.baseColor?.dispose();
      material.normal?.dispose();
      material.roughness?.dispose();
      material.ao?.dispose();
      material.metallic?.dispose();
      material.emissive?.dispose();
    }
    this.entries.clear();
  }
}

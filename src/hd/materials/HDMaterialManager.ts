import * as THREE from 'three';
import {
  surfaceRoughness,
  type HDMaterialDefinition,
  type MaterialLibraryFile,
} from './MaterialDefinition';
import { MaterialCache, type ResolvedMaterial } from './MaterialCache';
import { MaterialResolver } from './MaterialResolver';
import { TextureCache } from './TextureCache';

export interface HDMaterialStats {
  definitions: number;
  assignments: number;
  resolved: number;
  textures: number;
  /** Textures d'origine effectivement remplacées sur la carte chargée. */
  applied: string[];
}

/**
 * Couche haute définition des matériaux.
 *
 * Elle ne remplace jamais le rendu d'origine : elle propose une conversion
 * quand elle en a une, et se tait sinon. Une carte peut donc être convertie
 * progressivement, surface par surface, sans jamais être cassée.
 */
export class HDMaterialManager {
  private readonly resolver = new MaterialResolver();
  private readonly materials = new MaterialCache();
  private readonly textures: TextureCache;
  private readonly applied = new Set<string>();

  constructor(anisotropy: number) {
    this.textures = new TextureCache(anisotropy);
  }

  async loadLibrary(url = 'materials/index.json'): Promise<boolean> {
    return this.resolver.loadLibrary(url);
  }

  register(library: MaterialLibraryFile): void {
    this.resolver.register(library);
  }

  /** Noms de textures d'origine pour lesquels une conversion est déclarée. */
  assignedTextures(): string[] {
    return this.resolver.assignedTextures();
  }

  /**
   * Prépare les matériaux des textures citées par une carte.
   * Le chargement est groupé ici pour que la construction du monde, elle,
   * reste synchrone.
   */
  async prepare(textureNames: string[]): Promise<void> {
    const wanted = new Map<string, HDMaterialDefinition>();
    for (const name of textureNames) {
      const definition = this.resolver.resolve(name);
      if (definition && !this.materials.has(definition.id)) {
        wanted.set(definition.id, definition);
      }
    }

    await Promise.all(
      [...wanted.values()].map(async (definition) => {
        const resolved = await this.build(definition);
        if (resolved) this.materials.set(definition.id, resolved);
      }),
    );
  }

  private async build(definition: HDMaterialDefinition): Promise<ResolvedMaterial | null> {
    const load = (file: string | undefined, colorSpace: THREE.ColorSpace) =>
      file ? this.textures.load(this.resolver.resolvePath(file), colorSpace) : Promise.resolve(null);

    const [baseColor, normal, roughness, ao, metallic, emissive] = await Promise.all([
      load(definition.baseColor, THREE.SRGBColorSpace),
      load(definition.normal, THREE.NoColorSpace),
      load(definition.roughness, THREE.NoColorSpace),
      load(definition.ao, THREE.NoColorSpace),
      load(definition.metallic, THREE.NoColorSpace),
      load(definition.emissive, THREE.SRGBColorSpace),
    ]);

    // Un matériau qui n'apporte aucune carte n'a aucune raison de remplacer
    // la texture d'origine.
    if (!baseColor && !normal && !roughness && !ao && !metallic && !emissive) return null;

    const fallbackRoughness = definition.surface
      ? surfaceRoughness[definition.surface]
      : 0.8;

    return {
      id: definition.id,
      baseColor,
      normal,
      roughness,
      ao,
      metallic,
      emissive,
      roughnessValue: definition.roughnessValue ?? fallbackRoughness,
      metalnessValue: definition.metalnessValue ?? 0,
      normalScale: definition.normalScale ?? 1,
      textureScale: definition.textureScale ?? 1,
      emissiveIntensity: definition.emissiveIntensity ?? 1,
    };
  }

  /** Matériau haute définition d'une texture d'origine, s'il en existe un. */
  resolve(quakeTextureName: string): ResolvedMaterial | null {
    const definition = this.resolver.resolve(quakeTextureName);
    if (!definition) return null;
    const resolved = this.materials.get(definition.id);
    if (resolved) this.applied.add(quakeTextureName.toLowerCase());
    return resolved;
  }

  get stats(): HDMaterialStats {
    return {
      definitions: this.resolver.definitionCount,
      assignments: this.resolver.assignmentCount,
      resolved: this.materials.size,
      textures: this.textures.size,
      applied: [...this.applied].sort(),
    };
  }

  dispose(): void {
    this.materials.dispose();
    void this.textures.dispose();
    this.applied.clear();
  }
}

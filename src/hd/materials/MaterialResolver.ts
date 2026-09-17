import type { HDMaterialDefinition, MaterialLibraryFile } from './MaterialDefinition';

/**
 * Fait le lien entre le nom d'une texture d'origine et un matériau haute
 * définition. Cette table est la seule chose à enrichir pour convertir une
 * carte surface par surface : le lecteur de niveaux n'en sait rien.
 */
export class MaterialResolver {
  private readonly definitions = new Map<string, HDMaterialDefinition>();
  private readonly assignments = new Map<string, string>();
  private basePath = '';

  /** Charge une bibliothèque de matériaux ; son absence n'est pas une erreur. */
  async loadLibrary(url: string): Promise<boolean> {
    try {
      const response = await fetch(url);
      if (!response.ok) return false;
      const library = (await response.json()) as MaterialLibraryFile;
      this.register(library);
      return true;
    } catch {
      return false;
    }
  }

  register(library: MaterialLibraryFile): void {
    this.basePath = library.basePath ?? this.basePath;
    for (const definition of library.materials ?? []) {
      this.definitions.set(definition.id, definition);
    }
    for (const [texture, id] of Object.entries(library.assign ?? {})) {
      this.assignments.set(normalize(texture), id);
    }
  }

  /**
   * Matériau associé à une texture d'origine, ou null si aucune conversion
   * n'existe. L'appelant retombe alors sur la texture d'origine.
   */
  resolve(quakeTextureName: string): HDMaterialDefinition | null {
    const key = normalize(quakeTextureName);
    const id = this.assignments.get(key);
    if (!id) return null;
    return this.definitions.get(id) ?? null;
  }

  /** Chemin complet d'un fichier de carte, préfixe de bibliothèque compris. */
  resolvePath(file: string): string {
    if (/^(https?:)?\/\//.test(file) || file.startsWith('/')) return file;
    return `${this.basePath}${file}`;
  }

  get definitionCount(): number {
    return this.definitions.size;
  }

  get assignmentCount(): number {
    return this.assignments.size;
  }

  /** Noms de textures convertis, utile pour un état des lieux. */
  assignedTextures(): string[] {
    return [...this.assignments.keys()];
  }
}

/** Les noms de textures d'origine sont insensibles à la casse. */
function normalize(name: string): string {
  return name.trim().toLowerCase();
}

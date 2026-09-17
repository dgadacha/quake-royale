/**
 * Description d'un matériau haute définition, indépendante du moteur de rendu.
 *
 * Aucune carte n'est obligatoire : un matériau peut n'apporter qu'une couleur
 * de base, ou qu'un relief. Ce qui manque est comblé par la texture d'origine
 * ou par les valeurs scalaires.
 */
export interface HDMaterialDefinition {
  id: string;

  baseColor?: string;
  normal?: string;
  roughness?: string;
  ao?: string;
  metallic?: string;
  emissive?: string;

  roughnessValue?: number;
  metalnessValue?: number;
  normalScale?: number;

  /**
   * Répétition de la texture par rapport à la surface d'origine.
   * 1 conserve l'échelle de la carte ; 2 resserre le motif de moitié.
   */
  textureScale?: number;
  emissiveIntensity?: number;

  /** Nature physique de la surface, pour les impacts, les pas et les sons. */
  surface?: SurfaceType;
}

export type SurfaceType = 'stone' | 'metal' | 'wood' | 'water' | 'flesh' | 'dirt';

/** Rugosités indicatives par nature de surface, quand aucune carte n'est fournie. */
export const surfaceRoughness: Record<SurfaceType, number> = {
  stone: 0.85,
  metal: 0.45,
  wood: 0.75,
  water: 0.15,
  flesh: 0.6,
  dirt: 0.9,
};

/** Fichier optionnel décrivant les matériaux disponibles et leur affectation. */
export interface MaterialLibraryFile {
  /** Chemin commun ajouté devant chaque fichier, par exemple "materials/". */
  basePath?: string;
  materials: HDMaterialDefinition[];
  /** Nom de texture d'origine vers identifiant de matériau. */
  assign?: Record<string, string>;
}

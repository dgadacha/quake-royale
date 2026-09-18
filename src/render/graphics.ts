export type QualityPreset = 'low' | 'medium' | 'high' | 'ultra' | 'custom';

/** Réglages d'image, modifiables en jeu et conservés d'une session à l'autre. */
export interface GraphicsSettings {
  ambientOcclusion: boolean;
  aoIntensity: number;
  aoRadius: number;
  reflections: boolean;
  reflectionStrength: number;
  bloom: boolean;
  bloomStrength: number;
  grain: boolean;
  /** Échelle de rendu des effets lourds, entre 0.5 et 1. */
  effectScale: number;
  /** Sources dynamiques calculées simultanément. */
  dynamicLights: boolean;
  maxLights: number;
  /** Dosages de l'apport dynamique, par-dessus l'éclairage cuit. */
  lightDiffuse: number;
  lightSpecular: number;
  shadows: boolean;
  shadowResolution: number;
  /**
   * Tri des surfaces par la visibilité précalculée des cartes.
   * Il divise par dix le nombre de faces dessinées.
   */
  visibilityCulling: boolean;
  /** Intensité de l'éclairage cuit. */
  brightness: number;
  /** Creuse ou aplanit les zones peu éclairées. */
  contrast: number;
  /** Préréglage dont les valeurs sont issues, ou 'custom' après un ajustement. */
  preset: QualityPreset;
}

export const defaultGraphics = (): GraphicsSettings => ({
  ambientOcclusion: true,
  aoIntensity: 1.15,
  aoRadius: 38,
  reflections: true,
  // Un sol de pierre n'est pas un miroir : au-delà, la salle paraît vernie.
  reflectionStrength: 0.35,
  bloom: true,
  bloomStrength: 0.55,
  grain: true,
  // L'occlusion est calculée en résolution réduite puis lissée : le flou la
  // rattrape entièrement, pour un quart du coût.
  effectScale: 0.5,
  dynamicLights: true,
  maxLights: 8,
  // Les lightmaps portent déjà le diffus : une pleine dose délaverait tout.
  lightDiffuse: 0.32,
  lightSpecular: 1.0,
  shadows: true,
  shadowResolution: 1024,
  visibilityCulling: true,
  brightness: 2.1,
  // Plus la valeur est haute, plus les zones sombres s'enfoncent.
  contrast: 1.15,
  preset: 'high',
});

/**
 * Quatre marches de qualité. Chacune pèse sur ce qui coûte réellement :
 * le nombre de sources calculées, la résolution des effets d'écran et les
 * ombres, dans cet ordre d'importance.
 */
export const qualityPresets: Record<
  Exclude<QualityPreset, 'custom'>,
  Omit<GraphicsSettings, 'preset'>
> = {
  low: {
    ambientOcclusion: false,
    aoIntensity: 1,
    aoRadius: 32,
    reflections: false,
    reflectionStrength: 0,
    bloom: true,
    bloomStrength: 0.4,
    grain: false,
    effectScale: 0.5,
    dynamicLights: true,
    maxLights: 3,
    lightDiffuse: 0.32,
    lightSpecular: 0.8,
    shadows: false,
    shadowResolution: 512,
    visibilityCulling: true,
    brightness: 2.1,
    contrast: 1.15,
  },
  medium: {
    ambientOcclusion: true,
    aoIntensity: 1,
    aoRadius: 34,
    reflections: false,
    reflectionStrength: 0,
    bloom: true,
    bloomStrength: 0.5,
    grain: true,
    effectScale: 0.5,
    dynamicLights: true,
    maxLights: 5,
    lightDiffuse: 0.32,
    lightSpecular: 1,
    shadows: true,
    shadowResolution: 1024,
    visibilityCulling: true,
    brightness: 2.1,
    contrast: 1.15,
  },
  high: {
    ambientOcclusion: true,
    aoIntensity: 1.15,
    aoRadius: 38,
    reflections: true,
    reflectionStrength: 0.35,
    bloom: true,
    bloomStrength: 0.55,
    grain: true,
    effectScale: 0.5,
    dynamicLights: true,
    maxLights: 8,
    lightDiffuse: 0.32,
    lightSpecular: 1,
    shadows: true,
    shadowResolution: 1024,
    visibilityCulling: true,
    brightness: 2.1,
    contrast: 1.15,
  },
  ultra: {
    ambientOcclusion: true,
    aoIntensity: 1.25,
    aoRadius: 44,
    reflections: true,
    reflectionStrength: 0.45,
    bloom: true,
    bloomStrength: 0.55,
    grain: true,
    effectScale: 1,
    dynamicLights: true,
    maxLights: 12,
    lightDiffuse: 0.35,
    lightSpecular: 1.15,
    shadows: true,
    shadowResolution: 2048,
    visibilityCulling: true,
    brightness: 2.1,
    contrast: 1.15,
  },
};

export function applyPreset(preset: Exclude<QualityPreset, 'custom'>): GraphicsSettings {
  return { ...qualityPresets[preset], preset };
}

const STORAGE_KEY = 'quake-hd.graphics';

export function loadGraphics(): GraphicsSettings {
  const defaults = defaultGraphics();
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return defaults;
    return { ...defaults, ...(JSON.parse(stored) as Partial<GraphicsSettings>) };
  } catch {
    // Stockage indisponible ou contenu illisible : on repart des valeurs par défaut.
    return defaults;
  }
}

export function saveGraphics(settings: GraphicsSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Le réglage vaudra pour la session en cours seulement.
  }
}

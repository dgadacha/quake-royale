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
});

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

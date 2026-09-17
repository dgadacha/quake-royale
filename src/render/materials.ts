import * as THREE from 'three';
import {
  liquidFragmentShader,
  liquidVertexShader,
  skyFragmentShader,
  skyVertexShader,
  worldFragmentShader,
  worldVertexShader,
} from './worldShader';
import type { TextureSet } from './textures';

export interface SurfaceUniformSettings {
  lightScale: number;
  lightGamma: number;
  ambient: THREE.Color;
  fogColor: THREE.Color;
  fogDensity: number;
  specular: number;
  emissiveStrength: number;
  detailStrength: number;
  atlasSize: number;
}

export function createWorldMaterial(
  set: TextureSet,
  lightmap: THREE.Texture,
  styleLut: THREE.Texture,
  detail: THREE.Texture,
  fallbackTexture: THREE.Texture,
  settings: SurfaceUniformSettings,
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: worldVertexShader,
    fragmentShader: worldFragmentShader,
    uniforms: {
      uMap: { value: set.map },
      uSurface: { value: set.surfaceMap },
      uEmissive: { value: set.emissiveMap ?? fallbackTexture },
      uHasEmissive: { value: set.emissiveMap ? 1 : 0 },
      uLightmap: { value: lightmap },
      uStyleLut: { value: styleLut },
      uDetail: { value: detail },
      uLightScale: { value: settings.lightScale },
      uLightGamma: { value: settings.lightGamma },
      uAmbient: { value: settings.ambient },
      uSpecular: { value: settings.specular },
      uDetailScale: { value: 7.0 },
      uDetailStrength: { value: settings.detailStrength },
      uLightmapTexel: { value: 1 / settings.atlasSize },
      uNormalFlipY: { value: -1 },
      uFogColor: { value: settings.fogColor },
      uFogDensity: { value: settings.fogDensity },
      uEmissiveStrength: { value: settings.emissiveStrength },
      uTime: { value: 0 },
      uWarpAmount: { value: 0 },
      uFlashPos: { value: new THREE.Vector3() },
      uFlashColor: { value: new THREE.Color(0, 0, 0) },
      uFlashRadius: { value: 0 },
    },
  });
}

export type LiquidKind = 'water' | 'slime' | 'lava' | 'teleport';

export function liquidTint(kind: LiquidKind): THREE.Color {
  switch (kind) {
    case 'lava':
      return new THREE.Color(1.5, 0.75, 0.35);
    case 'slime':
      return new THREE.Color(0.75, 1.1, 0.6);
    case 'teleport':
      return new THREE.Color(0.8, 0.7, 1.4);
    default:
      return new THREE.Color(0.58, 0.74, 0.86);
  }
}

export function createLiquidMaterial(
  map: THREE.Texture,
  kind: LiquidKind,
  settings: SurfaceUniformSettings,
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: liquidVertexShader,
    fragmentShader: liquidFragmentShader,
    uniforms: {
      uMap: { value: map },
      uTime: { value: 0 },
      uTint: { value: liquidTint(kind) },
      uEmissiveStrength: { value: kind === 'lava' ? 1.1 : kind === 'teleport' ? 0.8 : 0.05 },
      uOpacity: { value: kind === 'water' ? 0.86 : 1 },
      uWarp: { value: 0.035 },
      uWaveHeight: { value: kind === 'water' ? 1.6 : 0.8 },
      uFogColor: { value: settings.fogColor },
      uFogDensity: { value: settings.fogDensity },
      uFlashPos: { value: new THREE.Vector3() },
      uFlashColor: { value: new THREE.Color(0, 0, 0) },
      uFlashRadius: { value: 0 },
    },
    transparent: kind === 'water',
    depthWrite: kind !== 'water',
  });
}

export function createSkyMaterial(
  front: THREE.Texture,
  back: THREE.Texture,
  fogColor: THREE.Color,
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: skyVertexShader,
    fragmentShader: skyFragmentShader,
    uniforms: {
      uLayerFront: { value: front },
      uLayerBack: { value: back },
      uTime: { value: 0 },
      uTint: { value: new THREE.Color(0.85, 0.88, 1.0) },
      uBrightness: { value: 1.25 },
      uFogColor: { value: fogColor },
      uFogAmount: { value: 0.75 },
    },
    depthWrite: true,
  });
}

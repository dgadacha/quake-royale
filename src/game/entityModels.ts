import * as THREE from 'three';
import type { BspEntity } from '../formats/bsp';
import { parseMdl } from '../formats/mdl';
import type { VirtualFileSystem } from '../formats/pak';
import type { Palette } from '../formats/palette';
import { AliasModel, type AliasModelOptions } from '../render/aliasModel';
import { quakeToThree } from '../render/world';

/**
 * Correspondance entre le nom d'une entité et le fichier de modèle à afficher.
 * Elle est volontairement extensible : un fichier data/entities.json fourni
 * par l'utilisateur complète ou remplace ces entrées, et toute entrée dont le
 * fichier est absent des données montées est simplement ignorée.
 */
export type EntityModelMap = Record<string, string>;

export const defaultEntityModels: EntityModelMap = {
  prop_test: 'progs/testprop.mdl',
};

export interface PlacedEntity {
  classname: string;
  model: AliasModel;
  /** Vitesse d'animation propre à l'entité. */
  fps: number;
}

function parseOrigin(value: string | undefined): [number, number, number] | null {
  if (!value) return null;
  const parts = value.trim().split(/\s+/).map(Number);
  if (parts.length < 3 || parts.some(Number.isNaN)) return null;
  return [parts[0], parts[1], parts[2]];
}

/** Instancie les modèles des entités présentes dans la carte. */
export function placeEntities(
  entities: BspEntity[],
  vfs: VirtualFileSystem,
  palette: Palette,
  mapping: EntityModelMap,
  options: AliasModelOptions,
): { group: THREE.Group; placed: PlacedEntity[] } {
  const group = new THREE.Group();
  group.name = 'entities';
  const placed: PlacedEntity[] = [];

  // Un modèle n'est analysé qu'une fois, même s'il apparaît cent fois.
  const cache = new Map<string, ReturnType<typeof parseMdl> | null>();
  const load = (path: string) => {
    if (!cache.has(path)) {
      const data = vfs.read(path);
      try {
        cache.set(path, data ? parseMdl(data) : null);
      } catch (error) {
        console.warn(`[quake-hd] modèle illisible ${path} : ${(error as Error).message}`);
        cache.set(path, null);
      }
    }
    return cache.get(path) ?? null;
  };

  for (const entity of entities) {
    const path = mapping[entity.classname];
    if (!path) continue;
    const origin = parseOrigin(entity.origin);
    if (!origin) continue;
    const parsed = load(path);
    if (!parsed) continue;

    const model = new AliasModel(parsed, palette, options);
    const [x, y, z] = quakeToThree(origin[0], origin[1], origin[2]);
    model.mesh.position.set(x, y, z);
    const angle = Number.parseFloat(entity.angle ?? '0');
    if (!Number.isNaN(angle)) model.mesh.rotation.y = angle * (Math.PI / 180);

    group.add(model.mesh);
    placed.push({ classname: entity.classname, model, fps: 6 });
  }

  return { group, placed };
}

export async function loadEntityMapping(): Promise<EntityModelMap> {
  try {
    const response = await fetch('data/entities.json');
    if (!response.ok) return { ...defaultEntityModels };
    const custom = (await response.json()) as EntityModelMap;
    return { ...defaultEntityModels, ...custom };
  } catch {
    return { ...defaultEntityModels };
  }
}

import type { VirtualFileSystem } from '../formats/pak';
import { parseEntities } from '../formats/bsp';

export interface MapEntry {
  path: string;
  /** Nom de fichier, sans dossier ni extension. */
  code: string;
  /** Nom du niveau tel que la carte le déclare, si elle en déclare un. */
  title: string | null;
  episode: string;
  order: number;
}

/**
 * Nom d'un niveau, lu dans la carte elle-même.
 *
 * Une carte déclare son titre dans son entité de monde. Seul ce premier bloc
 * de données est lu, sans analyser la géométrie : le catalogue reste immédiat
 * même sur une soixantaine de cartes.
 */
export function readMapTitle(vfs: VirtualFileSystem, path: string): string | null {
  const data = vfs.read(path);
  if (!data || data.byteLength < 128) return null;

  try {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    if (view.getInt32(0, true) !== 29) return null;

    const offset = view.getInt32(4, true);
    const length = view.getInt32(8, true);
    if (offset <= 0 || length <= 0 || offset + length > data.byteLength) return null;

    // Le titre figure dans le tout premier bloc : inutile de lire au-delà.
    const slice = data.subarray(offset, offset + Math.min(length, 2048));
    const entities = parseEntities(new TextDecoder('latin1').decode(slice));
    const world = entities.find((entity) => entity.classname === 'worldspawn');
    const title = world?.message?.trim();
    return title ? title : null;
  } catch {
    return null;
  }
}

/** Cartes utilitaires : objets et décors, pas des niveaux jouables. */
function isPlayable(code: string): boolean {
  return !/^b_/.test(code);
}

/**
 * Rangement des cartes pour le menu.
 *
 * Les noms de fichiers suivent une convention d'épisode et de numéro, ce qui
 * donne un ordre de parcours fidèle sans avoir à l'écrire nulle part.
 */
export function buildCatalog(vfs: VirtualFileSystem, paths: string[]): MapEntry[] {
  const entries: MapEntry[] = [];

  for (const path of paths) {
    const code = path.replace(/^.*\//, '').replace(/\.bsp$/i, '').toLowerCase();
    if (!isPlayable(code)) continue;

    const episodeMatch = /^e(\d)m(\d+)/.exec(code);
    const deathmatch = /^dm(\d+)/.exec(code);

    let episode: string;
    let order: number;
    if (episodeMatch) {
      episode = `Épisode ${episodeMatch[1]}`;
      order = Number.parseInt(episodeMatch[2], 10);
    } else if (deathmatch) {
      episode = 'Arènes';
      order = Number.parseInt(deathmatch[1], 10);
    } else if (code === 'start') {
      episode = 'Entrée';
      order = 0;
    } else {
      episode = 'Autres';
      order = 0;
    }

    entries.push({ path, code, title: readMapTitle(vfs, path), episode, order });
  }

  return entries;
}

const EPISODE_ORDER = ['Entrée', 'Épisode 1', 'Épisode 2', 'Épisode 3', 'Épisode 4', 'Arènes'];

/** Regroupe et ordonne les entrées pour l'affichage. */
export function groupCatalog(entries: MapEntry[]): { episode: string; maps: MapEntry[] }[] {
  const groups = new Map<string, MapEntry[]>();
  for (const entry of entries) {
    const list = groups.get(entry.episode) ?? [];
    list.push(entry);
    groups.set(entry.episode, list);
  }

  for (const list of groups.values()) {
    list.sort((a, b) => a.order - b.order || a.code.localeCompare(b.code));
  }

  return [...groups.entries()]
    .map(([episode, maps]) => ({ episode, maps }))
    .sort((a, b) => {
      const ia = EPISODE_ORDER.indexOf(a.episode);
      const ib = EPISODE_ORDER.indexOf(b.episode);
      // Les groupes inconnus se rangent après ceux que l'on sait ordonner.
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    });
}

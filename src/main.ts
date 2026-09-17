import { PakArchive, VirtualFileSystem } from './formats/pak';
import { loadBspLevel, loadDemoLevel, type Level } from './game/level';
import { Session } from './game/session';
import { Overlay } from './ui/overlay';
import { installHarness } from './dev/harness';
import { loadEntityMapping, type EntityModelMap } from './game/entityModels';

const canvas = document.getElementById('viewport') as HTMLCanvasElement;
const overlayRoot = document.getElementById('overlay') as HTMLElement;

const session = new Session(canvas);
const overlay = new Overlay(overlayRoot);
const vfs = new VirtualFileSystem();

let statsVisible = true;
if (new URLSearchParams(location.search).has('dev')) installHarness(session);
/** Cartes annoncées par public/data/manifest.json, chargées à la demande. */
let remoteMaps: string[] = [];
let entityModels: EntityModelMap = {};

/** Laisse le navigateur peindre entre deux étapes lourdes. */
const yieldToBrowser = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

interface DataManifest {
  paks?: string[];
  maps?: string[];
  /** Fichiers isolés à monter tels quels : modèles, palette, textures. */
  files?: string[];
}

async function readManifest(): Promise<DataManifest> {
  try {
    const response = await fetch('data/manifest.json');
    if (!response.ok) return {};
    return (await response.json()) as DataManifest;
  } catch {
    return {};
  }
}

async function mountLocalPaks(extra: string[]): Promise<string[]> {
  const notes: string[] = [];
  for (const name of [...new Set(['pak0.pak', 'pak1.pak', 'pak2.pak', ...extra])]) {
    try {
      const response = await fetch(`data/${name}`);
      if (!response.ok) continue;
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength < 12) continue;
      vfs.mount(new PakArchive(buffer, name));
      notes.push(name);
    } catch {
      // Fichier absent : c'est le cas normal tant que rien n'a été copié.
    }
  }
  return notes;
}

/** Monte les fichiers annoncés par le manifeste, sans bloquer si l'un manque. */
async function mountManifestFiles(files: string[]): Promise<number> {
  let mounted = 0;
  for (const path of files) {
    try {
      const response = await fetch(`data/${path}`);
      if (!response.ok) continue;
      vfs.addFile(path, new Uint8Array(await response.arrayBuffer()));
      mounted++;
    } catch {
      // Fichier indisponible : la carte se chargera sans lui.
    }
  }
  return mounted;
}

async function fetchRemoteMap(path: string): Promise<void> {
  const response = await fetch(`data/${path}`);
  if (!response.ok) throw new Error(`carte introuvable : data/${path}`);
  vfs.addFile(path, new Uint8Array(await response.arrayBuffer()));
}

function refreshMenu(note?: string): void {
  const maps = [...new Set([...vfs.list('maps/', '.bsp'), ...remoteMaps])].sort();
  overlay.setHudVisible(false);
  overlay.showMenu(maps, {
    onDemo: () => void startLevel(() => loadDemoLevel(session.options), 'arène de démonstration'),
    onMap: (path) =>
      void startLevel(async () => {
        if (!vfs.read(path)) await fetchRemoteMap(path);
        return loadBspLevel(vfs, path, session.options, entityModels);
      }, path),
    onFiles: (files) => void addFiles(files),
  }, note);
}

async function addFiles(files: FileList): Promise<void> {
  overlay.showLoading('Lecture des fichiers');
  const added: string[] = [];
  let index = 0;

  for (const file of Array.from(files)) {
    overlay.setProgress(index / files.length, file.name);
    await yieldToBrowser();
    try {
      const buffer = await file.arrayBuffer();
      const lower = file.name.toLowerCase();
      if (lower.endsWith('.pak')) {
        vfs.mount(new PakArchive(buffer, file.name));
        added.push(file.name);
      } else if (lower.endsWith('.bsp')) {
        vfs.addFile(`maps/${lower}`, new Uint8Array(buffer));
        added.push(file.name);
      } else if (lower.endsWith('.lmp')) {
        vfs.addFile(`gfx/${lower}`, new Uint8Array(buffer));
        added.push(file.name);
      } else {
        vfs.addFile(lower, new Uint8Array(buffer));
        added.push(file.name);
      }
    } catch (error) {
      overlay.setStatus(`${file.name} : ${(error as Error).message}`, true);
      await new Promise((resolve) => setTimeout(resolve, 1200));
    }
    index++;
  }

  refreshMenu(added.length ? `Monté : ${added.join(', ')}` : 'Aucun fichier exploitable.');
}

async function startLevel(factory: () => Level | Promise<Level>, label: string): Promise<void> {
  overlay.showLoading(label);
  overlay.setProgress(0.15, 'Analyse de la géométrie');
  await yieldToBrowser();

  try {
    const started = performance.now();
    overlay.setProgress(0.45, 'Construction des surfaces et des lightmaps');
    await yieldToBrowser();

    const level = await factory();
    overlay.setProgress(0.9, 'Préparation du rendu');
    await yieldToBrowser();

    session.setLevel(level);
    session.start();
    overlay.hide();
    overlay.setHudVisible(true);
    overlay.setHint(
      'Cliquez pour prendre le contrôle<br /><span style="opacity:.6">Échap pour revenir au menu</span>',
    );

    const elapsed = Math.round(performance.now() - started);
    console.info(
      `[quake-hd] ${level.name} : ${level.stats.faces} faces, ${level.stats.draws} lots, ` +
        `${level.stats.textures} textures, ${level.stats.lightmapPages} page(s) de lightmap, ${elapsed} ms`,
    );
  } catch (error) {
    console.error(error);
    overlay.showError((error as Error).message, () => refreshMenu());
  }
}

session.setStatsListener((stats) => {
  if (!statsVisible) return;
  overlay.setStats(
    `<b>${stats.fps.toFixed(0)}</b> fps · <b>${stats.speed.toFixed(0)}</b> u/s<br />` +
      `x ${stats.position[0].toFixed(0)} y ${stats.position[1].toFixed(0)} z ${stats.position[2].toFixed(0)}<br />` +
      `${stats.draws} appels · ${stats.faces} faces · ${stats.textures} textures`,
  );
});

canvas.addEventListener('click', () => {
  if (session.currentLevel && !session.input.locked) session.input.requestLock();
});

document.addEventListener('pointerlockchange', () => {
  const locked = document.pointerLockElement === canvas;
  overlay.setHint(
    locked ? '' : 'Cliquez pour prendre le contrôle<br /><span style="opacity:.6">Échap pour revenir au menu</span>',
  );
});

window.addEventListener('keydown', (event) => {
  if (event.code === 'Escape' && session.currentLevel && !session.input.locked) {
    session.stop();
    refreshMenu();
  }
  if (event.code === 'F3') {
    statsVisible = !statsVisible;
    if (!statsVisible) overlay.setStats('');
  }
});

void (async () => {
  overlay.showLoading('Recherche des données locales');
  const manifest = await readManifest();
  remoteMaps = manifest.maps ?? [];
  const mounted = await mountLocalPaks(manifest.paks ?? []);
  await mountManifestFiles(manifest.files ?? []);
  entityModels = await loadEntityMapping();
  refreshMenu(
    mounted.length
      ? `Archives montées depuis public/data : ${mounted.join(', ')}`
      : 'Aucune archive dans public/data. La démonstration ne nécessite rien.',
  );
})();

import { PakArchive, VirtualFileSystem } from './formats/pak';
import { loadBspLevel, loadDemoLevel, type Level } from './game/level';
import { Session } from './game/session';
import { Overlay, type GraphicsRow } from './ui/overlay';
import { applyPreset, type QualityPreset } from './render/graphics';
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
    onGraphics: () => showGraphicsPanel(note),
  }, note);
}

function showGraphicsPanel(note?: string): void {
  const settings = session.graphicsSettings;
  const rows: GraphicsRow[] = [
    {
      key: 'preset',
      label: 'Qualité',
      hint: 'Règle en une fois tout ce qui pèse sur les performances.',
      kind: 'choice',
      value: settings.preset,
      choices: [
        { value: 'low', label: 'Bas' },
        { value: 'medium', label: 'Moyen' },
        { value: 'high', label: 'Élevé' },
        { value: 'ultra', label: 'Maximal' },
      ],
    },
    {
      key: 'shadows',
      label: 'Ombres portées',
      hint: 'Projetées par les objets mobiles. Celles du décor sont déjà cuites.',
      kind: 'toggle',
      value: settings.shadows,
    },
    {
      key: 'ambientOcclusion',
      label: 'Occlusion ambiante',
      hint: "Assombrit les angles, les recoins et les contacts entre volumes.",
      kind: 'toggle',
      value: settings.ambientOcclusion,
    },
    {
      key: 'aoIntensity',
      label: 'Force de l\'occlusion',
      kind: 'range',
      value: settings.aoIntensity,
      min: 0.2,
      max: 2,
      step: 0.05,
    },
    {
      key: 'aoRadius',
      label: "Portée de l'occlusion",
      hint: 'En unités de monde. Une portée large creuse les grands volumes.',
      kind: 'range',
      value: settings.aoRadius,
      min: 8,
      max: 96,
      step: 2,
    },
    {
      key: 'reflections',
      label: 'Réflexions',
      hint: 'Reflets sur les sols et les surfaces liquides, calculés dans l\'image.',
      kind: 'toggle',
      value: settings.reflections,
    },
    {
      key: 'reflectionStrength',
      label: 'Force des réflexions',
      kind: 'range',
      value: settings.reflectionStrength,
      min: 0,
      max: 1,
      step: 0.05,
    },
    {
      key: 'bloom',
      label: 'Halo lumineux',
      hint: 'Débordement des sources vives et des surfaces émissives.',
      kind: 'toggle',
      value: settings.bloom,
    },
    {
      key: 'bloomStrength',
      label: 'Force du halo',
      kind: 'range',
      value: settings.bloomStrength,
      min: 0,
      max: 1.5,
      step: 0.05,
    },
    {
      key: 'dynamicLights',
      label: 'Lumières dynamiques',
      hint: "Les sources du niveau reprennent leur couleur et leurs reflets, par-dessus l'éclairage cuit.",
      kind: 'toggle',
      value: settings.dynamicLights,
    },
    {
      key: 'maxLights',
      label: 'Sources simultanées',
      hint: 'Seules les plus proches et les plus fortes sont calculées.',
      kind: 'range',
      value: settings.maxLights,
      min: 2,
      max: 12,
      step: 1,
    },
    {
      key: 'lightSpecular',
      label: 'Reflets des sources',
      kind: 'range',
      value: settings.lightSpecular,
      min: 0,
      max: 2,
      step: 0.05,
    },
    {
      key: 'lightDiffuse',
      label: 'Apport diffus des sources',
      hint: "À monter avec prudence : l'éclairage cuit contient déjà ce diffus.",
      kind: 'range',
      value: settings.lightDiffuse,
      min: 0,
      max: 1,
      step: 0.02,
    },
    { key: 'grain', label: 'Grain', kind: 'toggle', value: settings.grain },
  ];

  overlay.showGraphics(
    rows,
    (key, value) => {
      if (key === 'preset') {
        // Un préréglage écrase tous les réglages : le panneau est redessiné.
        session.setGraphics(applyPreset(value as Exclude<QualityPreset, 'custom'>));
        showGraphicsPanel(note);
        return;
      }
      // Toute retouche fait sortir du préréglage.
      session.setGraphics({ [key]: value, preset: 'custom' });
    },
    () => refreshMenu(note),
  );
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

    if (level.stats.paletteMissing) {
      // Sans palette, les index de texture ne donnent pas les bonnes couleurs.
      // Mieux vaut le dire que laisser croire à un défaut du rendu.
      overlay.setHint(
        'Palette absente : les couleurs des textures ne sont pas les bonnes.<br />' +
          '<span style="opacity:.7">Montez le pak0.pak de votre copie du jeu pour les rétablir.</span>',
      );
      setTimeout(() => overlay.setHint(''), 9000);
    }

    const elapsed = Math.round(performance.now() - started);
    console.info(
      `[quake-hd] ${level.name} : ${level.stats.faces} faces, ${level.stats.draws} lots, ` +
        `${level.stats.textures} textures, ${level.stats.lightmapPages} page(s) de lightmap, ` +
        `${level.stats.hiddenFaces ?? 0} faces de service écartées, ${elapsed} ms` +
        (level.stats.paletteMissing ? ' — palette absente, couleurs approximatives' : ''),
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
  // Bibliothèque de matériaux haute définition : son absence est le cas normal,
  // le jeu se rend alors entièrement avec les textures d'origine.
  const hasLibrary = await session.hdMaterials.loadLibrary();
  if (hasLibrary) {
    await session.hdMaterials.prepare(session.hdMaterials.assignedTextures());
    const stats = session.hdMaterials.stats;
    console.info(
      `[quake-hd] matériaux HD : ${stats.resolved} chargés sur ${stats.definitions} déclarés, ` +
        `${stats.assignments} textures converties`,
    );
  }

  const mounted = await mountLocalPaks(manifest.paks ?? []);
  await mountManifestFiles(manifest.files ?? []);
  entityModels = await loadEntityMapping();
  refreshMenu(
    mounted.length
      ? `Archives montées depuis public/data : ${mounted.join(', ')}`
      : 'Aucune archive dans public/data. La démonstration ne nécessite rien.',
  );
})();

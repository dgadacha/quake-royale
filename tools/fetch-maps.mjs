/**
 * Récupère des cartes depuis un dépôt public et les installe en local.
 *
 * Les fichiers atterrissent dans public/data, qui est ignoré par git : ils
 * restent sur votre machine et ne partent pas dans le dépôt. C'est voulu, le
 * contenu d'un jeu n'a pas à être redistribué avec un moteur.
 *
 * Usage :
 *   node tools/fetch-maps.mjs                  dépôt de sources de cartes par défaut
 *   node tools/fetch-maps.mjs <url git>        un autre dépôt
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const CACHE = resolve(ROOT, 'reference/map-sources');
const MAPS_DIR = resolve(ROOT, 'public/data/maps');

const url = process.argv[2] ?? 'https://github.com/fzwoch/quake_map_source.git';

function walk(directory) {
  const found = [];
  for (const entry of readdirSync(directory)) {
    if (entry === '.git') continue;
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) found.push(...walk(full));
    else found.push(full);
  }
  return found;
}

console.log(`source : ${url}`);

if (existsSync(CACHE)) {
  console.log('dépôt déjà présent, mise à jour');
  try {
    execFileSync('git', ['-C', CACHE, 'pull', '--ff-only'], { stdio: 'inherit' });
  } catch {
    console.log('mise à jour impossible, on garde la copie existante');
  }
} else {
  mkdirSync(dirname(CACHE), { recursive: true });
  execFileSync('git', ['clone', '--depth', '1', url, CACHE], { stdio: 'inherit' });
}

const files = walk(CACHE);
const bsps = files.filter((file) => file.toLowerCase().endsWith('.bsp'));

if (bsps.length === 0) {
  console.log(
    "\naucune carte compilée dans ce dépôt.\n" +
      "Les fichiers .map sont des sources : elles demandent un compilateur de\n" +
      'cartes avant de pouvoir être chargées.',
  );
  process.exit(0);
}

mkdirSync(MAPS_DIR, { recursive: true });
let copied = 0;
for (const bsp of bsps) {
  copyFileSync(bsp, join(MAPS_DIR, basename(bsp).toLowerCase()));
  copied++;
}

console.log(`\n${copied} carte(s) installée(s) dans public/data/maps`);

// Le manifeste est réécrit dans la foulée : le menu les propose aussitôt.
execFileSync('node', [resolve(HERE, 'scan-maps.mjs')], { stdio: 'inherit' });

const wads = files.filter((file) => file.toLowerCase().endsWith('.wad'));
if (wads.length) {
  console.log(
    `\n${wads.length} fichier(s) de textures repere(s) dans le depot.\n` +
      "Les cartes compilees embarquent en general leurs textures. Si l'une\n" +
      "apparait en damier, c'est qu'elle les cherche dans un de ces fichiers.",
  );
}

/**
 * Recense les cartes et les fichiers déposés dans public/data et met le
 * manifeste à jour.
 *
 * Déposez autant de .bsp que vous voulez dans public/data/maps, lancez cet
 * outil, et le menu du jeu les propose toutes. Rien n'est copié ni modifié :
 * l'outil ne fait que lister ce qui est là.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(HERE, '../public/data');
const MANIFEST = resolve(DATA_DIR, 'manifest.json');

/** Parcours récursif, pour accepter une arborescence déposée telle quelle. */
function walk(directory) {
  if (!existsSync(directory)) return [];
  const found = [];
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) found.push(...walk(full));
    else found.push(full);
  }
  return found;
}

/** Une carte lisible annonce la version 29 dans ses quatre premiers octets. */
function isSupportedBsp(path) {
  try {
    const buffer = Buffer.alloc(4);
    const handle = readFileSync(path).subarray(0, 4);
    buffer.set(handle);
    return buffer.readInt32LE(0) === 29;
  } catch {
    return false;
  }
}

const files = walk(DATA_DIR);
const maps = [];
const extras = [];
const paks = [];
const rejected = [];

for (const file of files) {
  const rel = relative(DATA_DIR, file).split('\\').join('/');
  const lower = rel.toLowerCase();

  if (lower.endsWith('.pak')) {
    paks.push(rel);
  } else if (lower.endsWith('.bsp')) {
    if (isSupportedBsp(file)) maps.push(rel);
    else rejected.push(rel);
  } else if (lower.endsWith('.mdl') || lower.endsWith('.spr') || lower.endsWith('.lmp')) {
    extras.push(rel);
  }
}

maps.sort();
extras.sort();
paks.sort();

const manifest = { paks, maps, files: extras };
writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`archives   : ${paks.length}`);
console.log(`cartes     : ${maps.length}`);
console.log(`ressources : ${extras.length}`);
if (rejected.length) {
  console.log(
    `\nignorées (version de format non prise en charge) :\n  ${rejected.join('\n  ')}`,
  );
}
console.log(`\nmanifeste écrit : ${MANIFEST}`);

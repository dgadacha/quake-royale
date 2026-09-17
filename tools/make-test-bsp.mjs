/**
 * Génère une carte BSP version 29 minimale mais valide.
 * Elle sert à exercer le parseur, la construction des surfaces, l'atlas de
 * lightmaps et la collision par clipnodes sans dépendre d'aucune donnée
 * extérieure. La géométrie est une salle creuse.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(HERE, '../public/data/maps');
const OUT_FILE = resolve(OUT_DIR, 'testroom.bsp');

const CONTENTS_EMPTY = -1;
const CONTENTS_SOLID = -2;
const LIGHTMAP_SCALE = 16;

// ---------------------------------------------------------------- géométrie

const ROOM = { min: [-512, -512, 0], max: [512, 512, 320] };
const LIGHTS = [
  { position: [0, 0, 280], radius: 1400, intensity: 1.6 },
  { position: [-320, -320, 160], radius: 700, intensity: 1.1 },
  { position: [320, 320, 160], radius: 700, intensity: 1.1 },
];

/**
 * Gabarits de collision. Les surfaces des hulls sont décalées à la compilation
 * pour que le joueur puisse être traité comme un simple point.
 */
const HULLS = [
  { mins: [0, 0, 0], maxs: [0, 0, 0] },
  { mins: [-16, -16, -24], maxs: [16, 16, 32] },
  { mins: [-32, -32, -24], maxs: [32, 32, 64] },
];

function expandedDistance(normal, dist, hull) {
  const corner = [0, 1, 2].map((axis) => (normal[axis] < 0 ? hull.maxs[axis] : hull.mins[axis]));
  return dist - dot(normal, corner);
}

/** Les six plans de la salle, normales tournées vers l'intérieur. */
const FACES = [
  { normal: [0, 0, 1], dist: ROOM.min[2], axis: 2, texture: 0 }, // sol
  { normal: [0, 0, -1], dist: -ROOM.max[2], axis: 2, texture: 3 }, // ciel
  { normal: [1, 0, 0], dist: ROOM.min[0], axis: 0, texture: 2 },
  { normal: [-1, 0, 0], dist: -ROOM.max[0], axis: 0, texture: 2 },
  { normal: [0, 1, 0], dist: ROOM.min[1], axis: 1, texture: 2 },
  { normal: [0, -1, 0], dist: -ROOM.max[1], axis: 1, texture: 2 },
];

function cornersFor(face) {
  const { min, max } = ROOM;
  const n = face.normal;
  const fixed = n[0] !== 0 ? 0 : n[1] !== 0 ? 1 : 2;
  const value = n[fixed] > 0 ? min[fixed] : max[fixed];
  const others = [0, 1, 2].filter((a) => a !== fixed);
  const [a, b] = others;

  const make = (av, bv) => {
    const point = [0, 0, 0];
    point[fixed] = value;
    point[a] = av;
    point[b] = bv;
    return point;
  };
  const quad = [
    make(min[a], min[b]),
    make(max[a], min[b]),
    make(max[a], max[b]),
    make(min[a], max[b]),
  ];

  // L'enroulement doit produire la normale du plan.
  const e1 = sub(quad[1], quad[0]);
  const e2 = sub(quad[2], quad[1]);
  const c = cross(e1, e2);
  if (dot(c, n) < 0) quad.reverse();
  return quad;
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

/** Axes de texture perpendiculaires à la normale. */
function textureAxes(normal) {
  if (Math.abs(normal[2]) > 0.5) return [[1, 0, 0], [0, -1, 0]];
  if (Math.abs(normal[0]) > 0.5) return [[0, 1, 0], [0, 0, -1]];
  return [[1, 0, 0], [0, 0, -1]];
}

// ---------------------------------------------------------------- textures

function noise(width, height, seed) {
  const out = new Float32Array(width * height);
  let s = seed | 1;
  for (let i = 0; i < out.length; i++) {
    s = (s * 1664525 + 1013904223) & 0x7fffffff;
    out[i] = ((s >>> 9) % 1024) / 1024;
  }
  // Lissage pour éviter le bruit blanc pur.
  const smooth = new Float32Array(out.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          sum += out[((y + dy + height) % height) * width + ((x + dx + width) % width)];
        }
      }
      smooth[y * width + x] = sum / 9;
    }
  }
  return smooth;
}

function makeTexturePixels(kind, size) {
  const pixels = new Uint8Array(size * size);
  const grain = noise(size, size, kind * 7919 + 13);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let value;
      if (kind === 0) {
        const cell = size / 2;
        const joint = x % cell < 3 || y % cell < 3;
        value = joint ? 0.2 : 0.45 + grain[y * size + x] * 0.4;
      } else if (kind === 1) {
        const rivet = x % 16 === 8 && y % 16 === 8;
        value = rivet ? 0.9 : 0.35 + grain[y * size + x] * 0.3;
      } else {
        const band = Math.floor(y / (size / 4)) % 2;
        const joint = y % (size / 4) < 2;
        value = joint ? 0.18 : (band ? 0.55 : 0.42) + grain[y * size + x] * 0.35;
      }
      // Rampe de gris de la palette d'origine : 16 valeurs utiles.
      pixels[y * size + x] = Math.max(0, Math.min(15, Math.round(value * 15)));
    }
  }
  return pixels;
}

/** Réduction de moitié, pour remplir les quatre niveaux exigés par le format. */
function halveIndexed(pixels, width, height) {
  const w = width >> 1;
  const h = height >> 1;
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) out[y * w + x] = pixels[y * 2 * width + x * 2];
  }
  return out;
}

/**
 * Le ciel est une image double : la moitié gauche porte les nuages, avec
 * l'index 0 pour les trous, la moitié droite le fond qui défile dessous.
 */
function makeSkyPixels(width, height) {
  const pixels = new Uint8Array(width * height);
  const half = width >> 1;
  const clouds = noise(half, height, 4711);
  const deep = noise(half, height, 991);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < half; x++) {
      // Indices choisis dans la partie claire de la rampe, sinon le ciel
      // se confond avec le noir de la salle.
      const density = clouds[y * half + x];
      pixels[y * width + x] = density > 0.52 ? 150 + Math.round((density - 0.52) * 90) : 0;
      pixels[y * width + half + x] = 88 + Math.round(deep[y * half + x] * 40);
    }
  }
  return pixels;
}

const TEXTURES = [
  { name: 'test_floor', size: 128, kind: 0 },
  { name: 'test_ceiling', size: 128, kind: 1 },
  { name: 'test_wall', size: 128, kind: 2 },
].map((entry) => ({ ...entry, pixels: makeTexturePixels(entry.kind, entry.size) }));

TEXTURES.push({
  name: 'sky1',
  size: 128,
  width: 256,
  height: 128,
  kind: 3,
  pixels: makeSkyPixels(256, 128),
});

// ---------------------------------------------------------------- lightmaps

function bakeFace(face, quad) {
  const [sAxis, tAxis] = textureAxes(face.normal);
  let minS = Infinity;
  let minT = Infinity;
  let maxS = -Infinity;
  let maxT = -Infinity;
  for (const point of quad) {
    const s = dot(point, sAxis);
    const t = dot(point, tAxis);
    minS = Math.min(minS, s);
    maxS = Math.max(maxS, s);
    minT = Math.min(minT, t);
    maxT = Math.max(maxT, t);
  }
  const bminS = Math.floor(minS / LIGHTMAP_SCALE);
  const bminT = Math.floor(minT / LIGHTMAP_SCALE);
  const bmaxS = Math.ceil(maxS / LIGHTMAP_SCALE);
  const bmaxT = Math.ceil(maxT / LIGHTMAP_SCALE);
  const width = bmaxS - bminS + 1;
  const height = bmaxT - bminT + 1;

  const samples = new Uint8Array(width * height);
  const origin = quad[0];
  const s0 = dot(origin, sAxis);
  const t0 = dot(origin, tAxis);

  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      const s = (bminS + i) * LIGHTMAP_SCALE;
      const t = (bminT + j) * LIGHTMAP_SCALE;
      const point = [
        origin[0] + sAxis[0] * (s - s0) + tAxis[0] * (t - t0),
        origin[1] + sAxis[1] * (s - s0) + tAxis[1] * (t - t0),
        origin[2] + sAxis[2] * (s - s0) + tAxis[2] * (t - t0),
      ];
      let total = 0;
      for (const light of LIGHTS) {
        const delta = sub(light.position, point);
        const distance = Math.hypot(...delta);
        if (distance > light.radius || distance < 1e-3) continue;
        const lambert = dot(delta, face.normal) / distance;
        if (lambert <= 0) continue;
        total += light.intensity * Math.pow(1 - distance / light.radius, 1.5) * lambert;
      }
      samples[j * width + i] = Math.min(255, Math.round(total * 255));
    }
  }
  return { samples, width, height, sAxis, tAxis };
}

// ---------------------------------------------------------------- écriture

class Writer {
  constructor() {
    this.chunks = [];
    this.size = 0;
  }
  push(buffer) {
    this.chunks.push(buffer);
    this.size += buffer.length;
    return this;
  }
  int32(...values) {
    const b = Buffer.alloc(values.length * 4);
    values.forEach((v, i) => b.writeInt32LE(v, i * 4));
    return this.push(b);
  }
  uint32(...values) {
    const b = Buffer.alloc(values.length * 4);
    values.forEach((v, i) => b.writeUInt32LE(v >>> 0, i * 4));
    return this.push(b);
  }
  int16(...values) {
    const b = Buffer.alloc(values.length * 2);
    values.forEach((v, i) => b.writeInt16LE(v, i * 2));
    return this.push(b);
  }
  uint16(...values) {
    const b = Buffer.alloc(values.length * 2);
    values.forEach((v, i) => b.writeUInt16LE(v, i * 2));
    return this.push(b);
  }
  float(...values) {
    const b = Buffer.alloc(values.length * 4);
    values.forEach((v, i) => b.writeFloatLE(v, i * 4));
    return this.push(b);
  }
  bytes(data) {
    return this.push(Buffer.from(data));
  }
  name16(text) {
    const b = Buffer.alloc(16);
    b.write(text.slice(0, 15), 'latin1');
    return this.push(b);
  }
  build() {
    return Buffer.concat(this.chunks, this.size);
  }
}

function build() {
  // Sommets : les huit coins de la salle.
  const vertices = [];
  const vertexIndex = new Map();
  const addVertex = (point) => {
    const key = point.join(',');
    if (!vertexIndex.has(key)) {
      vertexIndex.set(key, vertices.length);
      vertices.push(point);
    }
    return vertexIndex.get(key);
  };

  const edges = [[0, 0]]; // l'arête 0 n'est jamais référencée
  const surfEdges = [];
  const faces = [];
  const texInfos = [];
  const lightingChunks = [];
  let lightingSize = 0;

  FACES.forEach((face, faceIndex) => {
    const quad = cornersFor(face);
    const indices = quad.map(addVertex);

    const firstEdge = surfEdges.length;
    for (let i = 0; i < 4; i++) {
      const a = indices[i];
      const b = indices[(i + 1) % 4];
      edges.push([a, b]);
      surfEdges.push(edges.length - 1);
    }

    const baked = bakeFace(face, quad);
    texInfos.push({
      sAxis: baked.sAxis,
      sOffset: 0,
      tAxis: baked.tAxis,
      tOffset: 0,
      miptex: face.texture,
      flags: 0,
    });

    faces.push({
      plane: faceIndex,
      side: 0,
      firstEdge,
      edgeCount: 4,
      texInfo: faceIndex,
      styles: [0, 255, 255, 255],
      lightOffset: lightingSize,
    });

    lightingChunks.push(Buffer.from(baked.samples));
    lightingSize += baked.samples.length;
  });

  const lumps = [];
  const body = [];
  let offset = 4 + 15 * 8;

  const addLump = (buffer) => {
    lumps.push({ offset, length: buffer.length });
    body.push(buffer);
    offset += buffer.length;
    // Le format aligne les lumps sur quatre octets.
    const pad = (4 - (buffer.length % 4)) % 4;
    if (pad) {
      body.push(Buffer.alloc(pad));
      offset += pad;
    }
  };

  // 0 entités
  const props = [
    [-260, 260, 0], [260, 260, 45], [-260, -260, 135], [260, -260, 225],
  ].map(([x, y, angle]) =>
    `{\n"classname" "prop_test"\n"origin" "${x} ${y} 0"\n"angle" "${angle}"\n}\n`,
  );
  const entities =
    '{\n"classname" "worldspawn"\n"wad" "none"\n}\n' +
    '{\n"classname" "info_player_start"\n"origin" "0 -320 32"\n"angle" "90"\n}\n' +
    '{\n"classname" "light"\n"origin" "0 0 280"\n"light" "300"\n}\n' +
    props.join('') +
    '\0';
  addLump(Buffer.from(entities, 'latin1'));

  // 1 plans : ceux du rendu, puis un jeu décalé par gabarit de collision
  {
    const w = new Writer();
    for (const face of FACES) {
      w.float(face.normal[0], face.normal[1], face.normal[2], face.dist).int32(face.axis);
    }
    for (const hull of [HULLS[1], HULLS[2]]) {
      for (const face of FACES) {
        w.float(
          face.normal[0],
          face.normal[1],
          face.normal[2],
          expandedDistance(face.normal, face.dist, hull),
        ).int32(face.axis);
      }
    }
    addLump(w.build());
  }

  // 2 textures
  {
    const headerSize = 4 + TEXTURES.length * 4;
    const entries = TEXTURES.map((texture) => {
      const w = new Writer();
      const mips = [texture.pixels];
      let width = texture.width ?? texture.size;
      let height = texture.height ?? texture.size;
      for (let level = 1; level < 4; level++) {
        mips.push(halveIndexed(mips[level - 1], width, height));
        width >>= 1;
        height >>= 1;
      }
      const base = 16 + 4 + 4 + 16; // nom + dimensions + quatre offsets
      const offsets = [];
      let running = base;
      for (const mip of mips) {
        offsets.push(running);
        running += mip.length;
      }
      w
        .name16(texture.name)
        .uint32(texture.width ?? texture.size, texture.height ?? texture.size)
        .uint32(...offsets);
      for (const mip of mips) w.bytes(mip);
      return w.build();
    });

    const w = new Writer();
    w.int32(TEXTURES.length);
    let running = headerSize;
    for (const entry of entries) {
      w.int32(running);
      running += entry.length;
    }
    for (const entry of entries) w.bytes(entry);
    addLump(w.build());
  }

  // 3 sommets
  {
    const w = new Writer();
    for (const vertex of vertices) w.float(vertex[0], vertex[1], vertex[2]);
    addLump(w.build());
  }

  // 4 visibilité : aucune, tout est visible
  addLump(Buffer.alloc(0));

  // 5 noeuds : une chaîne de plans, l'extérieur de chacun étant plein
  {
    const w = new Writer();
    FACES.forEach((face, index) => {
      const front = index === FACES.length - 1 ? -2 : index + 1; // -2 = feuille 1 (vide)
      const back = -1; // feuille 0, toujours pleine
      w.int32(index)
        .int16(front, back)
        .int16(ROOM.min[0] - 64, ROOM.min[1] - 64, ROOM.min[2] - 64)
        .int16(ROOM.max[0] + 64, ROOM.max[1] + 64, ROOM.max[2] + 64)
        .uint16(index === 0 ? 0 : 0, index === 0 ? FACES.length : 0);
      void face;
    });
    addLump(w.build());
  }

  // 6 texinfo
  {
    const w = new Writer();
    for (const info of texInfos) {
      w.float(info.sAxis[0], info.sAxis[1], info.sAxis[2], info.sOffset);
      w.float(info.tAxis[0], info.tAxis[1], info.tAxis[2], info.tOffset);
      w.int32(info.miptex, info.flags);
    }
    addLump(w.build());
  }

  // 7 faces
  {
    const w = new Writer();
    for (const face of faces) {
      w.int16(face.plane, face.side)
        .int32(face.firstEdge)
        .int16(face.edgeCount, face.texInfo)
        .bytes(Buffer.from(face.styles))
        .int32(face.lightOffset);
    }
    addLump(w.build());
  }

  // 8 éclairage
  addLump(Buffer.concat(lightingChunks));

  // 9 clipnodes : une chaîne par gabarit, sur ses propres plans
  {
    const w = new Writer();
    for (let hull = 0; hull < 2; hull++) {
      const planeBase = FACES.length * (hull + 1);
      const nodeBase = FACES.length * hull;
      FACES.forEach((face, index) => {
        const front = index === FACES.length - 1 ? CONTENTS_EMPTY : nodeBase + index + 1;
        w.int32(planeBase + index).int16(front, CONTENTS_SOLID);
        void face;
      });
    }
    addLump(w.build());
  }

  // 10 feuilles : la première est la matière, la seconde le volume jouable
  {
    const w = new Writer();
    const writeLeaf = (contents, firstMark, markCount) => {
      w.int32(contents, -1)
        .int16(ROOM.min[0] - 64, ROOM.min[1] - 64, ROOM.min[2] - 64)
        .int16(ROOM.max[0] + 64, ROOM.max[1] + 64, ROOM.max[2] + 64)
        .uint16(firstMark, markCount)
        .bytes(Buffer.alloc(4));
    };
    writeLeaf(CONTENTS_SOLID, 0, 0);
    writeLeaf(CONTENTS_EMPTY, 0, FACES.length);
    addLump(w.build());
  }

  // 11 marksurfaces
  {
    const w = new Writer();
    for (let i = 0; i < FACES.length; i++) w.uint16(i);
    addLump(w.build());
  }

  // 12 arêtes
  {
    const w = new Writer();
    for (const [a, b] of edges) w.uint16(a, b);
    addLump(w.build());
  }

  // 13 surfedges
  {
    const w = new Writer();
    w.int32(...surfEdges);
    addLump(w.build());
  }

  // 14 modèles
  {
    const w = new Writer();
    w.float(ROOM.min[0], ROOM.min[1], ROOM.min[2]);
    w.float(ROOM.max[0], ROOM.max[1], ROOM.max[2]);
    w.float(0, 0, 0);
    // headnodes : l'arbre de rendu, puis la chaîne de clipnodes de chaque gabarit
    w.int32(0, 0, FACES.length, 0);
    w.int32(1); // feuilles visibles
    w.int32(0, FACES.length);
    addLump(w.build());
  }

  const header = new Writer();
  header.int32(29);
  for (const lump of lumps) header.int32(lump.offset, lump.length);
  return Buffer.concat([header.build(), ...body]);
}

const data = build();
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT_FILE, data);
console.log(`carte de test écrite : ${OUT_FILE} (${data.length} octets)`);

// Manifeste lu au démarrage : il permet de charger la carte sans la déposer.
const manifestPath = resolve(OUT_DIR, '../manifest.json');
writeFileSync(
  manifestPath,
  `${JSON.stringify(
    { paks: [], maps: ['maps/testroom.bsp'], files: ['progs/testprop.mdl'] },
    null,
    2,
  )}\n`,
);
console.log(`manifeste écrit : ${manifestPath}`);

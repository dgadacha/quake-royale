/**
 * Génère un modèle animé au format alias version 6.
 * La forme est une balise abstraite : un fût octaédrique posé sur un socle,
 * qui respire sur quatre images. Elle sert uniquement à vérifier le parseur,
 * le mélange d'images clés et le placage de la peau.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(HERE, '../public/data/progs');
const OUT_FILE = resolve(OUT_DIR, 'testprop.mdl');

const SKIN_W = 64;
const SKIN_H = 64;
const FRAMES = 4;

// -------------------------------------------------------------- géométrie

/** Sommets de base : socle carré, fût à huit faces, pointe. */
function baseShape() {
  const vertices = [];
  const uvs = [];

  const ring = (radius, z, count, v) => {
    const first = vertices.length;
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2;
      vertices.push([Math.cos(angle) * radius, Math.sin(angle) * radius, z]);
      uvs.push([Math.round((i / count) * (SKIN_W - 1)), v]);
    }
    return first;
  };

  const bottom = ring(11, 0, 8, SKIN_H - 2);
  const waist = ring(9, 14, 8, Math.round(SKIN_H * 0.62));
  const shoulder = ring(6, 26, 8, Math.round(SKIN_H * 0.3));
  vertices.push([0, 0, 36]);
  uvs.push([Math.round(SKIN_W / 2), 1]);
  const tip = vertices.length - 1;

  const triangles = [];
  const band = (a, b) => {
    for (let i = 0; i < 8; i++) {
      const n = (i + 1) % 8;
      triangles.push([a + i, b + i, b + n]);
      triangles.push([a + i, b + n, a + n]);
    }
  };
  band(bottom, waist);
  band(waist, shoulder);
  for (let i = 0; i < 8; i++) triangles.push([shoulder + i, tip, shoulder + ((i + 1) % 8)]);
  // Fond fermé, pour que le modèle reste étanche vu de dessous.
  for (let i = 1; i < 7; i++) triangles.push([bottom, bottom + i + 1, bottom + i]);

  return { vertices, uvs, triangles };
}

const shape = baseShape();

/** Respiration : le fût s'étire et se resserre au fil des images. */
function frameVertices(frameIndex) {
  const phase = (frameIndex / FRAMES) * Math.PI * 2;
  const stretch = 1 + Math.sin(phase) * 0.12;
  const squeeze = 1 - Math.sin(phase) * 0.08;
  return shape.vertices.map(([x, y, z]) => [x * squeeze, y * squeeze, z * stretch]);
}

const allFrames = [];
for (let i = 0; i < FRAMES; i++) allFrames.push(frameVertices(i));

// Échelle commune : les positions sont stockées sur un octet par axe.
const mins = [Infinity, Infinity, Infinity];
const maxs = [-Infinity, -Infinity, -Infinity];
for (const frame of allFrames) {
  for (const vertex of frame) {
    for (let a = 0; a < 3; a++) {
      mins[a] = Math.min(mins[a], vertex[a]);
      maxs[a] = Math.max(maxs[a], vertex[a]);
    }
  }
}
const scale = mins.map((min, a) => (maxs[a] - min) / 255);

// ---------------------------------------------------------------- peau

function makeSkin() {
  const pixels = new Uint8Array(SKIN_W * SKIN_H);
  for (let y = 0; y < SKIN_H; y++) {
    for (let x = 0; x < SKIN_W; x++) {
      const band = Math.floor(y / 8) % 2;
      const stripe = x % 16 < 2;
      // Bandeau non affecté par l'éclairage à mi-hauteur.
      const glow = y > SKIN_H * 0.34 && y < SKIN_H * 0.44;
      let index;
      if (glow) index = 232 + (x % 8);
      else if (stripe) index = 3;
      else index = (band ? 7 : 10) + ((x * 3 + y * 5) % 3);
      pixels[y * SKIN_W + x] = index;
    }
  }
  return pixels;
}

// ------------------------------------------------------------- écriture

class Writer {
  constructor() {
    this.parts = [];
    this.size = 0;
  }
  push(buffer) {
    this.parts.push(buffer);
    this.size += buffer.length;
    return this;
  }
  int32(...values) {
    const b = Buffer.alloc(values.length * 4);
    values.forEach((v, i) => b.writeInt32LE(v, i * 4));
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
    return Buffer.concat(this.parts, this.size);
  }
}

const w = new Writer();
w.bytes(Buffer.from('IDPO', 'latin1')).int32(6);
w.float(scale[0], scale[1], scale[2]);
w.float(mins[0], mins[1], mins[2]);
w.float(Math.max(...maxs.map(Math.abs)));
w.float(0, 0, 30); // position de l'oeil
w.int32(1, SKIN_W, SKIN_H);
w.int32(shape.vertices.length, shape.triangles.length, FRAMES);
w.int32(0, 0); // synchronisation, drapeaux
w.float(12);

// Peau unique.
w.int32(0).bytes(makeSkin());

// Coordonnées de texture.
for (const [s, t] of shape.uvs) w.int32(0, s, t);

// Triangles, tous tournés vers l'avant.
for (const [a, b, c] of shape.triangles) w.int32(1, a, b, c);

// Images clés.
allFrames.forEach((frame, index) => {
  const encode = (vertex) =>
    vertex.map((value, axis) =>
      Math.max(0, Math.min(255, Math.round((value - mins[axis]) / (scale[axis] || 1)))),
    );
  const encoded = frame.map(encode);
  const bboxMin = [255, 255, 255];
  const bboxMax = [0, 0, 0];
  for (const vertex of encoded) {
    for (let a = 0; a < 3; a++) {
      bboxMin[a] = Math.min(bboxMin[a], vertex[a]);
      bboxMax[a] = Math.max(bboxMax[a], vertex[a]);
    }
  }

  w.int32(0); // image simple
  w.bytes(Buffer.from([...bboxMin, 0]));
  w.bytes(Buffer.from([...bboxMax, 0]));
  w.name16(`pulse${index + 1}`);
  for (const vertex of encoded) w.bytes(Buffer.from([...vertex, 0]));
});

const data = w.build();
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT_FILE, data);
console.log(
  `modèle de test écrit : ${OUT_FILE} (${data.length} octets, ` +
    `${shape.vertices.length} sommets, ${shape.triangles.length} triangles, ${FRAMES} images)`,
);

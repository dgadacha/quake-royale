import type { MdlModel } from '../formats/mdl';

/**
 * Report d'animation d'un modèle d'origine vers un maillage haute définition.
 *
 * Les modèles du jeu n'ont pas de squelette : ils stockent, image par image,
 * la position de chacun de leurs sommets. Il n'y a donc rien à « riger » — il
 * faut attacher le maillage détaillé à la surface du modèle d'origine, puis
 * lui faire rejouer les mêmes images. On récupère ainsi les animations exactes
 * du jeu, sans avoir à les refaire.
 *
 * Chaque sommet détaillé retient les quelques triangles dont il est le plus
 * proche, sa position sur chacun d'eux, et son écart à leur surface exprimé
 * dans leur propre repère. Cet écart suit donc le triangle quand il tourne.
 */

/** Nombre de triangles de référence retenus par sommet. */
const DEFAULT_NEIGHBOURS = 4;

export interface SurfaceBinding {
  vertexCount: number;
  neighbours: number;
  /** Triangle de référence, `neighbours` par sommet. */
  triangle: Int32Array;
  /** Coordonnées barycentriques du point le plus proche, trois par référence. */
  bary: Float32Array;
  /** Écart à la surface, dans le repère du triangle : tangente, normale, binormale. */
  offset: Float32Array;
  /** Part de chaque référence dans le résultat, déjà normalisée. */
  weight: Float32Array;
}

/** Positions d'une image du modèle, converties dans le repère du rendu. */
export function frameToRenderSpace(model: MdlModel, index: number): Float32Array {
  const frame = model.frames[index];
  const out = new Float32Array(model.vertexCount * 3);
  for (let i = 0; i < model.vertexCount; i++) {
    out[i * 3] = frame.positions[i * 3];
    out[i * 3 + 1] = frame.positions[i * 3 + 2];
    out[i * 3 + 2] = -frame.positions[i * 3 + 1];
  }
  return out;
}

/** Repère orthonormé porté par un triangle : tangente, normale, binormale. */
function triangleBasis(
  p: Float32Array,
  a: number,
  b: number,
  c: number,
  out: Float32Array,
): boolean {
  const ax = p[a], ay = p[a + 1], az = p[a + 2];
  let tx = p[b] - ax, ty = p[b + 1] - ay, tz = p[b + 2] - az;
  const ux = p[c] - ax, uy = p[c + 1] - ay, uz = p[c + 2] - az;

  let nx = ty * uz - tz * uy;
  let ny = tz * ux - tx * uz;
  let nz = tx * uy - ty * ux;
  const nl = Math.hypot(nx, ny, nz);
  // Un triangle dégénéré n'a pas de repère : le sommet s'appuiera sur ses voisins.
  if (nl < 1e-12) return false;
  nx /= nl; ny /= nl; nz /= nl;

  const tl = Math.hypot(tx, ty, tz);
  if (tl < 1e-12) return false;
  tx /= tl; ty /= tl; tz /= tl;

  const bx = ny * tz - nz * ty;
  const by = nz * tx - nx * tz;
  const bz = nx * ty - ny * tx;

  out[0] = tx; out[1] = ty; out[2] = tz;
  out[3] = nx; out[4] = ny; out[5] = nz;
  out[6] = bx; out[7] = by; out[8] = bz;
  return true;
}

/**
 * Point du triangle le plus proche de `p`, et ses coordonnées barycentriques.
 * Traite les sept régions du plan du triangle : intérieur, trois arêtes,
 * trois sommets.
 */
function closestPointOnTriangle(
  px: number, py: number, pz: number,
  p: Float32Array, a: number, b: number, c: number,
  out: Float32Array,
): void {
  const ax = p[a], ay = p[a + 1], az = p[a + 2];
  const bx = p[b], by = p[b + 1], bz = p[b + 2];
  const cx = p[c], cy = p[c + 1], cz = p[c + 2];

  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;

  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) { out[0] = 1; out[1] = 0; out[2] = 0; return; }

  const bpx = px - bx, bpy = py - by, bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) { out[0] = 0; out[1] = 1; out[2] = 0; return; }

  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    out[0] = 1 - v; out[1] = v; out[2] = 0; return;
  }

  const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) { out[0] = 0; out[1] = 0; out[2] = 1; return; }

  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    out[0] = 1 - w; out[1] = 0; out[2] = w; return;
  }

  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    out[0] = 0; out[1] = 1 - w; out[2] = w; return;
  }

  const denom = 1 / (va + vb + vc);
  const v = vb * denom;
  const w = vc * denom;
  out[0] = 1 - v - w; out[1] = v; out[2] = w;
}

/**
 * Découpage du modèle en pièces indépendantes.
 *
 * Les modèles du jeu séparent souvent l'arme du corps qui la tient : ce sont
 * deux surfaces qui ne partagent aucun sommet. Un point détaillé du fusil est
 * alors géométriquement aussi proche de la main que du fusil lui-même, et
 * s'accrocherait à la mauvaise pièce.
 */
export function modelParts(model: MdlModel): Int32Array {
  const parent = new Int32Array(model.vertexCount);
  for (let i = 0; i < parent.length; i++) parent[i] = i;

  const root = (a: number): number => {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]];
      a = parent[a];
    }
    return a;
  };
  const join = (a: number, b: number) => {
    const ra = root(a);
    const rb = root(b);
    if (ra !== rb) parent[ra] = rb;
  };

  for (const triangle of model.triangles) {
    join(triangle.vertices[0], triangle.vertices[1]);
    join(triangle.vertices[1], triangle.vertices[2]);
  }

  // Une pièce par triangle, numérotée à partir de zéro.
  const labels = new Map<number, number>();
  const parts = new Int32Array(model.triangles.length);
  for (let t = 0; t < model.triangles.length; t++) {
    const r = root(model.triangles[t].vertices[0]);
    let label = labels.get(r);
    if (label === undefined) {
      label = labels.size;
      labels.set(r, label);
    }
    parts[t] = label;
  }
  return parts;
}

export interface BindOptions {
  /** Triangles de référence par sommet ; au-delà de un, les jointures se lissent. */
  neighbours?: number;
  /**
   * Restreint chaque sommet à la pièce dont il est le plus proche.
   * Sans quoi un point du fusil s'accroche à la main qui le tient.
   */
  respectParts?: boolean;
  /**
   * Pièce imposée pour chaque sommet détaillé, quand on la connaît déjà —
   * un maillage livré en parties séparées dit lui-même où est son arme.
   * Vaut mieux que la proximité, qui ne peut que la deviner.
   */
  forcedParts?: Int32Array;
}

/**
 * Attache un maillage détaillé à la surface du modèle d'origine.
 * `positions` est exprimé dans le repère du rendu, déjà recalé sur le modèle.
 */
export function bindToModel(
  model: MdlModel,
  positions: Float32Array,
  options: BindOptions = {},
): SurfaceBinding {
  const neighbours = Math.max(1, options.neighbours ?? DEFAULT_NEIGHBOURS);
  const rest = frameToRenderSpace(model, 0);
  const triangles = model.triangles;
  const vertexCount = positions.length / 3;
  const parts = options.respectParts === false ? null : modelParts(model);
  const forced = options.forcedParts ?? null;

  const binding: SurfaceBinding = {
    vertexCount,
    neighbours,
    triangle: new Int32Array(vertexCount * neighbours),
    bary: new Float32Array(vertexCount * neighbours * 3),
    offset: new Float32Array(vertexCount * neighbours * 3),
    weight: new Float32Array(vertexCount * neighbours),
  };

  const bary = new Float32Array(3);
  const basis = new Float32Array(9);
  const bestDistance = new Float64Array(neighbours);
  const bestTriangle = new Int32Array(neighbours);
  const bestBary = new Float32Array(neighbours * 3);

  for (let v = 0; v < vertexCount; v++) {
    const px = positions[v * 3];
    const py = positions[v * 3 + 1];
    const pz = positions[v * 3 + 2];

    bestDistance.fill(Infinity);
    bestTriangle.fill(-1);

    // Première passe : de quelle pièce ce sommet relève-t-il ? La seconde ne
    // cherchera plus qu'à l'intérieur de celle-là.
    let part = -1;
    if (forced) {
      part = forced[v];
    } else if (parts) {
      let nearestDistance = Infinity;
      for (let t = 0; t < triangles.length; t++) {
        const [i0, i1, i2] = triangles[t].vertices;
        const a = i0 * 3, b = i1 * 3, c = i2 * 3;
        closestPointOnTriangle(px, py, pz, rest, a, b, c, bary);
        const qx = bary[0] * rest[a] + bary[1] * rest[b] + bary[2] * rest[c];
        const qy = bary[0] * rest[a + 1] + bary[1] * rest[b + 1] + bary[2] * rest[c + 1];
        const qz = bary[0] * rest[a + 2] + bary[1] * rest[b + 2] + bary[2] * rest[c + 2];
        const d = (px - qx) ** 2 + (py - qy) ** 2 + (pz - qz) ** 2;
        if (d < nearestDistance) {
          nearestDistance = d;
          part = parts[t];
        }
      }
    }

    for (let t = 0; t < triangles.length; t++) {
      if (parts && part >= 0 && parts[t] !== part) continue;
      const [i0, i1, i2] = triangles[t].vertices;
      const a = i0 * 3, b = i1 * 3, c = i2 * 3;
      closestPointOnTriangle(px, py, pz, rest, a, b, c, bary);

      const qx = bary[0] * rest[a] + bary[1] * rest[b] + bary[2] * rest[c];
      const qy = bary[0] * rest[a + 1] + bary[1] * rest[b + 1] + bary[2] * rest[c + 1];
      const qz = bary[0] * rest[a + 2] + bary[1] * rest[b + 2] + bary[2] * rest[c + 2];
      const d = (px - qx) ** 2 + (py - qy) ** 2 + (pz - qz) ** 2;

      // Insertion dans la liste des plus proches, gardée triée.
      if (d >= bestDistance[neighbours - 1]) continue;
      let slot = neighbours - 1;
      while (slot > 0 && bestDistance[slot - 1] > d) {
        bestDistance[slot] = bestDistance[slot - 1];
        bestTriangle[slot] = bestTriangle[slot - 1];
        bestBary[slot * 3] = bestBary[(slot - 1) * 3];
        bestBary[slot * 3 + 1] = bestBary[(slot - 1) * 3 + 1];
        bestBary[slot * 3 + 2] = bestBary[(slot - 1) * 3 + 2];
        slot--;
      }
      bestDistance[slot] = d;
      bestTriangle[slot] = t;
      bestBary[slot * 3] = bary[0];
      bestBary[slot * 3 + 1] = bary[1];
      bestBary[slot * 3 + 2] = bary[2];
    }

    // Deux triangles peuvent se frôler au repos sans appartenir à la même
    // partie du corps : un point du bras est aussi près du torse. Les mélanger
    // ferait tirer le sommet lorsque le bras s'écarte. Ne sont donc retenus
    // que les triangles nettement aussi proches que le meilleur, et tournés
    // dans le même sens que lui.
    const nearest = bestDistance[0];
    const cutoff = nearest * 4 + 1e-3;
    const reference = new Float32Array(9);
    let hasReference = false;
    if (bestTriangle[0] >= 0) {
      const [r0, r1, r2] = triangles[bestTriangle[0]].vertices;
      hasReference = triangleBasis(rest, r0 * 3, r1 * 3, r2 * 3, reference);
    }

    let total = 0;
    for (let k = 0; k < neighbours; k++) {
      const t = bestTriangle[k];
      const base = v * neighbours + k;
      if (t < 0) { binding.triangle[base] = -1; binding.weight[base] = 0; continue; }
      if (k > 0 && bestDistance[k] > cutoff) {
        binding.triangle[base] = -1;
        binding.weight[base] = 0;
        continue;
      }

      const [i0, i1, i2] = triangles[t].vertices;
      const a = i0 * 3, b = i1 * 3, c = i2 * 3;
      const b0 = bestBary[k * 3], b1 = bestBary[k * 3 + 1], b2 = bestBary[k * 3 + 2];

      binding.triangle[base] = t;
      binding.bary[base * 3] = b0;
      binding.bary[base * 3 + 1] = b1;
      binding.bary[base * 3 + 2] = b2;

      // Un triangle sans repère ne sait pas porter l'écart du sommet : il le
      // ramènerait à plat sur la surface. Mieux vaut l'écarter.
      const oriented = triangleBasis(rest, a, b, c, basis);
      if (!oriented && k > 0) {
        binding.triangle[base] = -1;
        binding.weight[base] = 0;
        continue;
      }
      if (k > 0 && oriented && hasReference) {
        const facing = basis[3] * reference[3] + basis[4] * reference[4] + basis[5] * reference[5];
        if (facing < 0) {
          binding.triangle[base] = -1;
          binding.weight[base] = 0;
          continue;
        }
      }

      if (oriented) {
        const qx = b0 * rest[a] + b1 * rest[b] + b2 * rest[c];
        const qy = b0 * rest[a + 1] + b1 * rest[b + 1] + b2 * rest[c + 1];
        const qz = b0 * rest[a + 2] + b1 * rest[b + 2] + b2 * rest[c + 2];
        const dx = px - qx, dy = py - qy, dz = pz - qz;
        binding.offset[base * 3] = dx * basis[0] + dy * basis[1] + dz * basis[2];
        binding.offset[base * 3 + 1] = dx * basis[3] + dy * basis[4] + dz * basis[5];
        binding.offset[base * 3 + 2] = dx * basis[6] + dy * basis[7] + dz * basis[8];
      }

      // Les triangles proches pèsent davantage, sans jamais devenir infinis.
      const w = 1 / (bestDistance[k] + 1e-4);
      binding.weight[base] = w;
      total += w;
    }

    if (total > 0) {
      for (let k = 0; k < neighbours; k++) binding.weight[v * neighbours + k] /= total;
    }
  }

  return binding;
}

/**
 * Positions du maillage détaillé pour une image du modèle d'origine.
 * `frame` est exprimée dans le repère du rendu, comme le rendent
 * `frameToRenderSpace` et la mise en cache qui l'accompagne.
 */
export function evaluateFrame(
  binding: SurfaceBinding,
  model: MdlModel,
  frame: Float32Array,
  out: Float32Array,
): void {
  const { neighbours, vertexCount } = binding;
  const triangles = model.triangles;
  const basis = new Float32Array(9);

  for (let v = 0; v < vertexCount; v++) {
    let x = 0, y = 0, z = 0;
    for (let k = 0; k < neighbours; k++) {
      const base = v * neighbours + k;
      const t = binding.triangle[base];
      const w = binding.weight[base];
      if (t < 0 || w === 0) continue;

      const [i0, i1, i2] = triangles[t].vertices;
      const a = i0 * 3, b = i1 * 3, c = i2 * 3;
      const b0 = binding.bary[base * 3];
      const b1 = binding.bary[base * 3 + 1];
      const b2 = binding.bary[base * 3 + 2];

      let qx = b0 * frame[a] + b1 * frame[b] + b2 * frame[c];
      let qy = b0 * frame[a + 1] + b1 * frame[b + 1] + b2 * frame[c + 1];
      let qz = b0 * frame[a + 2] + b1 * frame[b + 2] + b2 * frame[c + 2];

      if (triangleBasis(frame, a, b, c, basis)) {
        const o0 = binding.offset[base * 3];
        const o1 = binding.offset[base * 3 + 1];
        const o2 = binding.offset[base * 3 + 2];
        qx += o0 * basis[0] + o1 * basis[3] + o2 * basis[6];
        qy += o0 * basis[1] + o1 * basis[4] + o2 * basis[7];
        qz += o0 * basis[2] + o1 * basis[5] + o2 * basis[8];
      }

      x += qx * w; y += qy * w; z += qz * w;
    }
    out[v * 3] = x;
    out[v * 3 + 1] = y;
    out[v * 3 + 2] = z;
  }
}

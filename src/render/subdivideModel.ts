import type { MdlFrame, MdlModel } from '../formats/mdl';

/**
 * Affine un modèle du jeu en subdivisant ses triangles.
 *
 * Les modèles d'origine comptent quelques centaines de faces : de près, la
 * silhouette est une suite d'angles. Les subdiviser selon le schéma de Loop
 * arrondit la surface sans rien changer d'autre — mêmes coordonnées de
 * texture, mêmes images, même arme au même endroit.
 *
 * L'intérêt tient dans ce qui n'arrive pas. Chaque sommet ajouté est une
 * combinaison à poids fixes de sommets d'origine : la règle appliquée à
 * chaque image donne exactement la forme affinée de cette image. L'animation
 * reste donc celle du jeu, au sommet près, là où rapporter un maillage venu
 * d'ailleurs ne peut que l'approcher.
 */

/** Poids du sommet conservé, selon son nombre de voisins. */
function loopBeta(valence: number): number {
  if (valence <= 2) return 0;
  if (valence === 3) return 3 / 16;
  const inner = 3 / 8 + 0.25 * Math.cos((2 * Math.PI) / valence);
  return (1 / valence) * (5 / 8 - inner * inner);
}

interface EdgeRecord {
  /** Extrémités, dans l'ordre croissant. */
  a: number;
  b: number;
  /** Sommets opposés des faces qui la bordent, au plus deux. */
  opposite: number[];
  /** Rang du sommet créé au milieu. */
  index: number;
}

/** Une passe de subdivision. Les indices de sommet valent aussi pour les UV. */
function subdivideOnce(model: MdlModel): MdlModel {
  const base = model.vertexCount;
  const edges = new Map<string, EdgeRecord>();
  const neighbours: Set<number>[] = Array.from({ length: base }, () => new Set<number>());

  const key = (a: number, b: number) => (a < b ? `${a}:${b}` : `${b}:${a}`);
  const record = (a: number, b: number, opposite: number): EdgeRecord => {
    const k = key(a, b);
    let edge = edges.get(k);
    if (!edge) {
      edge = { a: Math.min(a, b), b: Math.max(a, b), opposite: [], index: base + edges.size };
      edges.set(k, edge);
    }
    edge.opposite.push(opposite);
    neighbours[a].add(b);
    neighbours[b].add(a);
    return edge;
  };

  for (const triangle of model.triangles) {
    const [i0, i1, i2] = triangle.vertices;
    record(i0, i1, i2);
    record(i1, i2, i0);
    record(i2, i0, i1);
  }

  const edgeList = [...edges.values()];
  const vertexCount = base + edgeList.length;

  // Positions : la règle est la même pour toutes les images, seules changent
  // les valeurs auxquelles on l'applique.
  const frames: MdlFrame[] = model.frames.map((frame) => {
    const positions = new Float32Array(vertexCount * 3);

    for (let v = 0; v < base; v++) {
      const around = neighbours[v];
      const valence = around.size;
      const beta = loopBeta(valence);
      let x = 0;
      let y = 0;
      let z = 0;
      for (const other of around) {
        x += frame.positions[other * 3];
        y += frame.positions[other * 3 + 1];
        z += frame.positions[other * 3 + 2];
      }
      const keep = 1 - valence * beta;
      positions[v * 3] = frame.positions[v * 3] * keep + x * beta;
      positions[v * 3 + 1] = frame.positions[v * 3 + 1] * keep + y * beta;
      positions[v * 3 + 2] = frame.positions[v * 3 + 2] * keep + z * beta;
    }

    for (const edge of edgeList) {
      const o = edge.index * 3;
      const a = edge.a * 3;
      const b = edge.b * 3;
      if (edge.opposite.length >= 2) {
        const c = edge.opposite[0] * 3;
        const d = edge.opposite[1] * 3;
        for (let k = 0; k < 3; k++) {
          positions[o + k] =
            0.375 * (frame.positions[a + k] + frame.positions[b + k]) +
            0.125 * (frame.positions[c + k] + frame.positions[d + k]);
        }
      } else {
        // Bord libre : le milieu suffit, faute de seconde face.
        for (let k = 0; k < 3; k++) {
          positions[o + k] = 0.5 * (frame.positions[a + k] + frame.positions[b + k]);
        }
      }
    }

    // Les normales stockées ne servent pas au rendu, qui les tire de la
    // surface affichée.
    return { name: frame.name, positions, normals: new Uint8Array(vertexCount) };
  });

  // Coordonnées de texture : celles d'origine sont conservées telles quelles,
  // sans quoi la peau glisserait sur le modèle. Seuls les sommets ajoutés en
  // reçoivent de nouvelles, prises au milieu de leur arête.
  const texCoords = model.texCoords.map((coord) => ({ ...coord }));
  for (const edge of edgeList) {
    const a = model.texCoords[edge.a];
    const b = model.texCoords[edge.b];
    texCoords.push({
      s: (a.s + b.s) / 2,
      t: (a.t + b.t) / 2,
      // Le sommet n'est sur la couture que si ses deux parents y sont.
      onSeam: a.onSeam && b.onSeam,
    });
  }

  const triangles: MdlModel['triangles'] = [];
  for (const triangle of model.triangles) {
    const [i0, i1, i2] = triangle.vertices;
    const m01 = edges.get(key(i0, i1))!.index;
    const m12 = edges.get(key(i1, i2))!.index;
    const m20 = edges.get(key(i2, i0))!.index;
    const facesFront = triangle.facesFront;
    triangles.push(
      { facesFront, vertices: [i0, m01, m20] },
      { facesFront, vertices: [m01, i1, m12] },
      { facesFront, vertices: [m20, m12, i2] },
      { facesFront, vertices: [m01, m12, m20] },
    );
  }

  return { ...model, vertexCount, texCoords, triangles, frames };
}

/**
 * Modèle affiné. Chaque niveau quadruple le nombre de faces ; au-delà de deux
 * ou trois, la silhouette ne gagne plus rien que la peau ne donne déjà.
 */
export function subdivideModel(model: MdlModel, levels = 2): MdlModel {
  let current = model;
  for (let pass = 0; pass < Math.max(0, levels); pass++) current = subdivideOnce(current);
  return current;
}

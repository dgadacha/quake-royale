import { classifyTexture, type BspData } from '../../formats/bsp';
import type { ImpactSurface } from '../../render/decals';
import type { VisibilitySet } from '../../render/pvs';
import type { Vec3 } from '../collision';

/** Nature déduite du nom de la texture touchée. */
function surfaceFromName(name: string): ImpactSurface {
  const lower = name.toLowerCase();
  if (classifyTexture(lower) !== 'normal') return 'liquid';
  if (/metal|tech|plate|grate|grill|pipe|vent|door|button|switch|comp|elev/.test(lower)) {
    return 'metal';
  }
  if (/wood|crate|plank|barrel|box/.test(lower)) return 'wood';
  return 'stone';
}

/**
 * Matière présente au point d'impact.
 *
 * La trace de collision renvoie un plan, pas une texture : le décor est
 * connu par ses volumes, pas par ses surfaces. On retrouve donc la face en
 * fouillant la feuille qui contient le point, ce qui reste peu coûteux
 * puisqu'une feuille ne référence qu'une poignée de faces.
 */
export function surfaceAt(
  bsp: BspData,
  visibility: VisibilitySet,
  point: Vec3,
  normal: Vec3,
): ImpactSurface {
  // Le point d'impact est sur la surface même : on s'en écarte un peu pour
  // retomber dans le volume vide, seul endroit où l'arbre mène à une feuille.
  const probe: Vec3 = [
    point[0] + normal[0] * 2,
    point[1] + normal[1] * 2,
    point[2] + normal[2] * 2,
  ];

  const leafIndex = visibility.findLeaf(probe);
  const leaf = bsp.leafs[leafIndex];
  if (!leaf) return 'stone';

  let bestName: string | null = null;
  let bestScore = Infinity;

  for (let i = 0; i < leaf.markSurfaceCount; i++) {
    const faceIndex = bsp.markSurfaces[leaf.firstMarkSurface + i];
    const face = bsp.faces[faceIndex];
    if (!face) continue;

    const plane = bsp.planes[face.plane];
    const sign = face.side ? -1 : 1;
    const faceNormal: Vec3 = [
      plane.normal[0] * sign,
      plane.normal[1] * sign,
      plane.normal[2] * sign,
    ];

    // La face doit regarder dans le même sens que le plan touché.
    const alignment =
      faceNormal[0] * normal[0] + faceNormal[1] * normal[1] + faceNormal[2] * normal[2];
    if (alignment < 0.85) continue;

    const distance = Math.abs(
      point[0] * plane.normal[0] +
        point[1] * plane.normal[1] +
        point[2] * plane.normal[2] -
        plane.dist,
    );
    if (distance > 4 || distance >= bestScore) continue;

    const info = bsp.texInfos[face.texInfo];
    const texture = info ? bsp.textures[info.miptex] : null;
    if (!texture) continue;

    bestScore = distance;
    bestName = texture.name;
  }

  return bestName ? surfaceFromName(bestName) : 'stone';
}

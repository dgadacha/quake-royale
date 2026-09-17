import * as THREE from 'three';

/**
 * Une texture n'est chargée qu'une fois, quel que soit le nombre de matériaux
 * qui la réclament. Les échecs sont mémorisés pour ne pas être retentés à
 * chaque surface.
 */
export class TextureCache {
  private readonly textures = new Map<string, Promise<THREE.Texture | null>>();
  private readonly loader = new THREE.TextureLoader();

  constructor(private readonly anisotropy: number) {}

  load(url: string, colorSpace: THREE.ColorSpace): Promise<THREE.Texture | null> {
    const key = `${url}|${colorSpace}`;
    let pending = this.textures.get(key);
    if (pending) return pending;

    pending = new Promise<THREE.Texture | null>((resolve) => {
      this.loader.load(
        url,
        (texture) => {
          texture.wrapS = THREE.RepeatWrapping;
          texture.wrapT = THREE.RepeatWrapping;
          texture.anisotropy = this.anisotropy;
          texture.colorSpace = colorSpace;
          texture.needsUpdate = true;
          resolve(texture);
        },
        undefined,
        () => resolve(null),
      );
    });

    this.textures.set(key, pending);
    return pending;
  }

  get size(): number {
    return this.textures.size;
  }

  async dispose(): Promise<void> {
    for (const pending of this.textures.values()) {
      const texture = await pending;
      texture?.dispose();
    }
    this.textures.clear();
  }
}

import * as THREE from 'three';

/** Couche réservée aux objets qui projettent une ombre. */
export const SHADOW_CASTER_LAYER = 2;

/**
 * Ombres portées des objets mobiles sur le décor.
 *
 * Le décor et les sources d'une carte ne bougent pas : leurs ombres mutuelles
 * sont déjà contenues dans les lightmaps, et les recalculer chaque image
 * coûterait cher sans rien ajouter. Ce que l'éclairage cuit ne peut pas
 * connaître, en revanche, ce sont les objets qui se déplacent. Seuls ceux-là
 * sont rendus ici, ce qui rend la passe très légère.
 */
export class ShadowMapper {
  private target: THREE.WebGLRenderTarget;
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 4000);
  private readonly depthMaterial: THREE.ShaderMaterial;
  readonly matrix = new THREE.Matrix4();
  readonly viewMatrix = new THREE.Matrix4();
  private resolution: number;
  private extent = 640;
  private enabled = true;

  constructor(resolution = 1024) {
    this.resolution = resolution;
    this.target = this.createTarget(resolution);

    this.depthMaterial = new THREE.ShaderMaterial({
      vertexShader: /* glsl */ `
        varying float vDepth;
        void main() {
          vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
          vDepth = -viewPosition.z;
          gl_Position = projectionMatrix * viewPosition;
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        varying float vDepth;
        void main() {
          gl_FragColor = vec4(vDepth, 0.0, 0.0, 1.0);
        }
      `,
      side: THREE.DoubleSide,
    });

    this.camera.layers.disableAll();
    this.camera.layers.enable(SHADOW_CASTER_LAYER);
  }

  private createTarget(resolution: number): THREE.WebGLRenderTarget {
    return new THREE.WebGLRenderTarget(resolution, resolution, {
      type: THREE.FloatType,
      colorSpace: THREE.NoColorSpace,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
    });
  }

  setResolution(resolution: number): void {
    if (resolution === this.resolution) return;
    this.resolution = resolution;
    this.target.dispose();
    this.target = this.createTarget(resolution);
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  get texture(): THREE.Texture {
    return this.target.texture;
  }

  get texel(): number {
    return 1 / this.resolution;
  }

  /**
   * Diagnostic : plus petite profondeur écrite et nombre de texels couverts.
   * La lecture porte sur le centre de la carte, là où se trouve le joueur,
   * et non sur un coin qui ne contient presque jamais de projeteur.
   */
  inspect(renderer: THREE.WebGLRenderer): { min: number; covered: number; total: number } {
    const size = Math.min(256, this.resolution);
    const origin = Math.max(0, Math.floor((this.resolution - size) / 2));
    const buffer = new Float32Array(size * size * 4);
    renderer.readRenderTargetPixels(this.target, origin, origin, size, size, buffer);
    let min = Infinity;
    let covered = 0;
    for (let i = 0; i < size * size; i++) {
      const value = buffer[i * 4];
      if (value < 1e6 && value > 0) {
        min = Math.min(min, value);
        covered++;
      }
    }
    return { min: min === Infinity ? -1 : min, covered, total: size * size };
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Cadre la zone utile autour du joueur et rend les projeteurs.
   * `direction` pointe du décor vers la source dominante, dans le repère de rendu.
   */
  update(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    center: THREE.Vector3,
    direction: THREE.Vector3,
  ): void {
    if (!this.enabled) return;

    // La zone couverte suit le joueur : une carte entière dans une seule
    // carte d'ombre ne laisserait que quelques texels par mètre.
    this.camera.left = -this.extent;
    this.camera.right = this.extent;
    this.camera.top = this.extent;
    this.camera.bottom = -this.extent;
    this.camera.near = 1;
    this.camera.far = this.extent * 4;
    this.camera.position.copy(center).addScaledVector(direction, this.extent * 2);
    this.camera.lookAt(center);
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();

    this.matrix.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
    this.viewMatrix.copy(this.camera.matrixWorldInverse);

    const previousTarget = renderer.getRenderTarget();
    const previousOverride = scene.overrideMaterial;

    scene.overrideMaterial = this.depthMaterial;
    renderer.setRenderTarget(this.target);
    // Le fond vaut zéro, lu comme « aucun projeteur ici ». La couleur
    // d'effacement ne peut pas dépasser un, elle ne peut donc pas servir
    // de distance infinie.
    renderer.setClearColor(0x000000, 1);
    renderer.clear(true, true, false);
    renderer.render(scene, this.camera);

    scene.overrideMaterial = previousOverride;
    renderer.setRenderTarget(previousTarget);
  }

  dispose(): void {
    this.target.dispose();
    this.depthMaterial.dispose();
  }
}

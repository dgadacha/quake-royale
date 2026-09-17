import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

/** Réglages de placement de l'arme, ajustables à chaud par le harnais. */
export interface ViewmodelPose {
  position: [number, number, number];
  rotation: [number, number, number];
  scale: number;
}

/**
 * Pose calée à l'écran, fidèle au jeu d'origine : l'arme est centrée et
 * strictement dans l'axe du regard, sans décalage ni inclinaison, vue de
 * derrière en fort raccourci. Les jeux de tir modernes la décalent à droite,
 * ce qui ne correspond pas à ce que l'on veut retrouver ici.
 *
 * La rotation autour de l'axe vertical retourne le modèle, dont le canon
 * pointe vers l'arrière dans son repère d'origine.
 */
export const defaultPose: ViewmodelPose = {
  position: [0, -0.225, -0.235],
  rotation: [0, -Math.PI / 2, 0],
  scale: 0.72,
};

export interface ViewmodelState {
  /** Vitesse horizontale, en unités de monde par seconde. */
  speed: number;
  onGround: boolean;
  mouseDeltaX: number;
  mouseDeltaY: number;
  underwater: boolean;
  /** Luminosité ambiante estimée à la position du joueur, entre 0 et 1. */
  brightness: number;
  /** Direction de la lumière dominante, exprimée dans le repère de la vue. */
  keyDirection: THREE.Vector3;
  /** Teinte de cette lumière. */
  keyColor: THREE.Color;
}

const MAX_SPEED = 320;

/**
 * Arme tenue en vue première personne.
 *
 * Elle vit dans sa propre scène et sa propre caméra : la passe de rendu qui
 * l'affiche efface le tampon de profondeur, si bien que l'arme ne peut jamais
 * s'enfoncer dans un mur, quelle que soit la géométrie du niveau. Son champ de
 * vision est plus étroit que celui du monde pour éviter la déformation qu'un
 * grand angle imposerait à un objet aussi proche.
 */
export class Viewmodel {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;

  /** Porte les décalages d'animation ; le modèle garde sa pose de base. */
  private readonly animated = new THREE.Group();
  private readonly holder = new THREE.Group();
  private model: THREE.Object3D | null = null;
  private pose: ViewmodelPose = { ...defaultPose };

  private readonly keyLight: THREE.DirectionalLight;
  private readonly fillLight: THREE.AmbientLight;
  private readonly lampLight: THREE.PointLight;
  private readonly muzzleLight: THREE.PointLight;

  // Capture de ce qui entoure le joueur : sans elle, un métal pur réfléchit
  // un décor qui n'existe pas et l'arme paraît venir d'une autre scène.
  private readonly cubeTarget: THREE.WebGLCubeRenderTarget;
  private readonly cubeCamera: THREE.CubeCamera;
  private pmrem: THREE.PMREMGenerator | null = null;
  private environmentTarget: THREE.WebGLRenderTarget | null = null;
  private lastCapture = new THREE.Vector3(Infinity, Infinity, Infinity);
  private captureAge = Infinity;

  private bobPhase = 0;
  private swayX = 0;
  private swayY = 0;
  private recoil = 0;
  private recoilVelocity = 0;
  private muzzleFlash = 0;
  private lowerAmount = 0;
  private ready = false;

  constructor(aspect: number, anisotropy: number) {
    this.camera = new THREE.PerspectiveCamera(62, aspect, 0.01, 12);
    this.animated.add(this.holder);
    this.scene.add(this.animated);
    this.anisotropy = anisotropy;

    // Basse résolution : ces reflets servent l'ambiance, pas la lisibilité.
    this.cubeTarget = new THREE.WebGLCubeRenderTarget(64, { type: THREE.HalfFloatType });
    this.cubeCamera = new THREE.CubeCamera(4, 4000, this.cubeTarget);

    // Un métal sans environnement à réfléchir rend noir : la scène reçoit une
    // ambiance neutre, dont l'intensité suit ensuite l'éclairage du niveau.
    this.fillLight = new THREE.AmbientLight(0xffffff, 0.35);
    this.keyLight = new THREE.DirectionalLight(0xfff0dc, 1.6);
    this.keyLight.position.set(0.6, 1.0, 0.4);
    this.lampLight = new THREE.PointLight(0xffd9a8, 1.1, 6, 1.6);
    this.lampLight.position.set(0.1, 0.25, 0.4);
    this.muzzleLight = new THREE.PointLight(0xffc266, 0, 4, 2);
    this.muzzleLight.position.set(0.1, -0.05, -1.1);
    this.scene.add(this.fillLight, this.keyLight, this.lampLight, this.muzzleLight);
  }

  private anisotropy: number;

  prepareEnvironment(renderer: THREE.WebGLRenderer): void {
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.pmrem.compileCubemapShader();
  }

  /**
   * Photographie le niveau autour du joueur et en fait l'environnement
   * réfléchi par l'arme. C'est ce qui accorde le métal à la pièce : sa teinte
   * et ses reflets viennent alors des vraies surfaces et des vraies lampes.
   *
   * L'opération n'a de sens que lorsque le décor visible a changé, elle est
   * donc espacée dans le temps et dans l'espace.
   */
  captureEnvironment(
    renderer: THREE.WebGLRenderer,
    worldScene: THREE.Scene,
    eye: THREE.Vector3,
    deltaTime: number,
    force = false,
  ): boolean {
    if (!this.pmrem) return false;
    this.captureAge += deltaTime;
    const moved = this.lastCapture.distanceTo(eye);
    if (!force && moved < 64 && this.captureAge < 0.5) return false;

    this.cubeCamera.position.copy(eye);
    this.cubeCamera.update(renderer, worldScene);
    this.environmentTarget = this.pmrem.fromCubemap(
      this.cubeTarget.texture,
      this.environmentTarget ?? undefined,
    );
    this.scene.environment = this.environmentTarget.texture;
    this.lastCapture.copy(eye);
    this.captureAge = 0;
    return true;
  }

  get isReady(): boolean {
    return this.ready;
  }

  async load(url: string): Promise<void> {
    const loader = new GLTFLoader();
    const gltf = await loader.loadAsync(url);
    const model = gltf.scene;

    // Le modèle est recentré sur son propre volume : la pose ne dépend
    // alors plus de l'origine choisie à l'export.
    const box = new THREE.Box3().setFromObject(model);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const longest = Math.max(size.x, size.y, size.z) || 1;
    model.position.sub(center);

    model.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      object.frustumCulled = false;
      const material = object.material as THREE.MeshStandardMaterial;
      if (!material) return;
      for (const key of ['map', 'normalMap', 'roughnessMap', 'metalnessMap'] as const) {
        const texture = material[key];
        if (texture) texture.anisotropy = this.anisotropy;
      }
      // Un métal parfaitement lisse accroche trop la lumière sur un objet
      // qui occupe le quart de l'écran.
      material.roughness = Math.max(material.roughness, 0.28);
      material.side = THREE.FrontSide;
    });

    const normalizer = new THREE.Group();
    normalizer.scale.setScalar(1 / longest);
    normalizer.add(model);

    this.holder.clear();
    this.holder.add(normalizer);
    this.model = model;
    this.applyPose();
    this.ready = true;
  }

  private applyPose(): void {
    this.holder.position.set(...this.pose.position);
    this.holder.rotation.set(...this.pose.rotation);
    this.holder.scale.setScalar(this.pose.scale);
  }

  /** Réglage à chaud, utilisé pour caler l'arme à l'écran. */
  setPose(pose: Partial<ViewmodelPose>): ViewmodelPose {
    this.pose = { ...this.pose, ...pose };
    this.applyPose();
    return { ...this.pose };
  }

  getPose(): ViewmodelPose {
    return { ...this.pose };
  }

  /** Décalage courant dû au recul, au balancement et à la traîne. */
  getMotion(): { position: [number, number, number]; rotation: [number, number, number] } {
    return {
      position: this.animated.position.toArray() as [number, number, number],
      rotation: [
        this.animated.rotation.x,
        this.animated.rotation.y,
        this.animated.rotation.z,
      ],
    };
  }

  fire(): void {
    this.recoilVelocity += 7.5;
    this.muzzleFlash = 1;
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  update(deltaTime: number, state: ViewmodelState): void {
    if (!this.model) return;

    // Balancement de marche. L'arme étant centrée, le mouvement est surtout
    // vertical : un débattement latéral marqué trahirait tout de suite
    // l'écart avec le jeu d'origine, où l'arme est rigidement liée à la vue.
    const moving = state.onGround && state.speed > 20;
    const ratio = Math.min(1, state.speed / MAX_SPEED);
    this.bobPhase += deltaTime * (moving ? 5.5 + ratio * 5.5 : 1.6);
    const bobAmount = moving ? ratio * 0.026 : 0.004;
    const bobX = Math.sin(this.bobPhase) * bobAmount * 0.3;
    const bobY = -Math.abs(Math.cos(this.bobPhase)) * bobAmount;

    // Traîne légère sur la visée : juste de quoi donner du poids à l'arme.
    const swayTargetX = THREE.MathUtils.clamp(-state.mouseDeltaX * 0.9, -0.022, 0.022);
    const swayTargetY = THREE.MathUtils.clamp(state.mouseDeltaY * 0.9, -0.022, 0.022);
    this.swayX = THREE.MathUtils.damp(this.swayX, swayTargetX, 7, deltaTime);
    this.swayY = THREE.MathUtils.damp(this.swayY, swayTargetY, 7, deltaTime);

    // Recul : ressort amorti, sans rebond visible.
    this.recoilVelocity -= this.recoil * 90 * deltaTime;
    this.recoilVelocity *= Math.exp(-11 * deltaTime);
    this.recoil += this.recoilVelocity * deltaTime;
    if (Math.abs(this.recoil) < 0.0002 && Math.abs(this.recoilVelocity) < 0.002) {
      this.recoil = 0;
      this.recoilVelocity = 0;
    }

    // L'arme s'abaisse en course et sous l'eau.
    const lowerTarget = state.underwater ? 1 : moving && ratio > 0.85 ? 0.35 : 0;
    this.lowerAmount = THREE.MathUtils.damp(this.lowerAmount, lowerTarget, 6, deltaTime);

    this.animated.position.set(
      bobX + this.swayX,
      bobY + this.swayY - this.lowerAmount * 0.12,
      this.recoil * 0.1,
    );
    this.animated.rotation.set(
      -this.recoil * 0.22 + this.lowerAmount * 0.22,
      this.swayX * 0.7,
      this.swayX * 0.8 - this.lowerAmount * 0.12,
    );

    // Éclairage accordé au lieu : la lumière vient de la direction où se
    // trouvent réellement les sources, et en prend la teinte. Une lumière
    // fixe tombant toujours d'en haut suffit à détacher l'arme du décor.
    const brightness = THREE.MathUtils.clamp(state.brightness, 0, 1);
    this.keyLight.position.copy(state.keyDirection).multiplyScalar(3);
    this.keyLight.color.copy(state.keyColor);
    this.fillLight.color.copy(state.keyColor).lerp(new THREE.Color(0.7, 0.78, 1), 0.5);

    this.fillLight.intensity = 0.2 + brightness * 0.55;
    this.keyLight.intensity = 0.35 + brightness * 1.7;
    this.lampLight.intensity = 0.9 - brightness * 0.6;
    this.scene.environmentIntensity = 0.5 + brightness * 0.9;

    this.muzzleFlash = Math.max(0, this.muzzleFlash - deltaTime * 9);
    this.muzzleLight.intensity = this.muzzleFlash * 26;
  }

  dispose(): void {
    this.cubeTarget.dispose();
    this.environmentTarget?.dispose();
    this.pmrem?.dispose();
    this.scene.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        object.geometry.dispose();
        const material = object.material as THREE.Material | THREE.Material[];
        if (Array.isArray(material)) material.forEach((m) => m.dispose());
        else material.dispose();
      }
    });
    this.scene.environment?.dispose();
  }
}

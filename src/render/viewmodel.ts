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
 * Éclair de bouche, dessiné sans texture : un noyau chaud, une couronne et
 * quelques branches. Le plan reste face à la caméra, qui ne bouge pas dans
 * cette scène, et ne s'écrit pas dans la profondeur pour ne pas masquer le
 * canon d'où il sort.
 */
function createMuzzleFlashMesh(): THREE.Mesh {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uIntensity: { value: 0 },
      uColor: { value: new THREE.Color(1.0, 0.82, 0.48) },
      uSeed: { value: 0 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform float uIntensity;
      uniform vec3 uColor;
      uniform float uSeed;
      varying vec2 vUv;

      void main() {
        vec2 p = vUv * 2.0 - 1.0;
        float radius = length(p);
        if (radius > 1.0 || uIntensity <= 0.0) discard;

        float angle = atan(p.y, p.x) + uSeed;

        float core = exp(-radius * 7.0);
        float halo = exp(-radius * 2.6) * 0.45;
        // Branches irrégulières : un éclair parfaitement symétrique se voit.
        float spikes = pow(abs(cos(angle * 2.5)), 10.0) * exp(-radius * 2.2) * 0.8;
        spikes += pow(abs(cos(angle * 4.0 + 1.7)), 14.0) * exp(-radius * 3.0) * 0.5;

        float amount = (core + halo + spikes) * uIntensity;
        gl_FragColor = vec4(uColor * amount, amount);
      }
    `,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: false,
  });

  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
  mesh.frustumCulled = false;
  mesh.visible = false;
  mesh.renderOrder = 10;
  return mesh;
}

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
  /** Modèles déjà chargés, conservés pour que le retour soit immédiat. */
  private readonly loaded = new Map<string, THREE.Group>();
  /** Avancement du rangement : 0 arme sortie, 1 arme baissée hors du cadre. */
  private stowProgress = 0;
  private stowing = false;
  private pendingSwap: (() => void) | null = null;

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

  private readonly muzzleFlashMesh = createMuzzleFlashMesh();
  /**
   * Bouche du canon, dans le repère du modèle normalisé. L'extrémité du
   * volume donne le bon avancement, mais le canon occupe la partie haute de
   * l'arme : sans relèvement, l'éclair sortirait du milieu du corps.
   */
  private readonly muzzleLocal = new THREE.Vector3(-0.52, 0.055, 0);
  private readonly muzzleWorld = new THREE.Vector3();

  private flashHold: number | null = null;
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
    this.scene.add(this.fillLight, this.keyLight, this.lampLight, this.muzzleLight);
    this.scene.add(this.muzzleFlashMesh);
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

  /**
   * Prépare un modèle et le conserve.
   * Les fichiers sont lourds : une arme déjà sortie une fois doit revenir sans
   * attente, et une arme jamais choisie ne doit pas peser en mémoire.
   */
  private async prepare(url: string): Promise<THREE.Group> {
    const cached = this.loaded.get(url);
    if (cached) return cached;

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

    this.loaded.set(url, normalizer);
    return normalizer;
  }

  /**
   * Sort une arme. Si une autre est en main, elle est d'abord rangée : un
   * échange instantané se verrait comme un défaut.
   */
  async equip(
    url: string,
    pose: ViewmodelPose,
    muzzle: [number, number, number],
    immediate = false,
  ): Promise<void> {
    const normalizer = await this.prepare(url);

    const apply = () => {
      this.holder.clear();
      this.holder.add(normalizer);
      this.model = normalizer;
      this.pose = { ...pose };
      this.muzzleLocal.set(muzzle[0], muzzle[1], muzzle[2]);
      this.applyPose();
      this.ready = true;
    };

    if (immediate || !this.ready) {
      apply();
      this.stowProgress = 0;
      this.stowing = false;
      this.pendingSwap = null;
      return;
    }

    this.pendingSwap = apply;
    this.stowing = true;
  }

  get isSwitching(): boolean {
    return this.stowing || this.stowProgress > 0.01;
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

  fire(strength = 7.5): void {
    // Le recul s'additionne d'un coup à l'autre, mais reste borné : une
    // cadence élevée ne doit pas pouvoir repousser l'arme hors du cadre.
    this.recoilVelocity = Math.min(this.recoilVelocity + strength, strength * 1.5 + 4);
    this.muzzleFlash = 1;
    // Orientation tirée au sort à chaque coup, sinon l'éclair se répète.
    const material = this.muzzleFlashMesh.material as THREE.ShaderMaterial;
    material.uniforms.uSeed.value = Math.random() * Math.PI * 2;
  }

  /**
   * Position de la bouche dans la scène de l'arme, déduite de la géométrie
   * du modèle : l'extrémité avant de son volume, suivie à travers la pose
   * courante et les mouvements d'animation.
   */
  getMuzzlePosition(target = new THREE.Vector3()): THREE.Vector3 {
    this.holder.updateWorldMatrix(true, false);
    return target.copy(this.muzzleLocal).applyMatrix4(this.holder.matrixWorld);
  }

  /**
   * Fige l'éclair à une intensité donnée, ou rend la main à l'extinction
   * normale. Sert à l'inspecter, sa durée réelle étant trop brève.
   */
  holdFlash(value: number | null): void {
    this.flashHold = value;
    if (value !== null) this.muzzleFlash = value;
  }

  /** Décalage fin de la bouche, réglable sans recompiler. */
  setMuzzleOffset(x: number, y: number, z: number): [number, number, number] {
    this.muzzleLocal.set(x, y, z);
    return [x, y, z];
  }

  getMuzzleOffset(): [number, number, number] {
    return [this.muzzleLocal.x, this.muzzleLocal.y, this.muzzleLocal.z];
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
    this.recoil = THREE.MathUtils.clamp(this.recoil + this.recoilVelocity * deltaTime, -0.02, 0.13);
    if (Math.abs(this.recoil) < 0.0002 && Math.abs(this.recoilVelocity) < 0.002) {
      this.recoil = 0;
      this.recoilVelocity = 0;
    }

    // Rangement et sortie lors d'un changement d'arme.
    if (this.stowing) {
      this.stowProgress = Math.min(1, this.stowProgress + deltaTime * 5.5);
      if (this.stowProgress >= 1) {
        // L'échange a lieu hors du cadre, jamais sous les yeux du joueur.
        this.pendingSwap?.();
        this.pendingSwap = null;
        this.stowing = false;
      }
    } else if (this.stowProgress > 0) {
      this.stowProgress = Math.max(0, this.stowProgress - deltaTime * 4.5);
    }

    // L'arme s'abaisse en course et sous l'eau.
    const lowerTarget = state.underwater ? 1 : moving && ratio > 0.85 ? 0.35 : 0;
    this.lowerAmount = THREE.MathUtils.damp(this.lowerAmount, lowerTarget, 6, deltaTime);
    const stow = this.stowProgress;

    this.animated.position.set(
      bobX + this.swayX,
      bobY + this.swayY - this.lowerAmount * 0.12 - stow * 0.42,
      this.recoil * 0.1,
    );
    this.animated.rotation.set(
      -this.recoil * 0.22 + this.lowerAmount * 0.22 + stow * 0.9,
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

    // L'éclair part de la bouche, pas d'un point fixe de la scène : il suit
    // donc le recul et le balancement de l'arme.
    this.muzzleFlash =
      this.flashHold !== null ? this.flashHold : Math.max(0, this.muzzleFlash - deltaTime * 11);
    this.getMuzzlePosition(this.muzzleWorld);
    this.muzzleLight.position.copy(this.muzzleWorld);
    this.muzzleLight.intensity = this.muzzleFlash * 22;

    const flashMaterial = this.muzzleFlashMesh.material as THREE.ShaderMaterial;
    this.muzzleFlashMesh.visible = this.muzzleFlash > 0.001;
    if (this.muzzleFlashMesh.visible) {
      this.muzzleFlashMesh.position.copy(this.muzzleWorld);
      // Il s'étale en s'éteignant, comme une bouffée de gaz.
      const growth = 0.19 + (1 - this.muzzleFlash) * 0.1;
      this.muzzleFlashMesh.scale.setScalar(growth);
      flashMaterial.uniforms.uIntensity.value = Math.pow(this.muzzleFlash, 0.75) * 1.15;
    }
  }

  dispose(): void {
    this.loaded.clear();
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

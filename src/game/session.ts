import * as THREE from 'three';
import { Contents } from '../formats/bsp';
import { createPostProcessing, type PostProcessing } from '../render/postfx';
import { loadGraphics, saveGraphics, type GraphicsSettings } from '../render/graphics';
import { HDMaterialManager } from '../hd/materials/HDMaterialManager';
import { HDLightManager } from '../hd/lights/HDLightManager';
import { ShadowMapper } from '../render/shadows';
import type { AudioEngine } from '../audio/AudioEngine';
import { pick, soundTable } from '../audio/soundTable';
import { Viewmodel } from '../render/viewmodel';
import { weaponAt, weapons, type WeaponDefinition } from './weapons';
import { defaultWorldOptions, quakeToThree, type WorldOptions } from '../render/world';
import { InputManager } from './input';
import type { Level } from './level';
import { Player } from './player';

export interface SessionStats {
  fps: number;
  speed: number;
  position: [number, number, number];
  draws: number;
  faces: number;
  textures: number;
  health: number;
  enemiesAlive: number;
  enemiesAwake: number;
}

/** Boucle de jeu : entrée, physique, rendu et effets d'ambiance. */
export class Session {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly input: InputManager;
  readonly options: WorldOptions;

  private post: PostProcessing;
  private graphics: GraphicsSettings = loadGraphics();
  readonly viewmodel: Viewmodel;
  readonly hdMaterials: HDMaterialManager;
  readonly hdLights = new HDLightManager();
  readonly shadows = new ShadowMapper();
  private player: Player | null = null;
  private level: Level | null = null;
  private clock = new THREE.Clock();
  private running = false;
  private frameTimes: number[] = [];
  private elapsed = 0;
  private flashColor = new THREE.Color(0.55, 0.48, 0.38);
  /** Reste de l'éclair de bouche, qui éclaire aussi le décor. */
  private muzzleGlow = 0;
  /** Compte à rebours avant réapparition. */
  private deathTimer = 0;
  private weaponIndex = 0;
  private fireCooldown = 0;
  private audio: AudioEngine | null = null;
  /** État précédent, pour ne déclencher un son qu'au moment du changement. */
  private wasOnGround = true;
  private wasInWater = false;
  private lastFallSpeed = 0;
  private readonly lampColor = new THREE.Color();
  private readonly muzzleColor = new THREE.Color(1.5, 1.1, 0.62);
  // Objets réutilisés à chaque image, pour ne rien allouer dans la boucle.
  private readonly keyDirection = new THREE.Vector3();
  /** Même direction, gardée dans le repère du monde pour les ombres. */
  private readonly keyDirectionWorld = new THREE.Vector3(0, 1, 0);
  private readonly keyColor = new THREE.Color();
  private readonly viewRotation = new THREE.Quaternion();
  private readonly eyePosition = new THREE.Vector3();
  private underwaterAmount = 0;
  private onStats?: (stats: SessionStats) => void;

  constructor(readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;

    this.camera = new THREE.PerspectiveCamera(90, window.innerWidth / window.innerHeight, 1, 8000);
    this.options = defaultWorldOptions(this.renderer.capabilities.getMaxAnisotropy());
    this.hdMaterials = new HDMaterialManager(this.renderer.capabilities.getMaxAnisotropy());
    this.options.hdMaterials = this.hdMaterials;
    // Les matériaux lisent directement les tableaux du gestionnaire : aucune
    // recopie n'est nécessaire d'une image à l'autre.
    this.options.lightPositions = this.hdLights.uniforms.positions;
    this.options.lightColors = this.hdLights.uniforms.colors;

    this.viewmodel = new Viewmodel(
      window.innerWidth / window.innerHeight,
      this.renderer.capabilities.getMaxAnisotropy(),
    );
    this.viewmodel.prepareEnvironment(this.renderer);
    this.post = createPostProcessing(this.renderer, this.scene, this.camera, {
      scene: this.viewmodel.scene,
      camera: this.viewmodel.camera,
    });
    this.input = new InputManager(canvas);
    this.post.setGraphics(this.graphics);
    this.shadows.setResolution(this.graphics.shadowResolution);
    this.shadows.setEnabled(this.graphics.shadows);

    // L'arme est volumineuse : elle se charge en tâche de fond et apparaît
    // dès qu'elle est prête, sans retarder l'entrée dans le niveau.
    void this.selectWeapon(0, true);

    window.addEventListener('resize', this.onResize);
  }

  setStatsListener(listener: (stats: SessionStats) => void): void {
    this.onStats = listener;
  }

  setAudio(audio: AudioEngine): void {
    this.audio = audio;
  }

  get currentWeapon(): WeaponDefinition {
    return weaponAt(this.weaponIndex);
  }

  /** Sort une arme ; le changement est ignoré tant qu'un autre est en cours. */
  async selectWeapon(index: number, immediate = false): Promise<void> {
    const next = weaponAt(index);
    if (!immediate && (next.id === this.currentWeapon.id || this.viewmodel.isSwitching)) return;
    this.weaponIndex = ((index % weapons.length) + weapons.length) % weapons.length;
    try {
      await this.viewmodel.equip(next.url, next.pose, next.muzzle, immediate);
    } catch (error) {
      console.warn(`[quake-hd] arme non chargée : ${(error as Error).message}`);
    }
  }

  cycleWeapon(direction: number): void {
    void this.selectWeapon(this.weaponIndex + direction);
  }

  /** Écarte une direction de tir, pour une gerbe de projectiles. */
  private scatter(aim: [number, number, number], amount: number): [number, number, number] {
    // Deux axes perpendiculaires à la visée suffisent à disperser la gerbe.
    const up: [number, number, number] = Math.abs(aim[2]) > 0.9 ? [1, 0, 0] : [0, 0, 1];
    const right: [number, number, number] = [
      aim[1] * up[2] - aim[2] * up[1],
      aim[2] * up[0] - aim[0] * up[2],
      aim[0] * up[1] - aim[1] * up[0],
    ];
    const rightLength = Math.hypot(right[0], right[1], right[2]) || 1;
    const perp: [number, number, number] = [
      aim[1] * right[2] - aim[2] * right[1],
      aim[2] * right[0] - aim[0] * right[2],
      aim[0] * right[1] - aim[1] * right[0],
    ];
    const perpLength = Math.hypot(perp[0], perp[1], perp[2]) || 1;

    const a = (Math.random() * 2 - 1) * amount;
    const b = (Math.random() * 2 - 1) * amount;
    const result: [number, number, number] = [
      aim[0] + (right[0] / rightLength) * a + (perp[0] / perpLength) * b,
      aim[1] + (right[1] / rightLength) * a + (perp[1] / perpLength) * b,
      aim[2] + (right[2] / rightLength) * a + (perp[2] / perpLength) * b,
    ];
    const length = Math.hypot(result[0], result[1], result[2]) || 1;
    return [result[0] / length, result[1] / length, result[2] / length];
  }

  private playSound(list: readonly string[], volume = 1): void {
    const file = pick(list);
    if (file) this.audio?.play(file, { volume });
  }

  get graphicsSettings(): GraphicsSettings {
    return { ...this.graphics };
  }

  /** Applique un réglage d'image et le conserve pour les sessions suivantes. */
  setGraphics(settings: Partial<GraphicsSettings>): GraphicsSettings {
    this.graphics = { ...this.graphics, ...settings };
    this.post.setGraphics(this.graphics);
    this.hdLights.setBudget({
      maxLights: this.graphics.dynamicLights ? this.graphics.maxLights : 0,
      diffuse: this.graphics.lightDiffuse,
      specular: this.graphics.lightSpecular,
    });
    saveGraphics(this.graphics);
    return { ...this.graphics };
  }

  setLevel(level: Level): void {
    if (this.level) {
      this.scene.remove(this.level.root);
      this.level.dispose();
    }
    this.level = level;
    this.scene.add(level.root);
    this.player = new Player(level.collision, level.spawn, level.spawnYaw);
    level.setLighting(this.graphics.brightness, this.graphics.contrast);
    level.setVisibilityEnabled(this.graphics.visibilityCulling);
    this.hdLights.setLights(level.hdLights);
    this.hdLights.setVisibilityTest((from, to) => level.isVisible(from, to));
    this.hdLights.setBudget({
      maxLights: this.graphics.dynamicLights ? this.graphics.maxLights : 0,
      diffuse: this.graphics.lightDiffuse,
      specular: this.graphics.lightSpecular,
    });
    this.elapsed = 0;

    // Première photographie du décor avant la toute première image.
    this.viewmodel.captureEnvironment(
      this.renderer,
      this.scene,
      this.player.eyeWorldPosition(this.eyePosition),
      0,
      true,
    );
  }

  get currentLevel(): Level | null {
    return this.level;
  }

  /** Accès direct au joueur, utilisé par le harnais de mise au point. */
  get playerRef(): Player | null {
    return this.player;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.clock.start();
    this.renderer.setAnimationLoop(this.frame);
  }

  stop(): void {
    this.running = false;
    this.renderer.setAnimationLoop(null);
  }

  private onResize = () => {
    const width = window.innerWidth;
    const height = window.innerHeight;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
    this.post.setSize(width, height);
    this.viewmodel.setAspect(width / height);
  };

  private frame = () => {
    const delta = Math.min(this.clock.getDelta(), 0.1);
    this.elapsed += delta;

    if (this.player && this.level) {
      this.player.update(this.input, delta);
      this.player.applyToCamera(this.camera);
      this.level.update(this.elapsed);
      this.level.updateEntities(delta, this.player.position);
      this.level.updateVisibility(this.player.position);

      const damage = this.level.updateEnemies(delta, this.player.position);
      if (damage > 0 && this.player.health > 0) {
        const died = this.player.hurt(damage);
        this.playSound(died ? soundTable.playerDeath : soundTable.playerPain, 0.85);
        if (died) this.deathTimer = 2.2;
      }
      if (this.deathTimer > 0) {
        this.deathTimer -= delta;
        if (this.deathTimer <= 0) this.player.respawn();
      }

      // Sources dynamiques : la sélection suit le joueur, les intensités
      // suivent les mêmes styles d'animation que les lightmaps.
      this.hdLights.update(this.player.position, delta, (style) =>
        this.level!.styleIntensity(style),
      );
      this.level.setDynamicLights(
        this.hdLights.activeCount,
        this.hdLights.diffuseAmount,
        this.hdLights.specularAmount,
      );

      // Ombres portées des objets mobiles, cadrées autour du joueur et
      // orientées par la source dominante du lieu.
      if (this.shadows.isEnabled) {
        this.shadows.update(
          this.renderer,
          this.scene,
          this.player.eyeWorldPosition(this.eyePosition),
          this.keyDirectionWorld,
        );
        this.level.setShadow(
          this.shadows.texture,
          this.shadows.matrix,
          this.shadows.viewMatrix,
          0.75,
          this.shadows.texel,
        );
      } else {
        this.level.setShadow(
          this.shadows.texture,
          this.shadows.matrix,
          this.shadows.viewMatrix,
          0,
          this.shadows.texel,
        );
      }

      // Lampe portée : le halo suit la tête, jamais la direction de visée
      // pour ne pas écraser le modelé des lightmaps. Le temps d'un coup de
      // feu, elle se renforce et se réchauffe : le décor doit s'éclairer
      // aussi, sinon l'éclair semble n'exister que sur l'arme.
      this.muzzleGlow = Math.max(0, this.muzzleGlow - delta * 9);
      const eye = this.player.eyeWorldPosition();
      this.lampColor.copy(this.flashColor).lerp(this.muzzleColor, this.muzzleGlow);
      this.level.setFlashlight(eye, this.lampColor, 420 + this.muzzleGlow * 560);

      const targetUnderwater = this.player.underwater ? 1 : 0;
      this.underwaterAmount += (targetUnderwater - this.underwaterAmount) * Math.min(1, delta * 6);
      const tint =
        this.player.waterType === Contents.LAVA
          ? new THREE.Color(1.6, 0.45, 0.2)
          : this.player.waterType === Contents.SLIME
            ? new THREE.Color(0.6, 1.2, 0.5)
            : new THREE.Color(0.45, 0.75, 1.1);
      // Les sons d'état ne se déclenchent qu'au passage d'une limite.
      const onGround = this.player.state.onGround;
      if (onGround && !this.wasOnGround && this.lastFallSpeed < -260) {
        this.playSound(soundTable.playerLand, 0.6);
      }
      if (!onGround && this.wasOnGround && this.player.state.velocity[2] > 200) {
        this.playSound(soundTable.playerJump, 0.45);
      }
      this.lastFallSpeed = this.player.state.velocity[2];
      this.wasOnGround = onGround;

      const inWater = this.player.state.waterLevel >= 2;
      if (inWater !== this.wasInWater) {
        this.playSound(
          inWater ? soundTable.playerEnterWater : soundTable.playerLeaveWater,
          0.6,
        );
        this.wasInWater = inWater;
      }

      this.audio?.updateListener(this.camera);
      this.post.setUnderwater(this.underwaterAmount, tint);
      // Rouge à l'écran : dégâts encaissés, bain de lave, ou mort en cours.
      const hurtFlash = Math.max(0, 0.55 - this.player.sinceHurt * 1.6);
      const lava = this.player.inLava ? 0.35 + Math.sin(this.elapsed * 12) * 0.1 : 0;
      const dying = this.deathTimer > 0 ? 0.7 : 0;
      this.post.setDamage(Math.max(hurtFlash, lava, dying));

      this.fireCooldown = Math.max(0, this.fireCooldown - delta);
      if (
        this.player.consumeAttack() &&
        this.player.health > 0 &&
        this.fireCooldown <= 0 &&
        !this.viewmodel.isSwitching
      ) {
        const weapon = this.currentWeapon;
        this.fireCooldown = weapon.cooldown;
        this.viewmodel.fire(weapon.recoil);
        this.muzzleGlow = 1;
        this.playSound(weapon.fireSounds, 0.7);

        // Le tir part de l'oeil et suit la visée, pas le canon : c'est ce que
        // le joueur vise qui doit être touché. Une arme à gerbe lance
        // plusieurs projectiles dispersés autour de cet axe.
        const origin = this.player.eyeOrigin;
        const aim = this.player.aimDirection;
        for (let shot = 0; shot < weapon.pellets; shot++) {
          const direction =
            weapon.pellets === 1 ? aim : this.scatter(aim, weapon.spread / 100);
          this.level.fire(origin, direction, weapon.damage);
        }
      }

      // La lumière dominante du niveau est ramenée dans le repère de la vue :
      // l'arme, qui vit dans une scène fixe, reçoit ainsi sa lumière du côté
      // où les sources se trouvent réellement dans le décor.
      const lighting = this.level.sampleLighting(this.player.position);
      const [kx, ky, kz] = quakeToThree(
        lighting.direction[0],
        lighting.direction[1],
        lighting.direction[2],
      );
      this.keyDirectionWorld.set(kx, ky, kz);
      this.viewRotation.copy(this.camera.quaternion).invert();
      this.keyDirection.set(kx, ky, kz).applyQuaternion(this.viewRotation);
      this.keyColor.copy(lighting.color);

      const [aimX, aimY] = this.player.aimDelta;
      this.viewmodel.update(delta, {
        speed: this.player.speed,
        onGround: this.player.state.onGround,
        mouseDeltaX: aimX,
        mouseDeltaY: aimY,
        underwater: this.player.underwater,
        brightness: lighting.intensity,
        keyDirection: this.keyDirection,
        keyColor: this.keyColor,
      });

      // Reflets : le décor est rephotographié quand le joueur a changé d'endroit.
      this.viewmodel.captureEnvironment(
        this.renderer,
        this.scene,
        this.player.eyeWorldPosition(this.eyePosition),
        delta,
      );
    }

    this.post.render(delta);
    this.reportStats(delta);
  };

  private reportStats(delta: number): void {
    this.frameTimes.push(delta);
    if (this.frameTimes.length > 30) this.frameTimes.shift();
    if (!this.onStats || !this.player || !this.level) return;

    const average = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
    const enemies = this.level.enemyInfo();
    this.onStats({
      fps: average > 0 ? 1 / average : 0,
      speed: this.player.speed,
      position: [...this.player.position] as [number, number, number],
      draws: this.renderer.info.render.calls,
      faces: this.level.stats.faces,
      textures: this.level.stats.textures,
      health: this.player.health,
      enemiesAlive: enemies.alive,
      enemiesAwake: enemies.awake,
    });
  }

  dispose(): void {
    this.stop();
    window.removeEventListener('resize', this.onResize);
    this.input.dispose();
    this.viewmodel.dispose();
    this.shadows.dispose();
    this.hdMaterials.dispose();
    this.level?.dispose();
    this.post.dispose();
    this.renderer.dispose();
  }
}

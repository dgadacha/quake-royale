import * as THREE from 'three';
import { Contents } from '../formats/bsp';
import { createPostProcessing, type PostProcessing } from '../render/postfx';
import { defaultWorldOptions, type WorldOptions } from '../render/world';
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
}

/** Boucle de jeu : entrée, physique, rendu et effets d'ambiance. */
export class Session {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly input: InputManager;
  readonly options: WorldOptions;

  private post: PostProcessing;
  private player: Player | null = null;
  private level: Level | null = null;
  private clock = new THREE.Clock();
  private running = false;
  private frameTimes: number[] = [];
  private elapsed = 0;
  private flashColor = new THREE.Color(0.55, 0.48, 0.38);
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
    this.post = createPostProcessing(this.renderer, this.scene, this.camera);
    this.input = new InputManager(canvas);

    window.addEventListener('resize', this.onResize);
  }

  setStatsListener(listener: (stats: SessionStats) => void): void {
    this.onStats = listener;
  }

  setLevel(level: Level): void {
    if (this.level) {
      this.scene.remove(this.level.root);
      this.level.dispose();
    }
    this.level = level;
    this.scene.add(level.root);
    this.player = new Player(level.collision, level.spawn, level.spawnYaw);
    this.elapsed = 0;
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
  };

  private frame = () => {
    const delta = Math.min(this.clock.getDelta(), 0.1);
    this.elapsed += delta;

    if (this.player && this.level) {
      this.player.update(this.input, delta);
      this.player.applyToCamera(this.camera);
      this.level.update(this.elapsed);

      // Lampe portée : le halo suit la tête, jamais la direction de visée
      // pour ne pas écraser le modelé des lightmaps.
      const eye = this.player.eyeWorldPosition();
      this.level.setFlashlight(eye, this.flashColor, 420);

      const targetUnderwater = this.player.underwater ? 1 : 0;
      this.underwaterAmount += (targetUnderwater - this.underwaterAmount) * Math.min(1, delta * 6);
      const tint =
        this.player.waterType === Contents.LAVA
          ? new THREE.Color(1.6, 0.45, 0.2)
          : this.player.waterType === Contents.SLIME
            ? new THREE.Color(0.6, 1.2, 0.5)
            : new THREE.Color(0.45, 0.75, 1.1);
      this.post.setUnderwater(this.underwaterAmount, tint);
      this.post.setDamage(this.player.inLava ? 0.35 + Math.sin(this.elapsed * 12) * 0.1 : 0);
    }

    this.post.render(delta);
    this.reportStats(delta);
  };

  private reportStats(delta: number): void {
    this.frameTimes.push(delta);
    if (this.frameTimes.length > 30) this.frameTimes.shift();
    if (!this.onStats || !this.player || !this.level) return;

    const average = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
    this.onStats({
      fps: average > 0 ? 1 / average : 0,
      speed: this.player.speed,
      position: [...this.player.position] as [number, number, number],
      draws: this.renderer.info.render.calls,
      faces: this.level.stats.faces,
      textures: this.level.stats.textures,
    });
  }

  dispose(): void {
    this.stop();
    window.removeEventListener('resize', this.onResize);
    this.input.dispose();
    this.level?.dispose();
    this.post.dispose();
    this.renderer.dispose();
  }
}

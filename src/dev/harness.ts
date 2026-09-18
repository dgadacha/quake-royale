import type { Session } from '../game/session';
import type { Vec3 } from '../game/collision';

/**
 * Harnais de mise au point, activé par ?dev.
 * Il permet de piloter la physique depuis la console sans passer par
 * la souris, et de vérifier un comportement de déplacement sans le jouer.
 */
export interface HarnessState {
  origin: Vec3;
  velocity: Vec3;
  onGround: boolean;
  waterLevel: number;
  yaw: number;
  pitch: number;
}

export interface SimulateOptions {
  forward?: number;
  side?: number;
  jump?: boolean;
  run?: boolean;
  seconds?: number;
  yaw?: number;
  /** Rotation appliquée à chaque pas, pour reproduire un contrôle à la souris. */
  yawRate?: number;
}

export function installHarness(session: Session): void {
  const api = {
    state(): HarnessState | null {
      const player = session.playerRef;
      if (!player) return null;
      return {
        origin: [...player.state.origin] as Vec3,
        velocity: [...player.state.velocity] as Vec3,
        onGround: player.state.onGround,
        waterLevel: player.state.waterLevel,
        yaw: player.yaw,
        pitch: player.pitch,
      };
    },

    teleport(x: number, y: number, z: number): HarnessState | null {
      const player = session.playerRef;
      if (!player) return null;
      player.state.origin = [x, y, z];
      player.state.velocity = [0, 0, 0];
      return api.state();
    },

    /** Avance la physique à pas fixes, sans dépendre du rythme d'affichage. */
    simulate(options: SimulateOptions = {}): HarnessState | null {
      const player = session.playerRef;
      if (!player) return null;
      const seconds = options.seconds ?? 1;
      const dt = 1 / 72;
      const steps = Math.max(1, Math.round(seconds / dt));
      if (options.yaw !== undefined) player.yaw = options.yaw;

      for (let i = 0; i < steps; i++) {
        if (options.yawRate) player.yaw += options.yawRate * dt;
        player.stepForHarness(
          {
            forward: options.forward ?? 0,
            side: options.side ?? 0,
            jump: options.jump ?? false,
            run: options.run ?? true,
          },
          dt,
        );
      }
      return api.state();
    },

    /** Oriente la vue sans passer par la souris. */
    look(yaw: number, pitch: number) {
      const player = session.playerRef;
      if (!player) return null;
      player.yaw = yaw;
      player.pitch = pitch;
      return api.state();
    },

    /** Etat des modèles animés : utile pour vérifier le mélange d'images. */
    props() {
      const out: { blend: number; position: number[] }[] = [];
      session.scene.traverse((object) => {
        const material = (object as { material?: { uniforms?: Record<string, { value: unknown }> } })
          .material;
        const blend = material?.uniforms?.uBlend;
        if (blend) {
          out.push({
            blend: blend.value as number,
            position: (object as { position: { toArray(): number[] } }).position.toArray(),
          });
        }
      });
      return out;
    },

    /** Lit ou ajuste le placement de l'arme sans recompiler. */
    weapon(pose?: { position?: [number, number, number]; rotation?: [number, number, number]; scale?: number }) {
      const viewmodel = session.viewmodel;
      if (!pose) return { pret: viewmodel.isReady, ...viewmodel.getPose() };
      return viewmodel.setPose(pose);
    },

    fire() {
      session.viewmodel.fire();
      return 'tir';
    },

    /** Fige l'éclair de bouche pour l'observer, null pour reprendre. */
    holdFlash(value: number | null = 1) {
      session.viewmodel.holdFlash(value);
      return value;
    },

    /** Lit ou ajuste la position de la bouche du canon. */
    muzzle(offset?: [number, number, number]) {
      const viewmodel = session.viewmodel;
      if (!offset) return viewmodel.getMuzzleOffset();
      return viewmodel.setMuzzleOffset(offset[0], offset[1], offset[2]);
    },

    /** Décalage courant de l'arme, pour observer le recul et le balancement. */
    weaponMotion() {
      return session.viewmodel.getMotion();
    },

    /** Contenu de la carte d'ombre, pour vérifier que des projeteurs y entrent. */
    shadowMap() {
      return session.shadows.inspect(session.renderer);
    },

    /** État de la sortie audio ; l'appel la démarre si besoin. */
    audio(volume?: number) {
      const engine = (window as unknown as { __audio?: import('../audio/AudioEngine').AudioEngine })
        .__audio;
      if (!engine) return null;
      engine.resume();
      if (volume !== undefined) engine.setVolume(volume);
      return { actif: engine.isRunning, sonsCharges: engine.loadedCount, actifs: engine.isEnabled };
    },

    /** Marques et éclats actuellement en vie. */
    effects() {
      return session.currentLevel?.effectsInfo() ?? null;
    },

    /** Adversaires : position, état, santé. */
    enemies() {
      return session.currentLevel?.enemyStates() ?? [];
    },

    /** Tire dans la direction de visée et renvoie le résultat. */
    shoot(damage = 24) {
      const level = session.currentLevel;
      const player = session.playerRef;
      if (!level || !player) return null;
      return level.fire(player.eyeOrigin, player.aimDirection, damage);
    },

    /** Santé du joueur. */
    health() {
      return session.playerRef?.health ?? 0;
    },

    /** Visibilité : feuille courante et faces réellement dessinées. */
    visibility(enabled?: boolean) {
      const level = session.currentLevel;
      if (!level) return null;
      if (enabled !== undefined) level.setVisibilityEnabled(enabled);
      return level.visibilityInfo();
    },

    /** Trace depuis le joueur vers un point : 1 = rien sur le chemin. */
    traceTo(x: number, y: number, z: number) {
      const level = session.currentLevel;
      const player = session.playerRef;
      if (!level || !player) return null;
      const result = level.collision.trace(player.state.origin, [x, y, z]);
      return {
        fraction: Number(result.fraction.toFixed(3)),
        touche: result.hit,
        arrivee: result.endPos.map((v) => Math.round(v)),
      };
    },

    /** Portes et plateformes : position, état, avancement. */
    movers() {
      return session.currentLevel?.moverStates() ?? [];
    },

    /** Sources dynamiques retenues autour du joueur. */
    lights() {
      return {
        actives: session.hdLights.activeCount,
        total: session.hdLights.totalCount,
        budget: session.hdLights.currentBudget,
      };
    },

    /** Lit ou modifie les réglages d'image. */
    graphics(settings?: Record<string, unknown>) {
      if (!settings) return session.graphicsSettings;
      return session.setGraphics(settings as never);
    },

    level() {
      const level = session.currentLevel;
      return level ? { name: level.name, ...level.stats } : null;
    },
  };

  (window as unknown as Record<string, unknown>).qhd = api;
  console.info('[quake-hd] harnais de mise au point disponible : window.qhd');
}

import * as THREE from 'three';
import type { VirtualFileSystem } from '../formats/pak';

export interface PlayOptions {
  /** Position dans le monde de rendu ; absente, le son est joué sans direction. */
  position?: THREE.Vector3;
  volume?: number;
  /** Hauteur relative, pour éviter la répétition mécanique. */
  rate?: number;
  /** Distance au-delà de laquelle le son n'est plus audible. */
  range?: number;
  /** Un son en boucle est rendu pour pouvoir être arrêté. */
  loop?: boolean;
}

export interface LoopHandle {
  stop(): void;
  setVolume(value: number): void;
}

/**
 * Sortie audio du moteur.
 *
 * Les sons viennent des données montées, décodés à la demande et conservés :
 * une carte n'en emploie qu'une poignée mais les rejoue sans cesse. La
 * spatialisation passe par l'écoute placée sur la caméra, ce qui donne la
 * direction d'un adversaire hors champ, information qu'aucun affichage ne
 * remplace.
 */
export class AudioEngine {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private readonly buffers = new Map<string, AudioBuffer | null>();
  private readonly pending = new Map<string, Promise<AudioBuffer | null>>();
  private volume = 0.8;
  private enabled = true;

  constructor(private readonly vfs: VirtualFileSystem) {}

  /**
   * Démarre la sortie audio. Un navigateur refuse de produire du son avant
   * une action de l'utilisateur : l'appel doit donc partir d'un clic.
   */
  resume(): void {
    if (!this.context) {
      this.context = new AudioContext();
      this.master = this.context.createGain();
      this.master.gain.value = this.enabled ? this.volume : 0;
      this.master.connect(this.context.destination);
    }
    if (this.context.state === 'suspended') void this.context.resume();
  }

  get isRunning(): boolean {
    return this.context?.state === 'running';
  }

  setVolume(value: number): void {
    this.volume = Math.max(0, Math.min(1, value));
    if (this.master) this.master.gain.value = this.enabled ? this.volume : 0;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (this.master) this.master.gain.value = enabled ? this.volume : 0;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /** Place l'écoute sur la caméra, position et orientation comprises. */
  updateListener(camera: THREE.Camera): void {
    const context = this.context;
    if (!context) return;

    const listener = context.listener;
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    camera.matrixWorld.decompose(position, quaternion, scale);

    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(quaternion);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(quaternion);

    // Les navigateurs récents exposent des paramètres, les autres des méthodes.
    if (listener.positionX) {
      listener.positionX.value = position.x;
      listener.positionY.value = position.y;
      listener.positionZ.value = position.z;
      listener.forwardX.value = forward.x;
      listener.forwardY.value = forward.y;
      listener.forwardZ.value = forward.z;
      listener.upX.value = up.x;
      listener.upY.value = up.y;
      listener.upZ.value = up.z;
    } else {
      listener.setPosition(position.x, position.y, position.z);
      listener.setOrientation(forward.x, forward.y, forward.z, up.x, up.y, up.z);
    }
  }

  /** Décode un son des données montées ; le résultat est conservé. */
  private async load(path: string): Promise<AudioBuffer | null> {
    if (this.buffers.has(path)) return this.buffers.get(path) ?? null;
    const existing = this.pending.get(path);
    if (existing) return existing;

    const task = (async () => {
      const context = this.context;
      const data = this.vfs.read(path);
      if (!context || !data) {
        this.buffers.set(path, null);
        return null;
      }
      try {
        // Le décodage consomme son tampon : les données du système de
        // fichiers sont des vues sur une archive entière, on en fait une copie.
        const copy = data.slice().buffer as ArrayBuffer;
        const buffer = await context.decodeAudioData(copy);
        this.buffers.set(path, buffer);
        return buffer;
      } catch {
        // Un son illisible ne doit pas interrompre le jeu.
        this.buffers.set(path, null);
        return null;
      } finally {
        this.pending.delete(path);
      }
    })();

    this.pending.set(path, task);
    return task;
  }

  /** Précharge une liste de sons, pour éviter un silence au premier emploi. */
  async preload(paths: string[]): Promise<number> {
    if (!this.context) return 0;
    const results = await Promise.all(paths.map((path) => this.load(path)));
    return results.filter(Boolean).length;
  }

  play(path: string, options: PlayOptions = {}): LoopHandle | null {
    const context = this.context;
    const master = this.master;
    if (!context || !master || !this.enabled) return null;

    const buffer = this.buffers.get(path);
    if (buffer === undefined) {
      // Pas encore décodé : on le charge, et il servira au prochain appel.
      void this.load(path);
      return null;
    }
    if (!buffer) return null;

    const source = context.createBufferSource();
    source.buffer = buffer;
    source.loop = options.loop ?? false;
    source.playbackRate.value = options.rate ?? 1;

    const gain = context.createGain();
    gain.gain.value = options.volume ?? 1;

    if (options.position) {
      const panner = context.createPanner();
      panner.panningModel = 'HRTF';
      panner.distanceModel = 'linear';
      panner.refDistance = 120;
      panner.maxDistance = options.range ?? 2400;
      panner.rolloffFactor = 1;
      panner.positionX.value = options.position.x;
      panner.positionY.value = options.position.y;
      panner.positionZ.value = options.position.z;
      source.connect(gain).connect(panner).connect(master);
    } else {
      source.connect(gain).connect(master);
    }

    source.start();

    return {
      stop: () => {
        try {
          source.stop();
        } catch {
          // Déjà terminé.
        }
      },
      setVolume: (value: number) => {
        gain.gain.value = value;
      },
    };
  }

  get loadedCount(): number {
    let total = 0;
    for (const buffer of this.buffers.values()) if (buffer) total++;
    return total;
  }

  dispose(): void {
    void this.context?.close();
    this.context = null;
    this.master = null;
    this.buffers.clear();
  }
}

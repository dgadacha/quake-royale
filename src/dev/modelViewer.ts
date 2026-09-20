import * as THREE from 'three';
import { parseMdl, type MdlModel } from '../formats/mdl';
import { Palette } from '../formats/palette';
import type { VirtualFileSystem } from '../formats/pak';
import { AliasModel } from '../render/aliasModel';
import { detectAnimations } from '../render/aliasAnimation';
import { subdivideModel } from '../render/subdivideModel';
import { identifyParts, modelParts } from '../render/deformationTransfer';

/**
 * Visualisateur de modèles.
 *
 * Juger un modèle depuis la partie ne marche pas : il est petit, il bouge, il
 * tire, et l'on conclut de travers sur ce qu'on croit voir. Ici il est seul,
 * tournant sur lui-même, et l'on choisit l'image qu'on regarde — de quoi
 * vérifier une peau refaite, une subdivision ou une animation sans avoir à
 * traverser un niveau.
 */

const SKIN_DIRECTORY = 'data/hd/skins';

interface ViewerState {
  path: string;
  subdivisions: number;
  wireframe: boolean;
  useDetailedSkin: boolean;
  playing: boolean;
  speed: number;
  /** Éclairage du visualisateur : une peau sombre demande plus de lumière. */
  brightness: number;
  /** Séquence choisie, ou null pour parcourir toutes les images. */
  sequence: string | null;
}

export interface ModelViewerOptions {
  renderer: THREE.WebGLRenderer;
  vfs: VirtualFileSystem;
  palette: Palette;
  anisotropy: number;
  container: HTMLElement;
  onExit(): void;
}

export class ModelViewer {
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly pivot = new THREE.Group();
  private readonly grid: THREE.GridHelper;
  private readonly clock = new THREE.Clock();
  private readonly panel: HTMLElement;
  private readonly cache = new Map<string, MdlModel>();
  private readonly skins = new Map<string, THREE.Texture | null>();

  private model: AliasModel | null = null;
  private parsed: MdlModel | null = null;
  private ranges: { name: string; first: number; count: number; fps: number }[] = [];
  private elapsed = 0;
  private frameIndex = 0;
  private running = false;
  private yaw = Math.PI * 0.75;
  private pitch = 0.15;
  private distance = 110;
  /** Hauteur visée, prise sur le modèle : tous ne sont pas des créatures. */
  private target = 0;
  private readonly lampColour = new THREE.Color(0.55, 0.54, 0.5);
  private previousColorSpace: THREE.ColorSpace = THREE.LinearSRGBColorSpace;
  private dragging = false;
  private lastPointer: [number, number] = [0, 0];

  private readonly state: ViewerState = {
    path: '',
    subdivisions: 2,
    // Le maillage est montré d'emblée : c'est ce qu'on vient comparer d'un
    // niveau de subdivision à l'autre, et la peau seule ne le dit pas.
    wireframe: true,
    useDetailedSkin: true,
    playing: true,
    speed: 1,
    brightness: 1.5,
    sequence: null,
  };

  constructor(
    private readonly options: ModelViewerOptions,
    private readonly paths: string[],
  ) {
    this.scene.background = new THREE.Color(0x0d0d12);
    this.camera = new THREE.PerspectiveCamera(45, 1, 1, 4000);
    this.scene.add(this.pivot);

    // Un sol léger : sans lui, rien ne dit où le modèle pose les pieds.
    this.grid = new THREE.GridHelper(200, 20, 0x3a3a48, 0x23232c);
    this.scene.add(this.grid);

    this.panel = document.createElement('div');
    this.panel.className = 'viewer';
    this.options.container.append(this.panel);

    this.state.path = paths[0] ?? '';
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    // Le jeu convertit l'image au post-traitement ; ici on rend directement,
    // et sans cette correction tout paraît deux fois trop sombre.
    this.previousColorSpace = this.options.renderer.outputColorSpace;
    this.options.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.attachInput();
    this.load(this.state.path);
    this.draw();
    this.clock.start();
    this.options.renderer.setAnimationLoop(this.frame);
    this.resize();
    window.addEventListener('resize', this.resize);
  }

  dispose(): void {
    this.running = false;
    this.options.renderer.outputColorSpace = this.previousColorSpace;
    this.options.renderer.setAnimationLoop(null);
    window.removeEventListener('resize', this.resize);
    this.detachInput();
    this.clear();
    this.panel.remove();
    for (const texture of this.skins.values()) texture?.dispose();
    this.skins.clear();
  }

  // ------------------------------------------------------------ le modèle

  private clear(): void {
    if (!this.model) return;
    this.pivot.remove(this.model.mesh);
    this.model.dispose();
    this.model = null;
  }

  private read(path: string): MdlModel | null {
    const cached = this.cache.get(path);
    if (cached) return cached;
    const data = this.options.vfs.read(path);
    if (!data) return null;
    try {
      const parsed = parseMdl(data);
      this.cache.set(path, parsed);
      return parsed;
    } catch {
      return null;
    }
  }

  /** Peau refaite portant le nom du modèle, si elle existe. */
  private async skinFor(path: string): Promise<THREE.Texture | null> {
    if (this.skins.has(path)) return this.skins.get(path) ?? null;
    const name = path.replace('progs/', '').replace('.mdl', '.png');
    try {
      const texture = await new THREE.TextureLoader().loadAsync(`${SKIN_DIRECTORY}/${name}`);
      texture.flipY = false;
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.wrapS = THREE.ClampToEdgeWrapping;
      texture.wrapT = THREE.ClampToEdgeWrapping;
      texture.anisotropy = this.options.anisotropy;
      texture.needsUpdate = true;
      this.skins.set(path, texture);
      return texture;
    } catch {
      this.skins.set(path, null);
      return null;
    }
  }

  private load(path: string): void {
    this.clear();
    this.state.path = path;
    const source = this.read(path);
    this.parsed = source;
    if (!source) {
      this.draw();
      return;
    }

    const shown =
      this.state.subdivisions > 0 ? subdivideModel(source, this.state.subdivisions) : source;

    const detected = detectAnimations(source);
    this.ranges = [...detected.entries()].map(([kind, range]) => ({
      name: kind,
      first: range.first,
      count: range.count,
      fps: range.fps,
    }));
    // Au repos par défaut : parcourir toutes les images enchaîne les morts et
    // les douleurs, et l'on ne voit pas le modèle tel qu'il se tient.
    if (!this.ranges.some((r) => r.name === this.state.sequence)) {
      this.state.sequence = this.ranges.some((r) => r.name === 'idle') ? 'idle' : null;
    }

    void this.skinFor(path).then((skin) => {
      if (this.state.path !== path) return;
      this.clear();
      const model = new AliasModel(
        shown,
        this.options.palette,
        {
          anisotropy: this.options.anisotropy,
          // Éclairage neutre : on vient regarder le modèle, pas une ambiance.
          ambient: new THREE.Color(0.58, 0.57, 0.6),
          fogColor: new THREE.Color(0x0d0d12),
          fogDensity: 0,
          lightScale: 1.25,
          emissiveStrength: 1.4,
        },
        this.state.useDetailedSkin ? skin : null,
      );
      // Les positions sortent déjà dans le repère du rendu : le modèle est
      // debout, il n'y a rien à retourner.
      this.pivot.add(model.mesh);
      this.model = model;
      this.applyWireframe();
      this.applyBrightness();
      this.frameIndex = 0;
      this.elapsed = 0;

      // Cadrage : le modèle tient dans l'écran quelle que soit sa taille.
      const box = new THREE.Box3().setFromObject(model.mesh);
      const size = box.getSize(new THREE.Vector3());
      const centre = box.getCenter(new THREE.Vector3());
      this.target = centre.y;
      this.grid.position.y = box.min.y;
      this.distance = Math.max(24, Math.max(size.x, size.y, size.z) * 2.4);

      this.draw();
    });
  }

  /** L'éclairage se règle après coup : les peaux n'ont pas toutes la même. */
  private applyBrightness(): void {
    const material = this.model?.mesh.material as THREE.ShaderMaterial | undefined;
    if (!material) return;
    const level = this.state.brightness;
    (material.uniforms.uAmbient.value as THREE.Color).setRGB(
      0.38 * level,
      0.375 * level,
      0.4 * level,
    );
    material.uniforms.uLightScale.value = 0.85 * level;
  }

  private applyWireframe(): void {
    const material = this.model?.mesh.material as THREE.ShaderMaterial | undefined;
    if (material) material.wireframe = this.state.wireframe;
  }

  // ------------------------------------------------------------- le rendu

  private resize = () => {
    const width = window.innerWidth;
    const height = window.innerHeight;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.options.renderer.setSize(width, height);
  };

  private frame = () => {
    const delta = Math.min(this.clock.getDelta(), 0.1);

    if (this.model) {
      const sequence = this.ranges.find((r) => r.name === this.state.sequence);
      if (this.state.playing) {
        this.elapsed += delta * this.state.speed;
        if (sequence) {
          this.model.playRange(this.elapsed, sequence.first, sequence.count, sequence.fps, true);
          this.frameIndex = sequence.first + (Math.floor(this.elapsed * sequence.fps) % sequence.count);
        } else {
          this.model.animate(this.elapsed, 10);
          this.frameIndex = Math.floor(this.elapsed * 10) % this.model.frameCount;
        }
        this.refreshFrameLabel();
      } else {
        this.model.setFrames(this.frameIndex, this.frameIndex, 0);
      }
    }

    const radius = this.distance;
    const height = this.target;
    this.camera.position.set(
      Math.cos(this.yaw) * Math.cos(this.pitch) * radius,
      Math.sin(this.pitch) * radius + height,
      Math.sin(this.yaw) * Math.cos(this.pitch) * radius,
    );
    this.camera.lookAt(0, height, 0);

    // La lampe du shader suit la caméra : le modèle reste éclairé du côté
    // qu'on regarde, quelle que soit la rotation.
    this.model?.setFlashlight(this.camera.position, this.lampColour, radius * 2.4);

    this.options.renderer.render(this.scene, this.camera);
  };

  // ------------------------------------------------------------ la souris

  private attachInput(): void {
    const canvas = this.options.renderer.domElement;
    canvas.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    window.addEventListener('keydown', this.onKey);
  }

  private detachInput(): void {
    const canvas = this.options.renderer.domElement;
    canvas.removeEventListener('pointerdown', this.onPointerDown);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    canvas.removeEventListener('wheel', this.onWheel);
    window.removeEventListener('keydown', this.onKey);
  }

  private onPointerDown = (event: PointerEvent) => {
    this.dragging = true;
    this.lastPointer = [event.clientX, event.clientY];
  };

  private onPointerMove = (event: PointerEvent) => {
    if (!this.dragging) return;
    this.yaw -= (event.clientX - this.lastPointer[0]) * 0.008;
    this.pitch = Math.max(-1.3, Math.min(1.3, this.pitch + (event.clientY - this.lastPointer[1]) * 0.006));
    this.lastPointer = [event.clientX, event.clientY];
  };

  private onPointerUp = () => {
    this.dragging = false;
  };

  private onWheel = (event: WheelEvent) => {
    event.preventDefault();
    this.distance = Math.max(30, Math.min(400, this.distance + event.deltaY * 0.12));
  };

  private onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      this.options.onExit();
      return;
    }
    if (event.key === ' ') {
      event.preventDefault();
      this.state.playing = !this.state.playing;
      this.draw();
      return;
    }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      this.state.playing = false;
      const total = this.model?.frameCount ?? 1;
      const step = event.key === 'ArrowRight' ? 1 : -1;
      this.frameIndex = (this.frameIndex + step + total) % total;
      this.draw();
    }
  };

  // ------------------------------------------------------------ le panneau

  private refreshFrameLabel(): void {
    const label = this.panel.querySelector('[data-frame]');
    if (!label || !this.parsed) return;
    const name = this.parsed.frames[Math.min(this.frameIndex, this.parsed.frames.length - 1)]?.name ?? '';
    label.textContent = `image ${this.frameIndex} · ${name}`;
  }

  private draw(): void {
    const shortName = (path: string) => path.replace('progs/', '').replace('.mdl', '');
    const parsed = this.parsed;
    const shownFaces = this.model ? this.model.frameCount : 0;

    let details = 'modèle illisible';
    if (parsed) {
      const roles = identifyParts(parsed);
      const pieces = new Set(modelParts(parsed)).size;
      const factor = 4 ** this.state.subdivisions;
      details = [
        `${parsed.vertexCount} sommets, ${parsed.triangles.length} faces`,
        `affiché : ${parsed.triangles.length * factor} faces`,
        `${shownFaces} images · peau ${parsed.skinWidth}×${parsed.skinHeight}`,
        `${pieces} pièce(s)${roles.weapon >= 0 ? ', arme détectée' : ''}`,
      ].join('<br />');
    }

    const skin = this.skins.get(this.state.path);
    const hasSkin = Boolean(skin);

    this.panel.innerHTML = `
      <div class="viewer-side">
        <h2>Modèles — ${this.paths.length}</h2>
        <div class="viewer-list">
          ${this.paths
            .map(
              (path) =>
                `<button data-path="${path}" class="viewer-item${path === this.state.path ? ' on' : ''}">${shortName(path)}</button>`,
            )
            .join('')}
        </div>
      </div>
      <div class="viewer-controls">
        <button class="viewer-back" data-exit>← Retour</button>
        <h2>${shortName(this.state.path)}</h2>
        <p class="viewer-details">${details}</p>

        <label class="viewer-row"><span>Séquence</span>
          <select data-sequence>
            <option value="">toutes les images</option>
            ${this.ranges
              .map(
                (r) =>
                  `<option value="${r.name}"${r.name === this.state.sequence ? ' selected' : ''}>${r.name} (${r.count})</option>`,
              )
              .join('')}
          </select>
        </label>

        <label class="viewer-row"><span>Subdivision</span>
          <select data-subdivisions>
            ${[0, 1, 2, 3]
              .map(
                (n) =>
                  `<option value="${n}"${n === this.state.subdivisions ? ' selected' : ''}>${n === 0 ? 'aucune' : `×${n}`}</option>`,
              )
              .join('')}
          </select>
        </label>

        <label class="viewer-row"><span>Vitesse</span>
          <input type="range" min="0" max="2" step="0.1" value="${this.state.speed}" data-speed />
        </label>

        <label class="viewer-row"><span>Éclairage</span>
          <input type="range" min="0.4" max="3" step="0.1" value="${this.state.brightness}" data-brightness />
        </label>

        <label class="viewer-row"><span>Fil de fer</span>
          <input type="checkbox" data-wireframe${this.state.wireframe ? ' checked' : ''} />
        </label>

        <label class="viewer-row"><span>Peau refaite</span>
          <input type="checkbox" data-skin${this.state.useDetailedSkin ? ' checked' : ''}${hasSkin ? '' : ' disabled'} />
        </label>
        ${hasSkin ? '' : '<p class="viewer-note">aucune peau refaite pour ce modèle</p>'}

        <p class="viewer-frame" data-frame>image ${this.frameIndex}</p>
        <p class="viewer-note">
          Glisser pour tourner, molette pour approcher.<br />
          Espace met en pause, les flèches avancent image par image.<br />
          Échap revient au menu.
        </p>
      </div>
    `;

    this.panel.querySelector('[data-exit]')?.addEventListener('click', () => this.options.onExit());
    for (const button of this.panel.querySelectorAll<HTMLButtonElement>('[data-path]')) {
      button.addEventListener('click', () => this.load(button.dataset.path ?? ''));
    }
    this.panel.querySelector<HTMLSelectElement>('[data-sequence]')?.addEventListener('change', (event) => {
      this.state.sequence = (event.target as HTMLSelectElement).value || null;
      this.elapsed = 0;
      this.state.playing = true;
    });
    this.panel.querySelector<HTMLSelectElement>('[data-subdivisions]')?.addEventListener('change', (event) => {
      this.state.subdivisions = Number((event.target as HTMLSelectElement).value);
      this.load(this.state.path);
    });
    this.panel.querySelector<HTMLInputElement>('[data-speed]')?.addEventListener('input', (event) => {
      this.state.speed = Number((event.target as HTMLInputElement).value);
    });
    this.panel.querySelector<HTMLInputElement>('[data-brightness]')?.addEventListener('input', (event) => {
      this.state.brightness = Number((event.target as HTMLInputElement).value);
      this.applyBrightness();
    });
    this.panel.querySelector<HTMLInputElement>('[data-wireframe]')?.addEventListener('change', (event) => {
      this.state.wireframe = (event.target as HTMLInputElement).checked;
      this.applyWireframe();
    });
    this.panel.querySelector<HTMLInputElement>('[data-skin]')?.addEventListener('change', (event) => {
      this.state.useDetailedSkin = (event.target as HTMLInputElement).checked;
      this.load(this.state.path);
    });
  }
}

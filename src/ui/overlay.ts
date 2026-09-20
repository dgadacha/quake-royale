import type { MapEntry } from '../game/mapCatalog';
import { groupCatalog } from '../game/mapCatalog';

export interface MenuHandlers {
  onDemo(): void;
  onMap(path: string): void;
  onFiles(files: FileList): void;
  onGraphics(): void;
  onModels(): void;
}

export interface GraphicsRow {
  key: string;
  label: string;
  hint?: string;
  kind: 'toggle' | 'range' | 'choice';
  value: boolean | number | string;
  min?: number;
  max?: number;
  step?: number;
  choices?: { value: string; label: string }[];
}

const LAST_MAP_KEY = 'quake-hd.lastMap';

function readLastMap(): string | null {
  try {
    return localStorage.getItem(LAST_MAP_KEY);
  } catch {
    return null;
  }
}

function writeLastMap(path: string): void {
  try {
    localStorage.setItem(LAST_MAP_KEY, path);
  } catch {
    // Sans stockage, la carte ne sera simplement pas retenue.
  }
}

/** Écrans d'accueil, de chargement, de réglages, et affichage en jeu. */
export class Overlay {
  private readonly root: HTMLElement;
  private readonly hud: HTMLElement;
  private readonly stats: HTMLElement;
  private readonly hint: HTMLElement;
  private screen: HTMLElement | null = null;
  private progressBar: HTMLElement | null = null;
  private progressStep: HTMLElement | null = null;
  private progressValue: HTMLElement | null = null;
  private status: HTMLElement | null = null;

  constructor(container: HTMLElement) {
    this.root = container;

    this.hud = document.createElement('div');
    this.hud.id = 'hud';
    this.hud.innerHTML = `
      <div class="crosshair"></div>
      <div class="stats"></div>
      <div class="hint-center"></div>
    `;
    this.root.append(this.hud);
    this.stats = this.hud.querySelector('.stats') as HTMLElement;
    this.hint = this.hud.querySelector('.hint-center') as HTMLElement;
  }

  private newScreen(): HTMLElement {
    this.screen?.remove();
    const screen = document.createElement('div');
    screen.className = 'screen';
    this.screen = screen;
    this.root.append(screen);
    return screen;
  }

  showMenu(catalog: MapEntry[], handlers: MenuHandlers, note?: string): void {
    const screen = this.newScreen();
    const panel = document.createElement('div');
    panel.className = 'panel';
    panel.innerHTML = `
      <h1 class="title">Quake HD</h1>
      <p class="tagline">
        Moteur de rendu haute définition écrit en TypeScript et Three.js.
        Les cartes, textures, modèles et sons proviennent de votre propre copie
        du jeu : rien n'est fourni ici.
      </p>
      <div class="rule"></div>
    `;
    screen.append(panel);

    const section = (label: string) => {
      const heading = document.createElement('h2');
      heading.textContent = label;
      panel.append(heading);
    };

    if (catalog.length > 0) {
      section(`Niveaux — ${catalog.length}`);

      const search = document.createElement('input');
      search.type = 'search';
      search.className = 'map-filter';
      search.placeholder = 'Filtrer par nom ou par code';
      const list = document.createElement('div');

      let filter = '';
      const last = readLastMap();

      const draw = () => {
        list.innerHTML = '';
        const kept = catalog.filter((entry) => {
          if (!filter) return true;
          const haystack = `${entry.code} ${entry.title ?? ''}`.toLowerCase();
          return haystack.includes(filter);
        });

        for (const group of groupCatalog(kept)) {
          const block = document.createElement('div');
          block.className = 'episode';

          const name = document.createElement('div');
          name.className = 'episode-name';
          name.textContent = group.episode;
          block.append(name);

          const grid = document.createElement('div');
          grid.className = 'level-grid';
          for (const entry of group.maps) {
            const button = document.createElement('button');
            button.className = 'level';
            if (entry.path === last) button.dataset.last = 'true';
            // Le nom vient de la carte ; à défaut, son code fait office de nom.
            button.innerHTML =
              `<span class="code">${entry.code}</span>` +
              `<span class="name">${entry.title ?? '—'}</span>`;
            button.addEventListener('click', () => {
              writeLastMap(entry.path);
              handlers.onMap(entry.path);
            });
            grid.append(button);
          }
          block.append(grid);
          list.append(block);
        }

        if (kept.length === 0) {
          const empty = document.createElement('div');
          empty.className = 'status';
          empty.textContent = 'Aucun niveau ne correspond.';
          list.append(empty);
        }
      };

      search.addEventListener('input', () => {
        filter = search.value.trim().toLowerCase();
        draw();
      });

      if (catalog.length > 14) panel.append(search);
      panel.append(list);
      draw();
    }

    section('Sans données');
    const demo = document.createElement('button');
    demo.className = 'primary';
    demo.innerHTML =
      'Arène de démonstration<span class="hint">Niveau produit par le code : éclairage cuit, eau, escaliers</span>';
    demo.addEventListener('click', handlers.onDemo);
    panel.append(demo);

    section('Vos données');
    const drop = document.createElement('div');
    drop.className = 'drop';
    drop.innerHTML =
      'Déposez ici une archive <b>.pak</b> ou une carte <b>.bsp</b><br />ou cliquez pour parcourir';
    panel.append(drop);

    const picker = document.createElement('input');
    picker.type = 'file';
    picker.accept = '.pak,.bsp,.lmp,.wad';
    picker.multiple = true;
    picker.style.display = 'none';
    panel.append(picker);

    drop.addEventListener('click', () => picker.click());
    picker.addEventListener('change', () => {
      if (picker.files?.length) handlers.onFiles(picker.files);
    });

    const stop = (event: DragEvent) => {
      event.preventDefault();
      event.stopPropagation();
    };
    drop.addEventListener('dragover', (event) => {
      stop(event);
      drop.classList.add('hot');
    });
    drop.addEventListener('dragleave', (event) => {
      stop(event);
      drop.classList.remove('hot');
    });
    drop.addEventListener('drop', (event) => {
      stop(event);
      drop.classList.remove('hot');
      if (event.dataTransfer?.files.length) handlers.onFiles(event.dataTransfer.files);
    });

    section('Outils');
    const models = document.createElement('button');
    models.innerHTML =
      'Visualisateur de modèles<span class="hint">Voir un modèle seul, ses séquences, sa peau et sa subdivision</span>';
    models.addEventListener('click', handlers.onModels);
    panel.append(models);

    section('Image');
    const graphics = document.createElement('button');
    graphics.innerHTML =
      'Paramètres graphiques<span class="hint">Qualité, occlusion, réflexions, ombres, halo, sources dynamiques</span>';
    graphics.addEventListener('click', handlers.onGraphics);
    panel.append(graphics);

    const statusLine = document.createElement('div');
    statusLine.className = 'status';
    statusLine.textContent = note ?? '';
    panel.append(statusLine);
    this.status = statusLine;

    const keys = document.createElement('div');
    keys.className = 'keys';
    keys.innerHTML =
      '<kbd>Z Q S D</kbd> se déplacer · <kbd>Maj</kbd> courir · <kbd>Espace</kbd> sauter · ' +
      '<kbd>Clic</kbd> tirer · <kbd>F3</kbd> compteurs · <kbd>Échap</kbd> menu';
    panel.append(keys);
  }

  /** Écran de chargement, avec le nom du niveau et l'étape en cours. */
  showLoading(title: string, code: string): void {
    const screen = this.newScreen();
    const panel = document.createElement('div');
    panel.className = 'panel loading';
    panel.innerHTML = `
      <h2 class="level-title">${title}</h2>
      <div class="level-code">${code}</div>
      <div class="progress"><div></div></div>
      <div class="step"><span class="label">Préparation</span><span class="value">0 %</span></div>
    `;
    screen.append(panel);
    this.progressBar = panel.querySelector('.progress > div');
    this.progressStep = panel.querySelector('.step .label');
    this.progressValue = panel.querySelector('.step .value');
    this.status = null;
  }

  setProgress(value: number, step?: string): void {
    const clamped = Math.max(0, Math.min(1, value));
    if (this.progressBar) this.progressBar.style.width = `${Math.round(clamped * 100)}%`;
    if (this.progressValue) this.progressValue.textContent = `${Math.round(clamped * 100)} %`;
    if (step && this.progressStep) this.progressStep.textContent = step;
  }

  setStatus(text: string, isError = false): void {
    if (!this.status) return;
    this.status.textContent = text;
    this.status.classList.toggle('error', isError);
  }

  showGraphics(
    rows: GraphicsRow[],
    onChange: (key: string, value: boolean | number | string) => void,
    onBack: () => void,
  ): void {
    const screen = this.newScreen();
    const panel = document.createElement('div');
    panel.className = 'panel';
    panel.innerHTML = `
      <h1 class="title" style="font-size:clamp(22px,3.4vw,34px)">Image</h1>
      <p class="tagline">
        Les réglages s'appliquent immédiatement et sont conservés pour les
        prochaines sessions.
      </p>
      <div class="rule"></div>
    `;

    for (const row of rows) {
      const line = document.createElement('div');
      line.className = 'setting';

      const label = document.createElement('div');
      label.className = 'label';
      label.innerHTML = `${row.label}${row.hint ? `<span>${row.hint}</span>` : ''}`;
      line.append(label);

      const control = document.createElement('div');
      control.className = 'control';

      if (row.kind === 'choice') {
        for (const choice of row.choices ?? []) {
          const button = document.createElement('button');
          button.className = 'toggle';
          button.textContent = choice.label;
          button.dataset.on = String(row.value === choice.value);
          button.addEventListener('click', () => {
            for (const sibling of control.querySelectorAll('button')) {
              sibling.dataset.on = 'false';
            }
            button.dataset.on = 'true';
            onChange(row.key, choice.value);
          });
          control.append(button);
        }
      } else if (row.kind === 'toggle') {
        const button = document.createElement('button');
        button.className = 'toggle';
        const paint = (on: boolean) => {
          button.textContent = on ? 'Activé' : 'Désactivé';
          button.dataset.on = String(on);
        };
        paint(row.value as boolean);
        button.addEventListener('click', () => {
          const next = button.dataset.on !== 'true';
          paint(next);
          onChange(row.key, next);
        });
        control.append(button);
      } else {
        const slider = document.createElement('input');
        slider.type = 'range';
        slider.min = String(row.min ?? 0);
        slider.max = String(row.max ?? 1);
        slider.step = String(row.step ?? 0.05);
        slider.value = String(row.value);

        const amount = document.createElement('div');
        amount.className = 'amount';
        amount.textContent = String(row.value);

        slider.addEventListener('input', () => {
          const value = Number.parseFloat(slider.value);
          amount.textContent = value.toFixed(value < 10 ? 2 : 0);
          onChange(row.key, value);
        });
        control.append(slider, amount);
      }

      line.append(control);
      panel.append(line);
    }

    const back = document.createElement('button');
    back.textContent = 'Retour';
    back.style.marginTop = '22px';
    back.addEventListener('click', onBack);
    panel.append(back);
    screen.append(panel);
  }

  showError(message: string, onBack: () => void): void {
    const screen = this.newScreen();
    const panel = document.createElement('div');
    panel.className = 'panel';
    panel.innerHTML = `
      <h1 class="title" style="font-size:clamp(22px,3.4vw,34px)">Échec</h1>
      <p class="tagline error">${message}</p>
      <div class="rule"></div>
    `;
    const button = document.createElement('button');
    button.textContent = 'Retour';
    button.addEventListener('click', onBack);
    panel.append(button);
    screen.append(panel);
  }

  hide(): void {
    this.screen?.remove();
    this.screen = null;
    this.progressBar = null;
    this.progressStep = null;
    this.progressValue = null;
    this.status = null;
  }

  setHudVisible(visible: boolean): void {
    this.hud.classList.toggle('visible', visible);
  }

  setHint(html: string): void {
    this.hint.innerHTML = html;
  }

  setStats(html: string): void {
    this.stats.innerHTML = html;
  }
}

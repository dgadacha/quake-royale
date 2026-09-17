export interface MenuHandlers {
  onDemo(): void;
  onMap(path: string): void;
  onFiles(files: FileList): void;
  onGraphics(): void;
}

export interface GraphicsRow {
  key: string;
  label: string;
  hint?: string;
  kind: 'toggle' | 'range';
  value: boolean | number;
  min?: number;
  max?: number;
  step?: number;
}

/** Écrans d'accueil, de chargement et affichage de jeu. */
export class Overlay {
  private readonly root: HTMLElement;
  private readonly hud: HTMLElement;
  private readonly stats: HTMLElement;
  private readonly hint: HTMLElement;
  private screen: HTMLElement | null = null;
  private progressBar: HTMLElement | null = null;
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

  showMenu(maps: string[], handlers: MenuHandlers, note?: string): void {
    const screen = this.newScreen();
    const panel = document.createElement('div');
    panel.className = 'panel';
    panel.innerHTML = `
      <h1>Quake HD</h1>
      <p class="subtitle">
        Moteur de rendu haute définition écrit en TypeScript et Three.js.
        Les cartes, textures et sons ne sont pas fournis : montez vos propres
        fichiers de données pour jouer vos niveaux.
      </p>
      <h2>Sans données</h2>
      <button class="primary" data-action="demo">
        Arène de démonstration
        <span class="hint">Niveau généré par le code, éclairage cuit, eau et escaliers</span>
      </button>
      <h2>Image</h2>
      <button data-action="graphics">
        Paramètres graphiques
        <span class="hint">Occlusion ambiante, réflexions, halo lumineux, grain</span>
      </button>
      <h2>Vos données</h2>
      <div class="drop" data-action="drop">
        Déposez ici un fichier <b>.pak</b> ou une carte <b>.bsp</b><br />
        ou cliquez pour parcourir
      </div>
      <div class="maps"></div>
      <div class="status">${note ?? ''}</div>
      <div class="keys">
        <kbd>ZQSD</kbd> / <kbd>WASD</kbd> déplacement · <kbd>Maj</kbd> courir ·
        <kbd>Espace</kbd> sauter · <kbd>Échap</kbd> menu
      </div>
    `;
    screen.append(panel);
    this.status = panel.querySelector('.status');

    panel.querySelector('[data-action="demo"]')?.addEventListener('click', handlers.onDemo);
    panel.querySelector('[data-action="graphics"]')?.addEventListener('click', handlers.onGraphics);

    const drop = panel.querySelector('[data-action="drop"]') as HTMLElement;
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

    const mapList = panel.querySelector('.maps') as HTMLElement;
    this.renderMaps(mapList, maps, handlers.onMap);
  }

  private renderMaps(container: HTMLElement, maps: string[], onMap: (path: string) => void): void {
    container.innerHTML = '';
    if (maps.length === 0) return;
    const heading = document.createElement('h2');
    heading.textContent = `Cartes détectées (${maps.length})`;
    container.before(heading);
    for (const map of maps) {
      const button = document.createElement('button');
      button.textContent = map.replace(/^maps\//, '').replace(/\.bsp$/, '');
      button.addEventListener('click', () => onMap(map));
      container.append(button);
    }
  }

  /** Panneau de réglages d'image, appliqués immédiatement. */
  showGraphics(
    rows: GraphicsRow[],
    onChange: (key: string, value: boolean | number) => void,
    onBack: () => void,
  ): void {
    const screen = this.newScreen();
    const panel = document.createElement('div');
    panel.className = 'panel';
    panel.innerHTML = `
      <h1>Image</h1>
      <p class="subtitle">
        Les réglages s'appliquent tout de suite et sont conservés pour les
        prochaines sessions.
      </p>
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

      if (row.kind === 'toggle') {
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
    back.style.marginTop = '20px';
    back.addEventListener('click', onBack);
    panel.append(back);
    screen.append(panel);
  }

  showLoading(label: string): void {
    const screen = this.newScreen();
    const panel = document.createElement('div');
    panel.className = 'panel';
    panel.innerHTML = `
      <h1>Chargement</h1>
      <p class="subtitle">${label}</p>
      <div class="progress"><div></div></div>
      <div class="status"></div>
    `;
    screen.append(panel);
    this.progressBar = panel.querySelector('.progress > div');
    this.status = panel.querySelector('.status');
  }

  setProgress(value: number, label?: string): void {
    if (this.progressBar) this.progressBar.style.width = `${Math.round(value * 100)}%`;
    if (label && this.status) this.status.textContent = label;
  }

  setStatus(text: string, isError = false): void {
    if (!this.status) return;
    this.status.textContent = text;
    this.status.classList.toggle('error', isError);
  }

  showError(message: string, onBack: () => void): void {
    const screen = this.newScreen();
    const panel = document.createElement('div');
    panel.className = 'panel';
    panel.innerHTML = `
      <h1>Erreur</h1>
      <p class="subtitle error">${message}</p>
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

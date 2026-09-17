export interface InputSnapshot {
  forward: number;
  side: number;
  up: number;
  jump: boolean;
  run: boolean;
  mouseDeltaX: number;
  mouseDeltaY: number;
  attack: boolean;
}

const KEY_BINDINGS: Record<string, keyof typeof ACTIONS> = {
  KeyW: 'forward',
  ArrowUp: 'forward',
  KeyS: 'back',
  ArrowDown: 'back',
  KeyA: 'left',
  KeyD: 'right',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  Space: 'jump',
  ShiftLeft: 'run',
  ShiftRight: 'run',
  ControlLeft: 'down',
  KeyC: 'down',
};

const ACTIONS = {
  forward: false,
  back: false,
  left: false,
  right: false,
  jump: false,
  run: false,
  down: false,
};

export class InputManager {
  private readonly pressed = new Set<string>();
  private deltaX = 0;
  private deltaY = 0;
  private attack = false;
  sensitivity = 0.0022;
  invertY = false;
  locked = false;

  constructor(private readonly canvas: HTMLElement) {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
    document.addEventListener('mousemove', this.onMouseMove);
    canvas.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mouseup', this.onMouseUp);
  }

  requestLock(): void {
    void this.canvas.requestPointerLock();
  }

  private onPointerLockChange = () => {
    this.locked = document.pointerLockElement === this.canvas;
    if (!this.locked) this.pressed.clear();
  };

  private onKeyDown = (event: KeyboardEvent) => {
    if (KEY_BINDINGS[event.code]) event.preventDefault();
    this.pressed.add(event.code);
  };

  private onKeyUp = (event: KeyboardEvent) => {
    this.pressed.delete(event.code);
  };

  private onBlur = () => {
    this.pressed.clear();
  };

  private onMouseMove = (event: MouseEvent) => {
    if (!this.locked) return;
    this.deltaX += event.movementX;
    this.deltaY += event.movementY;
  };

  private onMouseDown = (event: MouseEvent) => {
    if (event.button === 0) this.attack = true;
  };

  private onMouseUp = (event: MouseEvent) => {
    if (event.button === 0) this.attack = false;
  };

  isDown(code: string): boolean {
    return this.pressed.has(code);
  }

  /** Consomme l'état courant : les déplacements souris sont remis à zéro. */
  sample(): InputSnapshot {
    const held = (action: keyof typeof ACTIONS) =>
      Object.entries(KEY_BINDINGS).some(([code, name]) => name === action && this.pressed.has(code));

    const snapshot: InputSnapshot = {
      forward: (held('forward') ? 1 : 0) - (held('back') ? 1 : 0),
      side: (held('right') ? 1 : 0) - (held('left') ? 1 : 0),
      up: (held('jump') ? 1 : 0) - (held('down') ? 1 : 0),
      jump: held('jump'),
      run: held('run'),
      mouseDeltaX: this.deltaX * this.sensitivity,
      mouseDeltaY: this.deltaY * this.sensitivity * (this.invertY ? -1 : 1),
      attack: this.attack,
    };
    this.deltaX = 0;
    this.deltaY = 0;
    return snapshot;
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    document.removeEventListener('pointerlockchange', this.onPointerLockChange);
    document.removeEventListener('mousemove', this.onMouseMove);
    this.canvas.removeEventListener('mousedown', this.onMouseDown);
    window.removeEventListener('mouseup', this.onMouseUp);
  }
}

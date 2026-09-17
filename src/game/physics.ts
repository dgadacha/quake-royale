import { Contents } from '../formats/bsp';
import { PLAYER_MAXS, PLAYER_MINS, type CollisionWorld, type Vec3 } from './collision';

/** Réglages du mouvement, repris des valeurs du jeu d'origine. */
export const MoveConfig = {
  gravity: 800,
  friction: 4,
  stopSpeed: 100,
  accelerate: 10,
  airAccelerate: 10,
  maxSpeed: 320,
  /** Au-delà, l'accélération en l'air est plafonnée : c'est ce qui rend le strafe possible. */
  maxAirSpeed: 30,
  stepSize: 18,
  jumpSpeed: 270,
  waterFriction: 4,
  waterAccelerate: 10,
  waterMaxSpeed: 224,
  waterSinkSpeed: 60,
  maxVelocity: 2000,
  /** Pas de simulation fixe : la physique ne doit pas dépendre du framerate. */
  tickRate: 1 / 72,
};

export interface MoveState {
  origin: Vec3;
  velocity: Vec3;
  onGround: boolean;
  groundNormal: Vec3;
  waterLevel: number;
  waterType: number;
  jumpHeld: boolean;
}

export interface MoveInput {
  forward: number;
  side: number;
  up: number;
  jump: boolean;
  yaw: number;
  pitch: number;
}

export function createMoveState(origin: Vec3): MoveState {
  return {
    origin: [...origin] as Vec3,
    velocity: [0, 0, 0],
    onGround: false,
    groundNormal: [0, 0, 1],
    waterLevel: 0,
    waterType: Contents.EMPTY,
    jumpHeld: false,
  };
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const length = (v: Vec3) => Math.hypot(v[0], v[1], v[2]);

/** Retire la composante du mouvement qui entre dans le plan touché. */
function clipVelocity(velocity: Vec3, normal: Vec3, overbounce: number): Vec3 {
  const backoff = dot(velocity, normal) * overbounce;
  const out: Vec3 = [
    velocity[0] - normal[0] * backoff,
    velocity[1] - normal[1] * backoff,
    velocity[2] - normal[2] * backoff,
  ];
  for (let i = 0; i < 3; i++) {
    if (out[i] > -0.1 && out[i] < 0.1) out[i] = 0;
  }
  return out;
}

export class PlayerPhysics {
  private accumulator = 0;

  constructor(private readonly collision: CollisionWorld) {}

  /** Avance la simulation d'un temps réel quelconque par pas fixes. */
  step(state: MoveState, input: MoveInput, deltaTime: number): void {
    this.accumulator += Math.min(deltaTime, 0.25);
    while (this.accumulator >= MoveConfig.tickRate) {
      this.tick(state, input, MoveConfig.tickRate);
      this.accumulator -= MoveConfig.tickRate;
    }
  }

  private tick(state: MoveState, input: MoveInput, dt: number): void {
    this.categorize(state);

    const [forwardDir, rightDir] = directions(input.yaw, input.pitch);
    const wish: Vec3 = [
      forwardDir[0] * input.forward + rightDir[0] * input.side,
      forwardDir[1] * input.forward + rightDir[1] * input.side,
      0,
    ];

    if (state.waterLevel >= 2) {
      // En nage, la vue commande aussi la montée et la descente.
      wish[0] = forwardDir[0] * input.forward + rightDir[0] * input.side;
      wish[1] = forwardDir[1] * input.forward + rightDir[1] * input.side;
      wish[2] = forwardDir[2] * input.forward + input.up;
      this.waterMove(state, wish, dt);
      this.slideMove(state, dt);
      return;
    }

    if (state.onGround) {
      this.friction(state, dt);
      this.accelerate(state, wish, MoveConfig.maxSpeed, MoveConfig.accelerate, dt);

      if (input.jump && !state.jumpHeld) {
        state.velocity[2] = MoveConfig.jumpSpeed;
        state.onGround = false;
      }
    } else {
      this.airAccelerate(state, wish, dt);
    }
    state.jumpHeld = input.jump;

    state.velocity[2] -= MoveConfig.gravity * dt;

    const speed = length(state.velocity);
    if (speed > MoveConfig.maxVelocity) {
      const scale = MoveConfig.maxVelocity / speed;
      state.velocity[0] *= scale;
      state.velocity[1] *= scale;
      state.velocity[2] *= scale;
    }

    this.moveWithSteps(state, dt);
  }

  private friction(state: MoveState, dt: number): void {
    const speed = Math.hypot(state.velocity[0], state.velocity[1]);
    if (speed < 0.1) {
      state.velocity[0] = 0;
      state.velocity[1] = 0;
      return;
    }
    const control = speed < MoveConfig.stopSpeed ? MoveConfig.stopSpeed : speed;
    const drop = control * MoveConfig.friction * dt;
    const scale = Math.max(0, speed - drop) / speed;
    state.velocity[0] *= scale;
    state.velocity[1] *= scale;
  }

  private accelerate(
    state: MoveState,
    wish: Vec3,
    maxSpeed: number,
    rate: number,
    dt: number,
  ): void {
    const wishSpeed = Math.min(length(wish), maxSpeed);
    if (wishSpeed <= 0) return;
    const dir: Vec3 = [wish[0] / length(wish), wish[1] / length(wish), wish[2] / length(wish)];

    const current = dot(state.velocity, dir);
    const add = wishSpeed - current;
    if (add <= 0) return;
    const accel = Math.min(rate * dt * wishSpeed, add);
    state.velocity[0] += dir[0] * accel;
    state.velocity[1] += dir[1] * accel;
    state.velocity[2] += dir[2] * accel;
  }

  /**
   * En l'air, la vitesse visée est bridée mais pas la vitesse réelle :
   * en tournant la souris pendant un déplacement latéral on continue de gagner
   * de la vitesse, exactement comme dans le jeu d'origine.
   */
  private airAccelerate(state: MoveState, wish: Vec3, dt: number): void {
    const wishLength = Math.hypot(wish[0], wish[1]);
    if (wishLength <= 0) return;
    const dir: Vec3 = [wish[0] / wishLength, wish[1] / wishLength, 0];
    const wishSpeed = Math.min(wishLength, MoveConfig.maxSpeed);
    const capped = Math.min(wishSpeed, MoveConfig.maxAirSpeed);

    const current = dot(state.velocity, dir);
    const add = capped - current;
    if (add <= 0) return;
    const accel = Math.min(MoveConfig.airAccelerate * wishSpeed * dt, add);
    state.velocity[0] += dir[0] * accel;
    state.velocity[1] += dir[1] * accel;
  }

  private waterMove(state: MoveState, wish: Vec3, dt: number): void {
    const speed = length(state.velocity);
    if (speed > 0) {
      const drop = speed * MoveConfig.waterFriction * dt;
      const scale = Math.max(0, speed - drop) / speed;
      state.velocity[0] *= scale;
      state.velocity[1] *= scale;
      state.velocity[2] *= scale;
    }

    if (length(wish) < 0.05) {
      // Sans commande, on coule lentement.
      state.velocity[2] -= MoveConfig.waterSinkSpeed * dt;
      return;
    }
    this.accelerate(state, wish, MoveConfig.waterMaxSpeed, MoveConfig.waterAccelerate, dt);
  }

  /** Déplacement au sol avec franchissement automatique des marches. */
  private moveWithSteps(state: MoveState, dt: number): void {
    const startOrigin: Vec3 = [...state.origin] as Vec3;
    const startVelocity: Vec3 = [...state.velocity] as Vec3;

    const blocked = this.slideMove(state, dt);
    const downOrigin: Vec3 = [...state.origin] as Vec3;
    const downVelocity: Vec3 = [...state.velocity] as Vec3;

    if (!blocked) return;

    // Deuxième tentative en montant d'une marche.
    state.origin = [...startOrigin] as Vec3;
    state.velocity = [...startVelocity] as Vec3;

    const up: Vec3 = [state.origin[0], state.origin[1], state.origin[2] + MoveConfig.stepSize];
    const upTrace = this.collision.trace(state.origin, up);
    if (upTrace.startSolid) {
      state.origin = downOrigin;
      state.velocity = downVelocity;
      return;
    }
    state.origin = upTrace.endPos;

    this.slideMove(state, dt);

    // Puis on redescend sur le sol.
    const down: Vec3 = [
      state.origin[0],
      state.origin[1],
      state.origin[2] - MoveConfig.stepSize * 2,
    ];
    const downTrace = this.collision.trace(state.origin, down);
    if (downTrace.fraction < 1 && downTrace.planeNormal[2] < 0.7) {
      // Le sol atteint est trop pentu : on garde le résultat sans marche.
      state.origin = downOrigin;
      state.velocity = downVelocity;
      return;
    }
    state.origin = downTrace.endPos;

    const stepDistance = Math.hypot(
      state.origin[0] - startOrigin[0],
      state.origin[1] - startOrigin[1],
    );
    const flatDistance = Math.hypot(
      downOrigin[0] - startOrigin[0],
      downOrigin[1] - startOrigin[1],
    );
    if (flatDistance > stepDistance) {
      state.origin = downOrigin;
      state.velocity = downVelocity;
    }
  }

  /** Glissement le long des surfaces, jusqu'à quatre contacts par pas. */
  private slideMove(state: MoveState, dt: number): boolean {
    let timeLeft = dt;
    const planes: Vec3[] = [];
    let blocked = false;
    const primalVelocity: Vec3 = [...state.velocity] as Vec3;

    for (let bump = 0; bump < 4; bump++) {
      if (length(state.velocity) === 0) break;

      const end: Vec3 = [
        state.origin[0] + state.velocity[0] * timeLeft,
        state.origin[1] + state.velocity[1] * timeLeft,
        state.origin[2] + state.velocity[2] * timeLeft,
      ];
      const trace = this.collision.trace(state.origin, end);

      if (trace.allSolid) {
        state.velocity = [0, 0, 0];
        return true;
      }

      if (trace.fraction > 0) {
        state.origin = trace.endPos;
        planes.length = 0;
      }
      if (trace.fraction === 1) break;

      blocked = true;
      timeLeft -= timeLeft * trace.fraction;
      planes.push(trace.planeNormal);

      if (planes.length >= 5) {
        state.velocity = [0, 0, 0];
        break;
      }

      let resolved = false;
      for (const plane of planes) {
        const clipped = clipVelocity(state.velocity, plane, 1.01);
        let ok = true;
        for (const other of planes) {
          if (other === plane) continue;
          if (dot(clipped, other) < 0) {
            ok = false;
            break;
          }
        }
        if (ok) {
          state.velocity = clipped;
          resolved = true;
          break;
        }
      }

      if (!resolved) {
        if (planes.length !== 2) {
          state.velocity = [0, 0, 0];
          break;
        }
        // Coin rentrant : on glisse le long de l'arête commune.
        const [a, b] = planes;
        const dir: Vec3 = [
          a[1] * b[2] - a[2] * b[1],
          a[2] * b[0] - a[0] * b[2],
          a[0] * b[1] - a[1] * b[0],
        ];
        const d = dot(dir, state.velocity);
        state.velocity = [dir[0] * d, dir[1] * d, dir[2] * d];
      }

      if (dot(state.velocity, primalVelocity) <= 0) {
        state.velocity = [0, 0, 0];
        break;
      }
    }

    return blocked;
  }

  /** Met à jour le contact au sol et le niveau d'immersion. */
  private categorize(state: MoveState): void {
    const point: Vec3 = [state.origin[0], state.origin[1], state.origin[2] - 1];
    if (state.velocity[2] > 180) {
      state.onGround = false;
    } else {
      const trace = this.collision.trace(state.origin, point);
      state.onGround = trace.fraction < 1 && trace.planeNormal[2] >= 0.7;
      if (state.onGround) {
        state.groundNormal = trace.planeNormal;
        state.origin = trace.endPos;
        if (state.velocity[2] < 0) state.velocity[2] = 0;
      }
    }

    const feet: Vec3 = [
      state.origin[0],
      state.origin[1],
      state.origin[2] + PLAYER_MINS[2] + 1,
    ];
    const waist: Vec3 = [state.origin[0], state.origin[1], state.origin[2]];
    const eyes: Vec3 = [
      state.origin[0],
      state.origin[1],
      state.origin[2] + PLAYER_MAXS[2] * 0.7,
    ];

    const contents = this.collision.pointContents(feet);
    state.waterLevel = 0;
    state.waterType = Contents.EMPTY;
    if (contents <= Contents.WATER && contents >= Contents.LAVA) {
      state.waterType = contents;
      state.waterLevel = 1;
      if (this.collision.pointContents(waist) <= Contents.WATER) {
        state.waterLevel = 2;
        if (this.collision.pointContents(eyes) <= Contents.WATER) state.waterLevel = 3;
      }
    }
  }
}

/** Vecteurs avant et droite à partir des angles de vue. */
export function directions(yaw: number, pitch: number): [Vec3, Vec3] {
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  const forward: Vec3 = [cp * cy, cp * sy, -sp];
  const right: Vec3 = [sy, -cy, 0];
  return [forward, right];
}

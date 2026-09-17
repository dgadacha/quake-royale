import * as THREE from 'three';
import { Contents } from '../formats/bsp';
import type { CollisionWorld, Vec3 } from './collision';
import type { InputManager } from './input';
import { createMoveState, directions, MoveConfig, PlayerPhysics, type MoveState } from './physics';
import { quakeToThree } from '../render/world';

/** Hauteur des yeux au-dessus de l'origine du joueur. */
const VIEW_HEIGHT = 22;
const MAX_PITCH = Math.PI / 2 - 0.02;

export class Player {
  readonly state: MoveState;
  private readonly physics: PlayerPhysics;
  yaw = 0;
  pitch = 0;
  private bobPhase = 0;
  private viewOffset = 0;
  private roll = 0;
  private lastGroundZ: number;
  private attackHeld = false;
  /** Vrai le temps d'une image, à l'appui sur le tir. */
  private attackEdge = false;
  private lastMouse: [number, number] = [0, 0];
  health = 100;
  /** Temps depuis le dernier coup reçu, pour le retour visuel. */
  sinceHurt = Infinity;
  private readonly spawnOrigin: Vec3;
  private readonly spawnYaw: number;

  constructor(collision: CollisionWorld, spawn: Vec3, spawnYaw: number) {
    this.physics = new PlayerPhysics(collision);
    this.state = createMoveState(spawn);
    this.yaw = spawnYaw;
    this.lastGroundZ = spawn[2];
    this.spawnOrigin = [...spawn] as Vec3;
    this.spawnYaw = spawnYaw;
  }

  get position(): Vec3 {
    return this.state.origin;
  }

  get speed(): number {
    return Math.hypot(this.state.velocity[0], this.state.velocity[1]);
  }

  get underwater(): boolean {
    return this.state.waterLevel >= 3;
  }

  get waterType(): number {
    return this.state.waterType;
  }

  update(input: InputManager, deltaTime: number): void {
    const snapshot = input.sample();

    this.yaw -= snapshot.mouseDeltaX;
    this.pitch -= snapshot.mouseDeltaY;
    this.pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, this.pitch));

    this.attackEdge = snapshot.attack && !this.attackHeld;
    this.attackHeld = snapshot.attack;
    this.lastMouse = [snapshot.mouseDeltaX, snapshot.mouseDeltaY];

    this.advance(snapshot, deltaTime);
  }

  /** Point d'entrée du harnais : mêmes commandes, sans la souris. */
  stepForHarness(
    command: { forward: number; side: number; jump: boolean; run: boolean },
    deltaTime: number,
  ): void {
    this.advance({ ...command, up: 0 }, deltaTime);
  }

  private advance(
    snapshot: { forward: number; side: number; up?: number; jump: boolean; run: boolean },
    deltaTime: number,
  ): void {
    const speedScale = snapshot.run ? 1 : 0.58;
    const wishForward = snapshot.forward * MoveConfig.maxSpeed * speedScale;
    const wishSide = snapshot.side * MoveConfig.maxSpeed * speedScale;

    const previousZ = this.state.origin[2];
    this.physics.step(
      this.state,
      {
        forward: wishForward,
        side: wishSide,
        up: (snapshot.up ?? 0) * MoveConfig.waterMaxSpeed,
        jump: snapshot.jump,
        yaw: this.yaw,
        pitch: this.pitch,
      },
      deltaTime,
    );

    // Lissage vertical des marches : sans lui, monter un escalier saccade la vue.
    const climbed = this.state.origin[2] - previousZ;
    if (this.state.onGround && climbed > 0 && climbed <= MoveConfig.stepSize + 1) {
      this.viewOffset -= climbed;
    }
    this.viewOffset = THREE.MathUtils.damp(this.viewOffset, 0, 12, deltaTime);
    if (this.state.onGround) this.lastGroundZ = this.state.origin[2];

    // Balancement de marche et inclinaison en virage.
    const horizontalSpeed = this.speed;
    if (this.state.onGround && horizontalSpeed > 20) {
      this.bobPhase += deltaTime * (4 + horizontalSpeed * 0.012);
    } else {
      this.bobPhase += deltaTime * 0.8;
    }
    const [, right] = directions(this.yaw, 0);
    const sideSpeed =
      this.state.velocity[0] * right[0] + this.state.velocity[1] * right[1];
    const targetRoll = THREE.MathUtils.clamp(-sideSpeed / MoveConfig.maxSpeed, -1, 1) * 0.035;
    this.roll = THREE.MathUtils.damp(this.roll, targetRoll, 8, deltaTime);
    this.sinceHurt += deltaTime;
  }

  /** Place et oriente la caméra à partir de l'état courant. */
  applyToCamera(camera: THREE.PerspectiveCamera): void {
    const bobAmount =
      this.state.onGround && this.speed > 20
        ? Math.sin(this.bobPhase * 2) * Math.min(1.6, this.speed * 0.006)
        : Math.sin(this.bobPhase) * 0.25;

    const eye: Vec3 = [
      this.state.origin[0],
      this.state.origin[1],
      this.state.origin[2] + VIEW_HEIGHT + this.viewOffset + bobAmount,
    ];

    const [forward] = directions(this.yaw, this.pitch);
    const target: Vec3 = [eye[0] + forward[0], eye[1] + forward[1], eye[2] + forward[2]];

    camera.position.set(...quakeToThree(eye[0], eye[1], eye[2]));
    camera.up.set(0, 1, 0);
    camera.lookAt(...quakeToThree(target[0], target[1], target[2]));
    camera.rotateZ(this.roll);
  }

  /** Position des yeux dans le repère de rendu, pour la lampe et le son. */
  eyeWorldPosition(out = new THREE.Vector3()): THREE.Vector3 {
    const [x, y, z] = quakeToThree(
      this.state.origin[0],
      this.state.origin[1],
      this.state.origin[2] + VIEW_HEIGHT,
    );
    return out.set(x, y, z);
  }

  /** Encaisse un coup ; renvoie vrai si le joueur vient de tomber. */
  hurt(amount: number): boolean {
    if (this.health <= 0) return false;
    this.health -= amount;
    this.sinceHurt = 0;
    if (this.health <= 0) {
      this.health = 0;
      return true;
    }
    return false;
  }

  /** Remet le joueur au point de départ, en pleine santé. */
  respawn(): void {
    this.state.origin = [...this.spawnOrigin] as Vec3;
    this.state.velocity = [0, 0, 0];
    this.yaw = this.spawnYaw;
    this.pitch = 0;
    this.health = 100;
    this.sinceHurt = Infinity;
  }

  /** Direction de visée, dans le repère du jeu. */
  get aimDirection(): Vec3 {
    const [forward] = directions(this.yaw, this.pitch);
    return forward;
  }

  get eyeOrigin(): Vec3 {
    return [this.state.origin[0], this.state.origin[1], this.state.origin[2] + VIEW_HEIGHT];
  }

  /** Consomme l'appui sur le tir : il n'est signalé qu'une fois. */
  consumeAttack(): boolean {
    const pressed = this.attackEdge;
    this.attackEdge = false;
    return pressed;
  }

  get aimDelta(): [number, number] {
    return this.lastMouse;
  }

  get fellFrom(): number {
    return this.lastGroundZ;
  }

  get inLava(): boolean {
    return this.state.waterType === Contents.LAVA && this.state.waterLevel > 0;
  }
}

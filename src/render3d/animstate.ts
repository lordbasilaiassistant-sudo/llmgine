/**
 * AnimState — data-driven animation state resolution shared by procedural
 * rigs and glTF models.
 *
 * Every model factory in examples/arena/models3d.ts re-derives "what is this
 * entity doing" ad-hoc from Attack.winding/ready, Velocity, Transform.z —
 * that doesn't scale past a handful of archetypes. This module centralizes
 * that read into ONE canonical, priority-ordered resolver:
 *
 *   dead > windup > attack > air > hit > walk > idle
 *
 * plus a per-entity crossfade wrapper (AnimStateMachine) so rigs can BLEND
 * between states instead of popping (procedural: lerp joint targets by
 * weight; glTF: feed weights to AnimationActions via applyClipWeights).
 *
 * Design contract:
 * - READS sim state only, never mutates it. Pure data in, plain data out.
 * - Components are read by NAME (world.getNamed) so this layer never imports
 *   gameplay modules — Ranged lives in systems/projectiles and stays there.
 * - Headless: no THREE import; runs (and is tested) in plain Node.
 * - Deterministic: identical (world, dt) sequences produce identical output.
 */
import type { World } from "../core/ecs.js";

/** Canonical states, highest priority first. */
export const ANIM_STATES = [
  "dead",
  "windup",
  "attack",
  "air",
  "hit",
  "walk",
  "idle",
] as const;

export type AnimStateName = (typeof ANIM_STATES)[number];

/** Resolved state + its normalized progress (meaning is per-state, see docs/animation.md). */
export interface AnimSample {
  state: AnimStateName;
  t: number;
}

/** Speed above which an entity reads as walking (matches the arena rigs' `sp > 8`). */
export const WALK_MIN_SPEED = 8;
/** Transform.z above this = airborne. */
export const AIR_MIN_HEIGHT = 1;
/** Post-hit iframes window (combatSystem sets iframes = 0.1 on every hit). */
export const HIT_IFRAMES_WINDOW = 0.1;
/** Default jump launch speed (verbs.ts jump strength) — normalizes the air arc. */
export const JUMP_SPEED_REF = 240;

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);

/**
 * Swing envelope: 0 at the moment the hit lands → whips to 1 → settles back
 * to 0 across the first third of the cooldown. `ready` DECAYS from cooldown
 * to 0 — using it raw plays the swing in reverse (the "sword swings
 * backwards" bug models3d.ts already fixed once; now it lives here).
 */
export function swingEnvelope(ready: number, cooldown: number): number {
  if (ready <= 0 || cooldown <= 0) return 0;
  const p = 1 - ready / cooldown; // 0 → 1 across the cooldown
  return Math.sin(Math.min(1, p * 3) * Math.PI); // fast forward whip, smooth recovery
}

/**
 * Canonical priority-ordered state resolution from sim components.
 *
 * - dead    Health.hp <= 0 ................. t = 1 (settled; animate the fall via crossfade weight)
 * - windup  Attack/Ranged.winding > 0 ...... t = 1 - winding/windup (0 = telegraph start, 1 = hit lands)
 * - attack  post-swing whip window ......... t = swingEnvelope(ready, cooldown), first ⅓ of cooldown
 * - air     Transform.z > 1 ................ t = arc progress (0 launch, 0.5 apex, 1 landing) via Velocity.vz
 * - hit     Health.iframes > 0 ............. t = iframes/0.1 (1 fresh hit → 0 recovered)
 * - walk    planar speed > 8 ............... t = speed/maxSpeed (stride amplitude follows real speed)
 * - idle    everything else ................ t = world.time % 1 (a free 1s loop; rigs may use their own clock)
 *
 * Missing components simply skip their state — an entity with no Attack can
 * never resolve to windup/attack, a pickup with no Velocity idles.
 */
export function resolveAnimState(world: World, entity: number): AnimSample {
  const health = world.getNamed(entity, "Health");
  if (health && health.hp <= 0) return { state: "dead", t: 1 };

  const atk = world.getNamed(entity, "Attack");
  const ranged = world.getNamed(entity, "Ranged");
  if ((atk && atk.winding > 0) || (ranged && ranged.winding > 0)) {
    const melee =
      atk && atk.winding > 0 ? (atk.windup > 0 ? 1 - atk.winding / atk.windup : 1) : 0;
    const chant =
      ranged && ranged.winding > 0
        ? ranged.windup > 0
          ? 1 - ranged.winding / ranged.windup
          : 1
        : 0;
    return { state: "windup", t: clamp01(Math.max(melee, chant)) };
  }

  // whip window = first third of the cooldown (where the envelope is nonzero)
  if (atk && atk.ready > 0 && atk.cooldown > 0 && (1 - atk.ready / atk.cooldown) * 3 < 1) {
    return { state: "attack", t: swingEnvelope(atk.ready, atk.cooldown) };
  }

  const transform = world.getNamed(entity, "Transform");
  if (transform && (transform.z ?? 0) > AIR_MIN_HEIGHT) {
    const v = world.getNamed(entity, "Velocity");
    // vz: +launch → 0 apex → −landing, mapped to 0 → 0.5 → 1
    const t =
      v && typeof v.vz === "number" ? clamp01(0.5 - v.vz / (2 * JUMP_SPEED_REF)) : 0.5;
    return { state: "air", t };
  }

  if (health && health.iframes > 0) {
    return { state: "hit", t: clamp01(health.iframes / HIT_IFRAMES_WINDOW) };
  }

  const v = world.getNamed(entity, "Velocity");
  const speed = v ? Math.hypot(v.vx ?? 0, v.vy ?? 0) : 0;
  if (speed > WALK_MIN_SPEED) {
    return { state: "walk", t: clamp01(speed / (v.maxSpeed > 0 ? v.maxSpeed : speed)) };
  }

  return { state: "idle", t: world.time % 1 };
}

/** One blended animation frame: the active state, its progress, and crossfade weights (sum ≈ 1). */
export interface AnimBlend {
  state: AnimStateName;
  t: number;
  weights: Partial<Record<AnimStateName, number>>;
}

/**
 * Per-entity crossfade smoothing over resolveAnimState.
 *
 * Each `sample(world, entity, dt)` resolves the current state and ramps the
 * entity's weight table toward it (linear, over `blendTime` seconds), then
 * renormalizes so weights always sum to 1. A rig blends poses by weight:
 * procedural rigs lerp joint targets, glTF rigs pass the table to
 * applyClipWeights. First sample of an entity snaps (weight 1, no fade-in
 * from nothing). Deterministic given the same (world, dt) sequence.
 *
 * Call `prune(seen)` once per frame with the live entity set — same contract
 * as TransformLerp — so despawned entities don't leak state.
 */
export class AnimStateMachine {
  private weights = new Map<number, Partial<Record<AnimStateName, number>>>();

  /** @param blendTime seconds for a full 0→1 crossfade. <= 0 snaps instantly. */
  constructor(readonly blendTime = 0.12) {}

  sample(world: World, entity: number, dt: number): AnimBlend {
    const { state, t } = resolveAnimState(world, entity);
    let w = this.weights.get(entity);
    if (!w) {
      w = { [state]: 1 };
      this.weights.set(entity, w);
      return { state, t, weights: { ...w } };
    }
    const step = this.blendTime > 0 ? Math.max(0, dt) / this.blendTime : Infinity;
    if (!(state in w)) w[state] = 0;
    let sum = 0;
    for (const key of Object.keys(w) as AnimStateName[]) {
      const target = key === state ? 1 : 0;
      let cur = w[key] ?? 0;
      const d = target - cur;
      cur += Math.abs(d) <= step ? d : Math.sign(d) * step;
      if (cur <= 1e-4 && target === 0) {
        delete w[key]; // fully faded out — drop so the table stays small
        continue;
      }
      w[key] = cur;
      sum += cur;
    }
    // linear ramps between 2 states already sum to 1; 3+ states mid-fade
    // drift, so renormalize (weights are blend fractions, not raw ramps)
    if (sum > 0 && Math.abs(sum - 1) > 1e-9) {
      for (const key of Object.keys(w) as AnimStateName[]) {
        w[key] = (w[key] ?? 0) / sum;
      }
    }
    return { state, t, weights: { ...w } };
  }

  /** Drop entities not seen this frame (died/despawned). Same contract as TransformLerp.prune. */
  prune(seen: ReadonlySet<number>): void {
    for (const e of this.weights.keys()) if (!seen.has(e)) this.weights.delete(e);
  }

  clear(): void {
    this.weights.clear();
  }
}

/**
 * Feed an AnimStateMachine weight table into a map of glTF AnimationActions
 * (structural interface — THREE.AnimationAction satisfies it, no THREE
 * import needed here). Actions keyed by state name get their weight set;
 * anything with weight > 0 is (re)played, faded-out actions keep running at
 * weight 0 (the mixer's cost is per-clip sampling, and stop/play churn on
 * every transition causes pops).
 *
 *   const actions = { idle: mixer.clipAction(idleClip), walk: mixer.clipAction(walkClip) };
 *   applyClipWeights(actions, machine.sample(world, e, dt).weights);
 */
export function applyClipWeights(
  mixerActions: Record<string, { weight: number; play(): void } | null | undefined>,
  weights: Partial<Record<string, number>>,
): void {
  for (const name of Object.keys(mixerActions)) {
    const action = mixerActions[name];
    if (!action) continue;
    const w = weights[name] ?? 0;
    action.weight = w;
    if (w > 0) action.play();
  }
}

# AnimState — data-driven animation states

Source: `src/render3d/animstate.ts`. Import: `llmgine/render3d`. Headless
(no THREE import) — it READS sim components by name and never mutates them.

One canonical answer to "what is this entity doing", instead of every model
factory re-deriving poses ad-hoc from `Attack.winding`/`ready`, `Velocity`,
`Transform.z` (the pattern in `examples/arena/models3d.ts` that stops scaling
past ~5 archetypes).

## States, highest priority first

| state    | condition                                   | `t` (progress)                                          |
| -------- | ------------------------------------------- | ------------------------------------------------------- |
| `dead`   | `Health.hp <= 0`                            | `1` (constant — animate the fall via crossfade weight)   |
| `windup` | `Attack.winding > 0` or `Ranged.winding > 0`| `1 - winding/windup` — 0 telegraph start → 1 hit lands   |
| `attack` | `Attack.ready` in first ⅓ of cooldown       | `sin(min(1,(1-ready/cooldown)*3)·π)` — fast whip, settle |
| `air`    | `Transform.z > 1`                           | arc: 0 launch → 0.5 apex → 1 landing (from `Velocity.vz`)|
| `hit`    | `Health.iframes > 0`                        | `iframes/0.1` — 1 fresh hit → 0 recovered                |
| `walk`   | planar speed > 8                            | `speed/maxSpeed` — stride amplitude follows real speed   |
| `idle`   | everything else                             | `world.time % 1` — free 1s loop (rigs may use own clock) |

Missing components skip their state (no `Attack` → never `windup`/`attack`).

```ts
import { resolveAnimState, AnimStateMachine, applyClipWeights } from "llmgine/render3d";

resolveAnimState(world, e); // → { state: "windup", t: 0.75 }
```

## AnimStateMachine — crossfaded weights

Per-entity smoothing: linear crossfade over `blendTime` (default 0.12 s),
weights always sum to 1, first sample snaps. Deterministic for the same
`(world, dt)` sequence. Call `prune(seen)` once per frame with the live
entity set (same contract as `TransformLerp.prune`).

```ts
const anim = new AnimStateMachine(); // new AnimStateMachine(0.2) for heavier rigs
const { state, t, weights } = anim.sample(world, e, dt);
// mid-transition: { state: "walk", t: 0.6, weights: { idle: 0.4, walk: 0.6 } }
```

## Procedural rig example

Blend joint targets by weight — a pose per state, weighted sum:

```ts
g.userData.animate = (time: number, world: World, e: number) => {
  const { t, weights } = anim.sample(world, e, time - last); last = time;
  const w = (s: string) => weights[s as AnimStateName] ?? 0;

  // one target pose per state, mixed by weight (windup raises the maul
  // by t, attack slams it by the whip envelope t)
  arm.rotation.z =
    w("idle")   * 1.15 +
    w("walk")   * (1.15 + Math.sin(time * 12) * 0.1) +
    w("windup") * (1.15 - t * 2.5) +
    w("attack") * (1.15 + t * 2.9) +
    w("dead")   * 2.6;
  legL.rotation.x = w("walk") * Math.sin(time * 12) * 0.7 + w("air") * 0.6;
  legR.rotation.x = -legL.rotation.x * (1 - w("air"));
  coreMat.emissiveIntensity = 0.8 + w("windup") * t * 4.5; // tell flares as the hit nears
};
```

## glTF example

Key `AnimationAction`s by state name and feed the weight table straight in
(`applyClipWeights` sets `action.weight` and `play()`s anything > 0):

```ts
const mixer = new THREE.AnimationMixer(inst);
const clip = (n: string) => THREE.AnimationClip.findByName(asset.animations, n);
const actions = {
  idle:   mixer.clipAction(clip("Idle")),
  walk:   mixer.clipAction(clip("Walk")),
  windup: mixer.clipAction(clip("Charge")),
  attack: mixer.clipAction(clip("Slash")),
  dead:   mixer.clipAction(clip("Death")),
};

root.userData.animate = (time: number, world: World, e: number) => {
  const dt = last ? time - last : 0; last = time;
  applyClipWeights(actions, anim.sample(world, e, dt).weights);
  mixer.update(dt);
};
```

States without a clip in the map simply don't contribute (missing actions are
skipped; missing weights read as 0). Share one `AnimStateMachine` across all
entities of a renderer and `prune` it where you prune `TransformLerp`.

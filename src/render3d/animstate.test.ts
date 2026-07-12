import { describe, expect, it } from "vitest";
import { World } from "../core/ecs.js";
import { Attack, Health, Transform, Velocity } from "../components.js";
import { Ranged } from "../systems/projectiles.js";
import {
  AnimStateMachine,
  applyClipWeights,
  resolveAnimState,
  swingEnvelope,
} from "./animstate.js";

const spawn = (world: World) => {
  const e = world.create();
  world.add(e, Transform);
  return e;
};

describe("resolveAnimState — canonical priority resolution", () => {
  it("defaults to idle with a time-based loop t", () => {
    const world = new World();
    const e = spawn(world);
    world.time = 3.25;
    expect(resolveAnimState(world, e)).toEqual({ state: "idle", t: 0.25 });
  });

  it("walks above the speed threshold, t = speed/maxSpeed", () => {
    const world = new World();
    const e = spawn(world);
    world.add(e, Velocity, { vx: 60, vy: 0, maxSpeed: 120 });
    expect(resolveAnimState(world, e)).toEqual({ state: "walk", t: 0.5 });
  });

  it("slow drift (speed <= 8) still reads as idle", () => {
    const world = new World();
    const e = spawn(world);
    world.add(e, Velocity, { vx: 5, vy: 0 });
    expect(resolveAnimState(world, e).state).toBe("idle");
  });

  it("windup beats walk", () => {
    const world = new World();
    const e = spawn(world);
    world.add(e, Velocity, { vx: 100, vy: 0, maxSpeed: 120 });
    world.add(e, Attack, { winding: 0.1, windup: 0.4 });
    const s = resolveAnimState(world, e);
    expect(s.state).toBe("windup");
    expect(s.t).toBeCloseTo(0.75); // 1 - 0.1/0.4
  });

  it("ranged chant windup resolves too (read by name — no layer coupling)", () => {
    const world = new World();
    const e = spawn(world);
    world.add(e, Ranged, { winding: 0.2, windup: 0.4 });
    const s = resolveAnimState(world, e);
    expect(s.state).toBe("windup");
    expect(s.t).toBeCloseTo(0.5);
  });

  it("dead beats everything", () => {
    const world = new World();
    const e = spawn(world);
    world.require(e, Transform).z = 20; // airborne
    world.add(e, Health, { hp: 0, iframes: 0.05 });
    world.add(e, Attack, { winding: 0.1, windup: 0.4 });
    world.add(e, Velocity, { vx: 100, vy: 0 });
    expect(resolveAnimState(world, e)).toEqual({ state: "dead", t: 1 });
  });

  it("attack whips in the post-swing window with the sin envelope", () => {
    const world = new World();
    const e = spawn(world);
    // ready decays cooldown → 0; p = 1 - ready/cooldown. p = 1/6 → sin(π/2) = 1
    const atk = world.add(e, Attack, { cooldown: 0.9, ready: 0.75 });
    const s = resolveAnimState(world, e);
    expect(s.state).toBe("attack");
    expect(s.t).toBeCloseTo(1);
    // past the whip window (p > 1/3) the state falls through to idle
    atk.ready = 0.5; // p = 4/9 — envelope over, no longer "attack"
    expect(resolveAnimState(world, e).state).toBe("idle");
  });

  it("air above z=1, arc t from vz: 0 launch → 0.5 apex → 1 landing", () => {
    const world = new World();
    const e = spawn(world);
    world.require(e, Transform).z = 20;
    const v = world.add(e, Velocity, { vz: 240 }); // default jump launch speed
    expect(resolveAnimState(world, e)).toEqual({ state: "air", t: 0 });
    v.vz = 0;
    expect(resolveAnimState(world, e).t).toBeCloseTo(0.5);
    v.vz = -240;
    expect(resolveAnimState(world, e).t).toBeCloseTo(1);
    v.vz = -900; // over-speed clamps, never leaves [0,1]
    expect(resolveAnimState(world, e).t).toBe(1);
  });

  it("air without a Velocity holds the apex pose (t = 0.5)", () => {
    const world = new World();
    const e = spawn(world);
    world.require(e, Transform).z = 20;
    expect(resolveAnimState(world, e)).toEqual({ state: "air", t: 0.5 });
  });

  it("hit flinches while iframes tick down (t = iframes/0.1) but air beats hit", () => {
    const world = new World();
    const e = spawn(world);
    world.add(e, Health, { hp: 50, iframes: 0.05 });
    const s = resolveAnimState(world, e);
    expect(s.state).toBe("hit");
    expect(s.t).toBeCloseTo(0.5);
    world.require(e, Transform).z = 20; // knocked into the air mid-iframes
    expect(resolveAnimState(world, e).state).toBe("air");
  });
});

describe("swingEnvelope", () => {
  it("is 0 at rest and outside the whip window", () => {
    expect(swingEnvelope(0, 0.8)).toBe(0);
    expect(swingEnvelope(0.5, 0)).toBe(0);
    expect(swingEnvelope(0.4, 0.9)).toBeCloseTo(0); // p = 5/9 > 1/3 → sin(π) = 0
  });

  it("whips forward fast then recovers (never plays in reverse)", () => {
    const cooldown = 0.9;
    // p: 0 → 1/12 → 1/6 (peak) — envelope must RISE right after the swing
    expect(swingEnvelope(cooldown, cooldown)).toBeCloseTo(0); // p = 0
    expect(swingEnvelope(0.825, cooldown)).toBeCloseTo(Math.sin(Math.PI / 4)); // p = 1/12
    expect(swingEnvelope(0.75, cooldown)).toBeCloseTo(1); // p = 1/6, sin(π/2)
    expect(swingEnvelope(0.7, cooldown)).toBeLessThan(1); // settling
  });
});

describe("AnimStateMachine — crossfade weights", () => {
  it("first sample snaps to the resolved state (no fade-in from nothing)", () => {
    const world = new World();
    const e = spawn(world);
    const m = new AnimStateMachine();
    expect(m.sample(world, e, 1 / 60).weights).toEqual({ idle: 1 });
  });

  it("crossfades over blendTime, weights sum ≈ 1 mid-fade and converge", () => {
    const world = new World();
    const e = spawn(world);
    const m = new AnimStateMachine(0.12);
    m.sample(world, e, 1 / 60); // snap to idle
    const v = world.add(e, Velocity, { vx: 100, vy: 0, maxSpeed: 120 });

    const mid = m.sample(world, e, 0.06); // half the blend
    expect(mid.state).toBe("walk");
    expect(mid.weights.walk).toBeCloseTo(0.5);
    expect(mid.weights.idle).toBeCloseTo(0.5);
    const sum = Object.values(mid.weights).reduce((a, b) => a + (b ?? 0), 0);
    expect(sum).toBeCloseTo(1, 9);

    const done = m.sample(world, e, 0.06); // fade complete
    expect(done.weights).toEqual({ walk: 1 }); // idle pruned from the table
    v.vx = 0; // and back again
    const back = m.sample(world, e, 0.06);
    expect(back.weights.idle).toBeCloseTo(0.5);
    expect(back.weights.walk).toBeCloseTo(0.5);
  });

  it("three-way transitions renormalize so weights still sum to 1", () => {
    const world = new World();
    const e = spawn(world);
    const m = new AnimStateMachine(0.12);
    const v = world.add(e, Velocity, { vx: 100, vy: 0, maxSpeed: 120 });
    m.sample(world, e, 1 / 60); // snap to walk
    v.vx = 0;
    m.sample(world, e, 0.04); // walk → idle, partial
    world.require(e, Transform).z = 20; // interrupt: idle → air mid-fade
    const tri = m.sample(world, e, 0.02);
    const keys = Object.keys(tri.weights);
    expect(keys).toContain("air");
    expect(keys.length).toBeGreaterThanOrEqual(3);
    const sum = Object.values(tri.weights).reduce((a, b) => a + (b ?? 0), 0);
    expect(sum).toBeCloseTo(1, 9);
    // keep sampling — converges to the active state
    for (let i = 0; i < 20; i++) m.sample(world, e, 1 / 60);
    expect(m.sample(world, e, 1 / 60).weights).toEqual({ air: 1 });
  });

  it("is deterministic for the same (world, dt) sequence", () => {
    const run = () => {
      const world = new World(7);
      const e = spawn(world);
      const v = world.add(e, Velocity, { vx: 90, vy: 0, maxSpeed: 120 });
      const m = new AnimStateMachine();
      const out = [];
      for (let i = 0; i < 10; i++) {
        if (i === 5) v.vx = 0;
        out.push(m.sample(world, e, 1 / 60));
      }
      return out;
    };
    expect(run()).toEqual(run());
  });

  it("blendTime <= 0 snaps instantly", () => {
    const world = new World();
    const e = spawn(world);
    const m = new AnimStateMachine(0);
    m.sample(world, e, 1 / 60);
    world.add(e, Velocity, { vx: 100, vy: 0, maxSpeed: 120 });
    expect(m.sample(world, e, 1 / 60).weights).toEqual({ walk: 1 });
  });

  it("prune forgets despawned entities (next sample snaps fresh)", () => {
    const world = new World();
    const e = spawn(world);
    const m = new AnimStateMachine();
    m.sample(world, e, 1 / 60); // idle snap
    world.add(e, Velocity, { vx: 100, vy: 0, maxSpeed: 120 });
    m.sample(world, e, 0.01); // tiny partial fade toward walk
    m.prune(new Set()); // entity despawned
    // re-seen (e.g. id reuse): snaps to walk instead of resuming the old fade
    expect(m.sample(world, e, 0.01).weights).toEqual({ walk: 1 });
  });
});

describe("applyClipWeights", () => {
  const mkAction = () => {
    const a = { weight: -1, played: false, play() { this.played = true; } };
    return a;
  };

  it("sets weights by state name and plays only active clips", () => {
    const walk = mkAction();
    const idle = mkAction();
    const attack = mkAction();
    applyClipWeights({ walk, idle, attack }, { walk: 0.7, idle: 0.3 });
    expect(walk.weight).toBeCloseTo(0.7);
    expect(walk.played).toBe(true);
    expect(idle.weight).toBeCloseTo(0.3);
    expect(idle.played).toBe(true);
    expect(attack.weight).toBe(0); // absent from the table → weight 0, not played
    expect(attack.played).toBe(false);
  });

  it("tolerates missing actions (asset without that clip)", () => {
    const walk = mkAction();
    expect(() => applyClipWeights({ walk, dead: undefined }, { walk: 1, dead: 0.5 })).not.toThrow();
    expect(walk.weight).toBe(1);
  });
});

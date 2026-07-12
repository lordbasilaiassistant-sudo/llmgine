import { describe, expect, it, vi } from "vitest";
import { World, GameLoop } from "../index.js";
import { ActionRegistry, actionSystem } from "./actions.js";
import { SpatialGrid } from "./spatial.js";
import { NavGrid } from "./nav.js";
import {
  Attack, Behavior, Collider, Faction, Health, Inventory, Pickup, PlayerControlled, Speech,
  Transform, Velocity, ALL_COMPONENTS,
} from "../components.js";
import { STANDARD_VERBS } from "../verbs.js";
import { movementSystem, collisionSystem } from "../systems/movement.js";
import { aggroSystem, behaviorSystem } from "../systems/behavior.js";
import { combatSystem, dealDamage } from "../systems/combat.js";
import { Projectile, Ranged, projectileSystem, shootVerb } from "../systems/projectiles.js";

/** Regression tests for the 2026-07-11 audit — every case here was a live bug. */

function registry(): ActionRegistry {
  const actions = new ActionRegistry();
  for (const v of STANDARD_VERBS) actions.register(v);
  actions.register(shootVerb);
  return actions;
}

describe("action gate type enforcement (#8)", () => {
  it("rejects strings, NaN, Infinity, and non-integer entity ids", () => {
    const world = new World(1);
    const actions = registry();
    const e = world.create();
    world.add(e, Transform, {});
    world.add(e, Velocity, {});
    world.add(e, Behavior, {});
    expect(actions.execute(world, { actor: e, verb: "move_to", params: { x: "north", y: 5 } }).ok).toBe(false);
    expect(actions.execute(world, { actor: e, verb: "move_to", params: { x: NaN, y: 5 } }).ok).toBe(false);
    expect(actions.execute(world, { actor: e, verb: "move_to", params: { x: Infinity, y: 5 } }).ok).toBe(false);
    expect(actions.execute(world, { actor: e, verb: "follow", params: { target: 1.5 } }).ok).toBe(false);
    expect(actions.execute(world, { actor: e, verb: "move_to", params: { x: 10, y: 5 } }).ok).toBe(true);
    const t = world.require(e, Transform);
    expect(Number.isFinite(t.x)).toBe(true);
  });

  it("strips undeclared params before they reach resolvers", () => {
    const world = new World(1);
    const actions = new ActionRegistry();
    let seen: any = null;
    actions.register({
      name: "probe",
      description: "",
      params: { x: { type: "number" } },
      resolve: (_w, a) => (seen = a.params),
    });
    actions.execute(world, { actor: world.create(), verb: "probe", params: { x: 1, evil: "injected" } });
    expect(seen).toEqual({ x: 1 });
  });

  it("contains throwing resolvers instead of aborting the tick (#17)", () => {
    const world = new World(1);
    const actions = new ActionRegistry();
    actions.register({
      name: "boom",
      description: "",
      params: {},
      resolve: () => {
        throw new Error("kaboom");
      },
    });
    world.addSystem(actionSystem(actions));
    actions.submit({ actor: world.create(), verb: "boom", params: {} });
    expect(() => world.step(1 / 60)).not.toThrow();
    const last = actions.recent[actions.recent.length - 1];
    expect(last.ok).toBe(false);
    expect(last.error).toContain("kaboom");
  });
});

describe("attack verb guards (#9)", () => {
  it("rejects self-attack and same-faction targets", () => {
    const world = new World(1);
    const actions = registry();
    const mk = (faction: string) => {
      const e = world.create();
      world.add(e, Transform, {});
      world.add(e, Velocity, {});
      world.add(e, Behavior, {});
      world.add(e, Attack, {});
      world.add(e, Health, {});
      world.add(e, Faction, { id: faction });
      return e;
    };
    const a = mk("beasts");
    const ally = mk("beasts");
    const enemy = mk("heroes");
    expect(actions.execute(world, { actor: a, verb: "attack", params: { target: a } }).ok).toBe(false);
    expect(actions.execute(world, { actor: a, verb: "attack", params: { target: ally } }).ok).toBe(false);
    expect(actions.execute(world, { actor: a, verb: "attack", params: { target: enemy } }).ok).toBe(true);
  });
});

describe("same-tick pickup contention (#13)", () => {
  it("only one actor gets the item", () => {
    const world = new World(1);
    const actions = registry();
    const mk = () => {
      const e = world.create();
      world.add(e, Transform, {});
      world.add(e, Inventory, {});
      return e;
    };
    const a = mk();
    const b = mk();
    const gem = world.create();
    world.add(gem, Transform, {});
    world.add(gem, Pickup, { item: { id: "gem", name: "Gem", qty: 1 } });
    world.addSystem(actionSystem(actions));
    actions.submit({ actor: a, verb: "pickup", params: { target: gem } });
    actions.submit({ actor: b, verb: "pickup", params: { target: gem } });
    world.step(1 / 60);
    const got = [a, b].filter((e) => world.require(e, Inventory).items.length > 0);
    expect(got.length).toBe(1);
  });

  it("full inventory is a visible failure, not a false success", () => {
    const world = new World(1);
    const actions = registry();
    const a = world.create();
    world.add(a, Transform, {});
    world.add(a, Inventory, { capacity: 1, items: [{ id: "x", name: "X", qty: 1 }] });
    const gem = world.create();
    world.add(gem, Transform, {});
    world.add(gem, Pickup, { item: { id: "gem", name: "Gem", qty: 1 } });
    const res = actions.execute(world, { actor: a, verb: "pickup", params: { target: gem } });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("inventory full");
    expect(world.isAlive(gem)).toBe(true);
  });
});

describe("journal visibility (#12)", () => {
  it("retaliation fires even though combat runs after aggro", () => {
    const world = new World(1);
    const grid = new SpatialGrid();
    world.addSystem(aggroSystem()).addSystem(behaviorSystem()).addSystem(movementSystem(grid)).addSystem(combatSystem());
    const victim = world.create();
    world.add(victim, Transform, {});
    world.add(victim, Velocity, {});
    world.add(victim, Behavior, { mode: "idle" });
    world.add(victim, Attack, {});
    world.add(victim, Health, { hp: 100, maxHp: 100 });
    const attacker = world.create();
    world.add(attacker, Transform, { x: 20 });
    world.add(attacker, Health, { hp: 100, maxHp: 100 });
    // damage emitted mid-tick by a system ordered AFTER aggro
    world.addSystem({
      name: "scripted-hit",
      order: 25,
      update: ({ world: w }) => {
        if (w.tick === 1) dealDamage(w, attacker, victim, 5);
      },
    });
    new GameLoop(world).advance(3);
    const b = world.require(victim, Behavior);
    expect(b.mode).toBe("attack");
    expect(b.target).toBe(attacker);
  });
});

describe("save/load robustness (#16)", () => {
  it("migrates drifted component schemas with defaults", () => {
    const world = new World(1);
    const e = world.create();
    world.add(e, Health, { hp: 50, maxHp: 80 });
    const snap = world.save();
    // simulate a v1.0 save missing a field added later
    delete (snap.components["Health"][0][1] as any).iframes;
    const w2 = new World(1);
    w2.load(snap, ALL_COMPONENTS);
    expect(w2.require(e, Health).iframes).toBe(0); // default restored, not undefined
  });

  it("warns about (and reports) unregistered component types", () => {
    const world = new World(1);
    const e = world.create();
    world.add(e, Health, {});
    world.add(e, Ranged, {});
    const snap = world.save();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const w2 = new World(1);
    const { dropped } = w2.load(snap, [Health as any]);
    expect(dropped).toContain("Ranged");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("clears pending destroys and journal state on load", () => {
    const world = new World(1);
    const e = world.create();
    world.add(e, Health, {});
    const snap = world.save();
    world.destroy(e); // off-tick destroy queued...
    world.load(snap, ALL_COMPONENTS); // ...must not execute against the loaded world
    world.step(1 / 60);
    expect(world.isAlive(e)).toBe(true);
  });

  it("loaded world continues identically to the never-saved original", () => {
    const mk = () => {
      const world = new World(99);
      const grid = new SpatialGrid();
      world.addSystem(behaviorSystem()).addSystem(movementSystem(grid));
      const e = world.create();
      world.add(e, Transform, {});
      world.add(e, Velocity, { maxSpeed: 90 });
      world.add(e, Behavior, { mode: "wander" });
      return world;
    };
    const original = mk();
    new GameLoop(original).advance(120);
    const snap = structuredClone(original.save());
    new GameLoop(original).advance(120);

    const restored = mk();
    restored.load(snap, ALL_COMPONENTS);
    new GameLoop(restored).advance(120);
    expect(JSON.stringify(restored.save())).toBe(JSON.stringify(original.save()));
  });
});

describe("combat clamps (#21)", () => {
  it("ignores NaN and negative damage", () => {
    const world = new World(1);
    const e = world.create();
    world.add(e, Health, { hp: 50, maxHp: 50 });
    dealDamage(world, 0, e, NaN);
    dealDamage(world, 0, e, -30);
    expect(world.require(e, Health).hp).toBe(50);
  });
});

describe("projectiles (#18)", () => {
  function arena(nav?: NavGrid) {
    const world = new World(1);
    const grid = new SpatialGrid();
    const actions = registry();
    world.addSystem(actionSystem(actions)).addSystem(movementSystem(grid)).addSystem(projectileSystem(grid, nav));
    return { world, grid, actions };
  }

  it("no tunneling: a very fast projectile still hits", () => {
    const { world, actions } = arena();
    const shooter = world.create();
    world.add(shooter, Transform, { x: 0, y: 0 });
    world.add(shooter, Ranged, { speed: 5000, range: 600, damage: 10 });
    const target = world.create();
    world.add(target, Transform, { x: 300, y: 0 });
    world.add(target, Health, { hp: 30, maxHp: 30 });
    world.add(target, Collider, { radius: 10 });
    expect(actions.execute(world, { actor: shooter, verb: "shoot", params: { target } }).ok).toBe(true);
    new GameLoop(world).advance(10);
    expect(world.require(target, Health).hp).toBeLessThan(30);
  });

  it("walls block projectiles when a NavGrid is provided", () => {
    const nav = new NavGrid(32);
    nav.blockRect(120, -64, 180, 64); // wall between shooter and target
    const { world, actions } = arena(nav);
    const shooter = world.create();
    world.add(shooter, Transform, { x: 0, y: 0 });
    world.add(shooter, Ranged, { speed: 400, range: 600, damage: 10 });
    const target = world.create();
    world.add(target, Transform, { x: 300, y: 0 });
    world.add(target, Health, { hp: 30, maxHp: 30 });
    world.add(target, Collider, { radius: 10 });
    actions.execute(world, { actor: shooter, verb: "shoot", params: { target } });
    new GameLoop(world).advance(120);
    expect(world.require(target, Health).hp).toBe(30); // cover held
    expect([...world.each(Projectile)].length).toBe(0); // bolt died on the wall
  });
});

describe("collision statics (#19)", () => {
  it("immovable pillars are not shoved by movers", () => {
    const world = new World(1);
    const grid = new SpatialGrid();
    world.addSystem(movementSystem(grid)).addSystem(collisionSystem(grid));
    const pillar = world.create();
    world.add(pillar, Transform, { x: 50, y: 0 });
    world.add(pillar, Collider, { radius: 20 }); // no Velocity → static
    const mover = world.create();
    world.add(mover, Transform, { x: 0, y: 0 });
    world.add(mover, Velocity, { vx: 100, vy: 0, maxSpeed: 100 });
    world.add(mover, Collider, { radius: 12 });
    new GameLoop(world).advance(120);
    const pt = world.require(pillar, Transform);
    expect(pt.x).toBe(50); // unmoved
    expect(pt.y).toBe(0);
    const mt = world.require(mover, Transform);
    expect(Math.hypot(mt.x - pt.x, mt.y - pt.y)).toBeGreaterThanOrEqual(31.9); // pushed out
  });

  it("exact-overlap spawns separate deterministically", () => {
    const world = new World(1);
    const grid = new SpatialGrid();
    world.addSystem(movementSystem(grid)).addSystem(collisionSystem(grid));
    const mk = () => {
      const e = world.create();
      world.add(e, Transform, { x: 10, y: 10 });
      world.add(e, Velocity, {});
      world.add(e, Collider, { radius: 10 });
      return e;
    };
    const a = mk();
    const b = mk();
    new GameLoop(world).advance(5);
    const ta = world.require(a, Transform);
    const tb = world.require(b, Transform);
    expect(Math.hypot(ta.x - tb.x, ta.y - tb.y)).toBeGreaterThan(1);
  });
});

describe("spatial grid pruning (#14)", () => {
  it("destroyed entities leave the grid", () => {
    const world = new World(1);
    const grid = new SpatialGrid();
    world.addSystem(movementSystem(grid));
    const e = world.create();
    world.add(e, Transform, { x: 5, y: 5 });
    world.step(1 / 60);
    expect(grid.near(5, 5, 10)).toContain(e);
    world.destroy(e);
    world.step(1 / 60);
    expect(grid.near(5, 5, 10)).not.toContain(e);
  });
});

describe("facing + jump — engine guarantees (no game can ship these broken)", () => {
  it("movement sets facing; standing attackers face their target", () => {
    const world = new World(1);
    const grid = new SpatialGrid();
    world.addSystem(behaviorSystem()).addSystem(movementSystem(grid)).addSystem(combatSystem());
    const a = world.create();
    world.add(a, Transform, { x: 0, y: 0 });
    world.add(a, Velocity, { vx: 0, vy: 100, maxSpeed: 100 });
    world.step(1 / 60);
    expect(world.require(a, Transform).rot).toBeCloseTo(Math.PI / 2); // faces +y while moving
    // standing in attack range: face the target even with zero velocity
    world.require(a, Velocity).vy = 0;
    world.add(a, Attack, { range: 100 });
    world.add(a, Behavior, { mode: "attack", target: 0 });
    const foe = world.create();
    world.add(foe, Transform, { x: -50, y: 0 });
    world.add(foe, Health, {});
    world.require(a, Behavior).target = foe;
    world.step(1 / 60);
    expect(Math.abs(world.require(a, Transform).rot)).toBeCloseTo(Math.PI, 1); // faces -x toward foe
  });

  it("jump verb: launches, arcs under gravity, lands with an event, no double-jump", () => {
    const world = new World(1);
    const grid = new SpatialGrid();
    const actions = registry();
    world.addSystem(actionSystem(actions)).addSystem(movementSystem(grid));
    const e = world.create();
    world.add(e, Transform, {});
    world.add(e, Velocity, {});
    expect(actions.execute(world, { actor: e, verb: "jump", params: {} }).ok).toBe(true);
    world.step(1 / 60);
    const t = world.require(e, Transform);
    expect(t.z).toBeGreaterThan(0); // airborne
    const mid = actions.execute(world, { actor: e, verb: "jump", params: {} });
    expect(mid.ok).toBe(false); // no double-jump
    expect(mid.error).toContain("airborne");
    let landed = false;
    world.events.on("jump:landed", (p: any) => p.entity === e && (landed = true));
    new GameLoop(world).advance(90); // 1.5s ≫ full arc
    expect(world.require(e, Transform).z).toBe(0);
    expect(landed).toBe(true);
  });

  it("airborne entities dodge melee and projectiles", () => {
    const world = new World(1);
    const grid = new SpatialGrid();
    const actions = registry();
    world.addSystem(actionSystem(actions)).addSystem(behaviorSystem()).addSystem(movementSystem(grid))
      .addSystem(projectileSystem(grid)).addSystem(combatSystem());
    const jumper = world.create();
    world.add(jumper, Transform, { x: 30, y: 0, z: 30 }); // mid-jump
    world.add(jumper, Velocity, { vz: 100 });
    world.add(jumper, Health, { hp: 50, maxHp: 50 });
    world.add(jumper, Collider, { radius: 10 });
    const bruiser = world.create();
    world.add(bruiser, Transform, { x: 0, y: 0 });
    world.add(bruiser, Velocity, {});
    world.add(bruiser, Attack, { range: 60, damage: 10, cooldown: 0.1 });
    world.add(bruiser, Behavior, { mode: "attack", target: jumper });
    world.add(bruiser, Ranged, { speed: 800, range: 300, damage: 10, cooldown: 0.1 });
    actions.execute(world, { actor: bruiser, verb: "shoot", params: { target: jumper } });
    world.step(1 / 60);
    world.step(1 / 60);
    expect(world.require(jumper, Health).hp).toBe(50); // swing + bolt both passed beneath
  });
});

describe("player input is never auto-piloted", () => {
  it("aggro never seizes a PlayerControlled entity — behavior can't fight the stick", () => {
    const world = new World(1);
    const grid = new SpatialGrid();
    world.addSystem(aggroSystem()).addSystem(behaviorSystem()).addSystem(movementSystem(grid)).addSystem(combatSystem());
    const player = world.create();
    world.add(player, Transform, { x: 0, y: 0 });
    world.add(player, Velocity, { maxSpeed: 170 });
    world.add(player, Behavior, { mode: "idle", sightRange: 300 });
    world.add(player, Attack, {});
    world.add(player, Health, {});
    world.add(player, Faction, { id: "heroes", hostileTo: ["beasts"] });
    world.add(player, PlayerControlled, {});
    const foe = world.create();
    world.add(foe, Transform, { x: 60, y: 0 });
    world.add(foe, Health, {});
    world.add(foe, Faction, { id: "beasts", hostileTo: ["heroes"] });
    // hostile in plain sight + a hit landing on the player
    dealDamage(world, foe, player, 5);
    new GameLoop(world).advance(30);
    const b = world.require(player, Behavior);
    expect(b.mode).toBe("idle"); // no sight-acquire, no retaliation takeover
    // player velocity, written by an input controller, survives behavior
    const v = world.require(player, Velocity);
    v.vx = 170;
    world.step(1 / 60);
    expect(world.require(player, Velocity).vx).toBe(170);
  });
});

describe("combat feel — telegraphs, knockback, landing recovery", () => {
  it("AI melee winds up before damage — never a same-tick hit", () => {
    const world = new World(1);
    const grid = new SpatialGrid();
    world.addSystem(behaviorSystem()).addSystem(movementSystem(grid)).addSystem(combatSystem());
    const goblin = world.create();
    world.add(goblin, Transform, { x: 0, y: 0 });
    world.add(goblin, Velocity, {});
    world.add(goblin, Attack, { damage: 5, range: 60, cooldown: 0.5, windup: 0.35 });
    world.add(goblin, Behavior, { mode: "attack", target: 0 });
    const victim = world.create();
    world.add(victim, Transform, { x: 30, y: 0 });
    world.add(victim, Health, { hp: 50, maxHp: 50 });
    world.require(goblin, Behavior).target = victim;
    let windupTick = 0;
    let hitTick = 0;
    world.events.on("combat:windup", () => (windupTick ||= world.tick));
    world.events.on("combat:damaged", () => (hitTick ||= world.tick));
    new GameLoop(world).advance(60);
    expect(windupTick).toBeGreaterThan(0); // telegraph fired
    expect(hitTick - windupTick).toBeGreaterThanOrEqual(Math.floor(0.35 * 60) - 1); // reactable gap
    expect(world.require(victim, Health).hp).toBeLessThan(50); // and it does land
  });

  it("a windup whiffs if the target escapes before impact", () => {
    const world = new World(1);
    const grid = new SpatialGrid();
    world.addSystem(behaviorSystem()).addSystem(movementSystem(grid)).addSystem(combatSystem());
    const goblin = world.create();
    world.add(goblin, Transform, { x: 0, y: 0 });
    world.add(goblin, Velocity, { maxSpeed: 0 }); // rooted for the test
    world.add(goblin, Attack, { damage: 5, range: 40, cooldown: 0.5, windup: 0.3 });
    world.add(goblin, Behavior, { mode: "attack", target: 0 });
    const victim = world.create();
    world.add(victim, Transform, { x: 30, y: 0 });
    world.add(victim, Velocity, { maxSpeed: 300 });
    world.add(victim, Health, { hp: 50, maxHp: 50 });
    world.require(goblin, Behavior).target = victim;
    let whiffed = false;
    world.events.on("combat:windup", () => {
      world.require(victim, Velocity).vx = 300; // sprint away on the telegraph
    });
    world.events.on("combat:whiff", () => (whiffed = true));
    new GameLoop(world).advance(60);
    expect(whiffed).toBe(true);
    expect(world.require(victim, Health).hp).toBe(50); // dodge succeeded
  });

  it("hits shove the victim through the knockback channel", () => {
    const world = new World(1);
    const grid = new SpatialGrid();
    world.addSystem(movementSystem(grid));
    const attacker = world.create();
    world.add(attacker, Transform, { x: 0, y: 0 });
    const victim = world.create();
    world.add(victim, Transform, { x: 20, y: 0 });
    world.add(victim, Velocity, { maxSpeed: 0 }); // cannot walk — shove only
    world.add(victim, Health, { hp: 50, maxHp: 50 });
    dealDamage(world, attacker, victim, 5, 150);
    new GameLoop(world).advance(45); // shove + full decay (~0.6s)
    const t = world.require(victim, Transform);
    expect(t.x).toBeGreaterThan(26); // pushed away from the attacker
    expect(world.require(victim, Velocity).kx).toBe(0); // and the shove decayed out
  });

  it("landing recovery blocks bunny-hopping", () => {
    const world = new World(1);
    const grid = new SpatialGrid();
    const actions = registry();
    world.addSystem(actionSystem(actions)).addSystem(movementSystem(grid));
    const e = world.create();
    world.add(e, Transform, {});
    world.add(e, Velocity, {});
    expect(actions.execute(world, { actor: e, verb: "jump", params: {} }).ok).toBe(true);
    let landedTick = 0;
    world.events.on("jump:landed", () => (landedTick ||= world.tick));
    new GameLoop(world).advance(60); // full arc + a beat
    expect(landedTick).toBeGreaterThan(0);
    const rejump = actions.execute(world, { actor: e, verb: "jump", params: {} });
    expect(rejump.ok).toBe(false); // still in landing recovery
    expect(rejump.error).toContain("landing");
    new GameLoop(world).advance(30); // recovery (0.45s) elapses
    expect(actions.execute(world, { actor: e, verb: "jump", params: {} }).ok).toBe(true);
  });
});

describe("skirmish mode + ranged telegraphs", () => {
  it("a ranged-only enemy acquires targets, holds its band, and fires through the verb gate", async () => {
    const { Ranged, rangedCombatSystem } = await import("../systems/projectiles.js");
    const world = new World(9);
    const grid = new SpatialGrid();
    const actions = registry();
    world
      .addSystem(actionSystem(actions))
      .addSystem(aggroSystem())
      .addSystem(behaviorSystem())
      .addSystem(movementSystem(grid))
      .addSystem(rangedCombatSystem(actions))
      .addSystem(projectileSystem(grid));
    const archer = world.create();
    world.add(archer, Transform, { x: 0, y: 0 });
    world.add(archer, Velocity, { maxSpeed: 100 });
    world.add(archer, Behavior, { mode: "idle", sightRange: 400 });
    world.add(archer, Health, {});
    world.add(archer, Faction, { id: "beasts", hostileTo: ["heroes"] });
    world.add(archer, Ranged, { damage: 6, speed: 500, range: 300, cooldown: 0.4, windup: 0.3 });
    // NO Attack component — pre-fix, aggro could never acquire for this entity
    const prey = world.create();
    world.add(prey, Transform, { x: 120, y: 0 });
    world.add(prey, Health, { hp: 60, maxHp: 60 });
    world.add(prey, Collider, { radius: 10 });
    world.add(prey, Faction, { id: "heroes", hostileTo: ["beasts"] });
    let windups = 0;
    world.events.on("combat:windup", (p: any) => p.kind === "ranged" && windups++);
    new GameLoop(world).advance(240); // 4s
    const b = world.require(archer, Behavior);
    expect(b.mode).toBe("skirmish"); // acquired as a skirmisher, not melee
    expect(windups).toBeGreaterThan(0); // shots are telegraphed
    expect(world.require(prey, Health).hp).toBeLessThan(60); // and they land
    const at = world.require(archer, Transform);
    const d = Math.hypot(at.x - 120, at.y);
    expect(d).toBeGreaterThan(100); // held its distance band (pref ≈ 180)
    // verb-gated: the shots are in the action log, flagged internal
    const shots = actions.log.filter((a) => a.verb === "shoot");
    expect(shots.length).toBeGreaterThan(0);
    expect(shots.every((s) => (s as any).internal)).toBe(true);
  });
});

describe("behavior repath throttle (#20)", () => {
  it("an unreachable goal does not re-run A* every tick", () => {
    const nav = new NavGrid(32);
    // seal the goal area far beyond nearestWalkable's reach
    for (let cx = -20; cx <= 20; cx++) for (let cy = -20; cy <= 20; cy++) {
      if (Math.max(Math.abs(cx), Math.abs(cy)) >= 8) nav.blockRect(cx * 32, cy * 32, cx * 32 + 31, cy * 32 + 31);
    }
    const spy = vi.spyOn(nav, "findPath");
    const world = new World(1);
    const grid = new SpatialGrid();
    world.addSystem(behaviorSystem(nav)).addSystem(movementSystem(grid));
    const e = world.create();
    world.add(e, Transform, { x: 0, y: 0 });
    world.add(e, Velocity, { maxSpeed: 100 });
    world.add(e, Behavior, { mode: "goto", dirX: 1000, dirY: 1000 });
    new GameLoop(world).advance(60); // one second
    // throttled to the 0.5s repath cadence: ≈2 plans, not 60
    expect(spy.mock.calls.length).toBeLessThanOrEqual(4);
    spy.mockRestore();
  });
});

import { describe, expect, it } from "vitest";
import { World, GameLoop } from "../index.js";
import { ActionRegistry, actionSystem } from "../core/actions.js";
import { SpatialGrid } from "../core/spatial.js";
import { Attack, Behavior, Collider, Faction, Health, Hotbar, Inventory, Transform, Velocity } from "../components.js";
import { STANDARD_VERBS } from "../verbs.js";
import { movementSystem } from "./movement.js";
import { behaviorSystem } from "./behavior.js";
import { combatSystem } from "./combat.js";
import { Status, statusSystem, statOf } from "./status.js";
import { AreaAttack, AreaStrikeZone, areaStrikeSystem } from "./areastrike.js";

function sim() {
  const world = new World(5);
  const grid = new SpatialGrid();
  const actions = new ActionRegistry();
  for (const v of STANDARD_VERBS) actions.register(v);
  world
    .addSystem(actionSystem(actions))
    .addSystem(statusSystem())
    .addSystem(behaviorSystem())
    .addSystem(movementSystem(grid))
    .addSystem(areaStrikeSystem(grid))
    .addSystem(combatSystem());
  return { world, actions };
}

describe("items, buffs, hotbar layer", () => {
  it("use_item heals, consumes, and refuses at full health", () => {
    const { world, actions } = sim();
    const e = world.create();
    world.add(e, Transform, {});
    world.add(e, Health, { hp: 100, maxHp: 150 });
    world.add(e, Inventory, { items: [{ id: "potion", name: "Potion", qty: 2, stats: { heal: 30 } }] });
    expect(actions.execute(world, { actor: e, verb: "use_item", params: { item: "potion" } }).ok).toBe(true);
    expect(world.require(e, Health).hp).toBe(130);
    expect(world.require(e, Inventory).items[0].qty).toBe(1);
    world.require(e, Health).hp = 150;
    const full = actions.execute(world, { actor: e, verb: "use_item", params: { item: "potion" } });
    expect(full.ok).toBe(false); // don't waste it
  });

  it("buff items create timed stat multipliers that expire", () => {
    const { world, actions } = sim();
    const e = world.create();
    world.add(e, Transform, {});
    world.add(e, Inventory, {
      items: [{ id: "fury", name: "Fury Draught", qty: 1, stats: { buffDamage: 1.5, buffDuration: 0.2 } }],
    });
    actions.execute(world, { actor: e, verb: "use_item", params: { item: "fury" } });
    expect(statOf(world, e, "damage")).toBe(1.5);
    expect(world.require(e, Inventory).items.length).toBe(0); // consumed
    new GameLoop(world).advance(20); // 0.33s > duration
    expect(statOf(world, e, "damage")).toBe(1);
    expect(world.get(e, Status)!.effects.length).toBe(0);
  });

  it("damage buffs actually change combat output", () => {
    const { world, actions } = sim();
    const a = world.create();
    world.add(a, Transform, {});
    world.add(a, Velocity, {});
    world.add(a, Attack, { damage: 10, range: 60, cooldown: 5, windup: 0 });
    world.add(a, Behavior, { mode: "attack", target: 0 });
    world.add(a, Status, { effects: [{ id: "fury", stat: "damage", mult: 2, timeLeft: 10 }] });
    const v = world.create();
    world.add(v, Transform, { x: 30 });
    world.add(v, Health, { hp: 100, maxHp: 100 });
    world.require(a, Behavior).target = v;
    void actions;
    new GameLoop(world).advance(3);
    expect(world.require(v, Health).hp).toBe(80); // 10 * 2
  });
});

describe("area_strike — the telegraphed danger circle", () => {
  it("telegraphs, detonates after the fuse, and airborne targets clear it", () => {
    const { world, actions } = sim();
    const caster = world.create();
    world.add(caster, Transform, {});
    world.add(caster, AreaAttack, { damage: 25, radius: 60, delay: 0.4, range: 300, knockback: 200 });
    world.add(caster, Faction, { id: "arena" });
    const grounded = world.create();
    world.add(grounded, Transform, { x: 120, y: 0 });
    world.add(grounded, Velocity, { maxSpeed: 0 });
    world.add(grounded, Health, { hp: 50, maxHp: 50 });
    const jumper = world.create();
    world.add(jumper, Transform, { x: 120, y: 30, z: 30 }); // mid-air
    world.add(jumper, Velocity, { vz: 120 });
    world.add(jumper, Health, { hp: 50, maxHp: 50 });
    let telegraphed = false;
    let hit = false;
    world.events.on("area:telegraph", () => (telegraphed = true));
    world.events.on("area:hit", () => (hit = true));
    const res = actions.execute(world, { actor: caster, verb: "area_strike", params: { x: 120, y: 0 } });
    expect(res.ok).toBe(true);
    expect(telegraphed).toBe(true);
    world.step(1 / 60);
    expect(world.require(grounded, Health).hp).toBe(50); // fuse still burning
    new GameLoop(world).advance(30); // past the 0.4s fuse
    expect(hit).toBe(true);
    expect(world.require(grounded, Health).hp).toBe(25); // caught it
    expect(world.require(jumper, Health).hp).toBe(50); // jumped it
    expect([...world.each(AreaStrikeZone)].length).toBe(0); // zone cleaned up
    // cooldown gates the next one
    expect(actions.execute(world, { actor: caster, verb: "area_strike", params: { x: 0, y: 0 } }).ok).toBe(false);
  });

  it("respects range and requires the capability component", () => {
    const { world, actions } = sim();
    const nobody = world.create();
    world.add(nobody, Transform, {});
    expect(actions.execute(world, { actor: nobody, verb: "area_strike", params: { x: 0, y: 0 } }).ok).toBe(false);
    const caster = world.create();
    world.add(caster, Transform, {});
    world.add(caster, AreaAttack, { range: 100 });
    const far = actions.execute(world, { actor: caster, verb: "area_strike", params: { x: 500, y: 0 } });
    expect(far.ok).toBe(false);
    expect(far.error).toContain("range");
  });
});

describe("hotbar component", () => {
  it("is plain data on ALL_COMPONENTS-style entities", () => {
    const { world } = sim();
    const e = world.create();
    world.add(e, Hotbar, { slots: ["potion", "fury"] });
    expect(world.require(e, Hotbar).slots[1]).toBe("fury");
  });
});

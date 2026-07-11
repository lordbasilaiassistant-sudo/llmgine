import { describe, expect, it } from "vitest";
import { World } from "../core/ecs.js";
import { GameLoop } from "../core/loop.js";
import { SpatialGrid } from "../core/spatial.js";
import { ActionRegistry, actionSystem } from "../core/actions.js";
import {
  Attack, Behavior, Collider, Faction, Health, Inventory, LootDrop, Named, Pickup, Speech, Transform, Velocity,
} from "../components.js";
import { STANDARD_VERBS } from "../verbs.js";
import { movementSystem, collisionSystem, speechSystem } from "./movement.js";
import { behaviorSystem, aggroSystem } from "./behavior.js";
import { combatSystem, dealDamage } from "./combat.js";
import { LootTables, lootSystem } from "./loot.js";
import { QuestLog, offerQuest, questSystem } from "./quest.js";

/**
 * The Phase 3 acceptance test: a complete PvE loop — aggro, combat, death,
 * loot drop, pickup, quest completion — running deterministically with NO
 * LLM anywhere. This is the "game works with the API down" guarantee.
 */

function buildWorld() {
  const world = new World(777);
  const grid = new SpatialGrid();
  const actions = new ActionRegistry();
  for (const v of STANDARD_VERBS) actions.register(v);
  const loot = new LootTables().define({
    name: "goblin-drops",
    rolls: [2, 2],
    items: [
      { id: "gold", name: "Gold Coin", weight: 5, qty: [3, 8] },
      { id: "dagger", name: "Rusty Dagger", weight: 1, stats: { damage: 4 } },
    ],
  });
  world
    .addSystem(actionSystem(actions))
    .addSystem(aggroSystem())
    .addSystem(behaviorSystem())
    .addSystem(movementSystem(grid))
    .addSystem(collisionSystem(grid))
    .addSystem(combatSystem())
    .addSystem(lootSystem(loot))
    .addSystem(questSystem())
    .addSystem(speechSystem());

  const hero = world.create();
  world.add(hero, Transform, { x: 0, y: 0 });
  world.add(hero, Velocity, { maxSpeed: 150 });
  world.add(hero, Collider);
  world.add(hero, Health, { hp: 500, maxHp: 500 });
  world.add(hero, Faction, { id: "heroes", hostileTo: ["monsters"] });
  world.add(hero, Attack, { damage: 40, range: 34, cooldown: 0.5 });
  world.add(hero, Inventory);
  world.add(hero, Behavior, { mode: "idle" });
  world.add(hero, Named, { name: "Hero" });
  world.add(hero, Speech);
  world.add(hero, QuestLog);

  const goblin = world.create();
  world.add(goblin, Transform, { x: 120, y: 0 });
  world.add(goblin, Velocity, { maxSpeed: 90 });
  world.add(goblin, Collider);
  world.add(goblin, Health, { hp: 60, maxHp: 60 });
  world.add(goblin, Faction, { id: "monsters", hostileTo: ["heroes"] });
  world.add(goblin, Attack, { damage: 5, range: 30, cooldown: 1 });
  world.add(goblin, Behavior, { mode: "wander", sightRange: 200 });
  world.add(goblin, Named, { name: "Goblin" });
  world.add(goblin, LootDrop, { table: "goblin-drops" });

  return { world, grid, actions, loot, hero, goblin };
}

describe("gameplay: full PvE loop with zero LLM", () => {
  it("aggro → combat → death → loot → pickup → quest complete", () => {
    const { world, actions, hero, goblin } = buildWorld();
    const loop = new GameLoop(world);

    offerQuest(world, hero, {
      id: "cull",
      name: "Cull the Goblins",
      objectives: [{ kind: "kill", match: "monsters", count: 1, label: "Slay a goblin" }],
      rewards: { items: [{ id: "potion", name: "Healing Potion", qty: 2 }] },
    });

    const deaths: any[] = [];
    world.events.on("combat:death", (p) => deaths.push(p));

    // the goblin should aggro the hero on sight and attack; the hero fights back via player intent
    actions.submit({ actor: hero, verb: "attack", params: { target: goblin } });
    loop.advance(60 * 10); // 10 seconds of sim

    expect(deaths).toHaveLength(1);
    expect(deaths[0].entity).toBe(goblin);
    expect(world.isAlive(goblin)).toBe(false);
    expect(world.require(hero, Health).hp).toBeLessThan(500); // goblin fought back (aggro worked)

    // loot dropped as pickups near the corpse
    const pickups = [...world.query(Pickup)];
    expect(pickups.length).toBeGreaterThan(0);

    // walk over and pick everything up
    for (const p of pickups) {
      const pt = world.require(p, Transform);
      actions.submit({ actor: hero, verb: "move_to", params: { x: pt.x, y: pt.y } });
      loop.advance(60 * 3);
      actions.submit({ actor: hero, verb: "pickup", params: { target: p } });
      loop.advance(2);
    }
    const inv = world.require(hero, Inventory);
    expect(inv.items.length).toBeGreaterThan(0);

    // quest completed + rewards granted
    const log = world.require(hero, QuestLog);
    expect(log.active[0].state).toBe("completed");
    expect(inv.items.find((i) => i.id === "potion")?.qty).toBe(2);
  });

  it("PvP: two player-faction fighters, same combat path", () => {
    const { world, actions } = buildWorld();
    const mk = (x: number, name: string) => {
      const e = world.create();
      world.add(e, Transform, { x, y: 100 });
      world.add(e, Velocity, { maxSpeed: 100 });
      world.add(e, Health, { hp: 80, maxHp: 80 });
      world.add(e, Attack, { damage: 20, range: 30, cooldown: 0.4 });
      world.add(e, Behavior, { mode: "idle" });
      world.add(e, Named, { name });
      return e;
    };
    const p1 = mk(0, "P1");
    const p2 = mk(50, "P2");
    actions.submit({ actor: p1, verb: "attack", params: { target: p2 } });
    actions.submit({ actor: p2, verb: "attack", params: { target: p1 } });
    new GameLoop(world).advance(60 * 8);
    // exactly one should be dead (equal stats, someone lands the last hit)
    expect([world.isAlive(p1), world.isAlive(p2)].filter(Boolean)).toHaveLength(1);
  });

  it("loot tables are deterministic under the world seed", () => {
    const roll = () => {
      const { world, loot } = buildWorld();
      return JSON.stringify(loot.roll("goblin-drops", world.rng));
    };
    expect(roll()).toBe(roll());
  });

  it("dealDamage respects iframes and emits no double-death", () => {
    const { world, hero, goblin } = buildWorld();
    let deaths = 0;
    world.events.on("combat:death", () => deaths++);
    world.step(1 / 60);
    dealDamage(world, hero, goblin, 60);
    dealDamage(world, hero, goblin, 60); // dead already
    expect(deaths).toBe(1);
  });
});

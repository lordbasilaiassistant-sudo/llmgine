import { describe, expect, it } from "vitest";
import { World } from "../core/ecs.js";
import { GameLoop } from "../core/loop.js";
import { SpatialGrid } from "../core/spatial.js";
import { ActionRegistry, actionSystem } from "../core/actions.js";
import { Faction, Health, Transform, Velocity } from "../components.js";
import { movementSystem } from "./movement.js";
import { Projectile, Ranged, projectileSystem, shootVerb } from "./projectiles.js";

function setup() {
  const world = new World(3);
  const grid = new SpatialGrid();
  const actions = new ActionRegistry().register(shootVerb);
  world
    .addSystem(actionSystem(actions))
    .addSystem(movementSystem(grid))
    .addSystem(projectileSystem(grid));
  const archer = world.create();
  world.add(archer, Transform, { x: 0, y: 0 });
  world.add(archer, Ranged, { damage: 10, speed: 400, range: 300, cooldown: 0.4 });
  world.add(archer, Faction, { id: "a", hostileTo: ["b"] });
  const mk = (x: number, faction: string) => {
    const e = world.create();
    world.add(e, Transform, { x, y: 0 });
    world.add(e, Health, { hp: 20, maxHp: 20 });
    world.add(e, Faction, { id: faction, hostileTo: [] });
    return e;
  };
  return { world, actions, archer, mk };
}

describe("projectiles", () => {
  it("shoot verb spawns a projectile that hits a hostile target in range", () => {
    const { world, actions, archer, mk } = setup();
    const target = mk(200, "b");
    const res = actions.execute(world, { actor: archer, verb: "shoot", params: { target } });
    expect(res.ok).toBe(true);
    new GameLoop(world).advance(60);
    expect(world.require(target, Health).hp).toBe(10);
    expect([...world.query(Projectile)]).toHaveLength(0); // consumed on hit
  });

  it("respects range (expires) and cooldown", () => {
    const { world, actions, archer } = setup();
    expect(actions.execute(world, { actor: archer, verb: "shoot", params: { x: 900, y: 0 } }).ok).toBe(true);
    expect(actions.execute(world, { actor: archer, verb: "shoot", params: { x: 900, y: 0 } }).error).toBe("not ready");
    new GameLoop(world).advance(90);
    expect([...world.query(Projectile)]).toHaveLength(0); // expired at ~300u, no crash
  });

  it("never hits same-faction entities (no friendly fire)", () => {
    const { world, actions, archer, mk } = setup();
    const friend = mk(150, "a");
    const enemy = mk(280, "b");
    actions.execute(world, { actor: archer, verb: "shoot", params: { target: enemy } });
    new GameLoop(world).advance(60);
    expect(world.require(friend, Health).hp).toBe(20);
    expect(world.require(enemy, Health).hp).toBe(10);
  });

  it("entities without Ranged cannot shoot (Mind capability gate)", () => {
    const { world, actions, mk } = setup();
    const unarmed = mk(0, "a");
    expect(actions.execute(world, { actor: unarmed, verb: "shoot", params: { x: 1, y: 1 } }).error).toMatch(/no Ranged/);
  });
});

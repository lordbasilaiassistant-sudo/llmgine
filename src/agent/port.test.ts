import { describe, expect, it } from "vitest";
import { World, GameLoop } from "../index.js";
import { ActionRegistry, actionSystem } from "../core/actions.js";
import { SpatialGrid } from "../core/spatial.js";
import { Behavior, Health, Named, Speech, Transform, Velocity } from "../components.js";
import { STANDARD_VERBS } from "../verbs.js";
import { behaviorSystem } from "../systems/behavior.js";
import { movementSystem } from "../systems/movement.js";
import { AgentPort } from "./port.js";

/** #35 — the Agent Play Protocol: agents pilot games like Minds do. */

function game() {
  const world = new World(11);
  const grid = new SpatialGrid();
  const actions = new ActionRegistry();
  for (const v of STANDARD_VERBS) actions.register(v);
  world.addSystem(actionSystem(actions)).addSystem(behaviorSystem()).addSystem(movementSystem(grid));
  const hero = world.create();
  world.add(hero, Transform, { x: 0, y: 0 });
  world.add(hero, Velocity, { maxSpeed: 120 });
  world.add(hero, Behavior, { mode: "idle" });
  world.add(hero, Speech, {});
  world.add(hero, Named, { name: "Hero" });
  world.add(hero, Health, {});
  const loop = new GameLoop(world);
  const port = new AgentPort({ world, loop, actions, grid, avatar: hero });
  world.addSystem(port.system());
  return { world, loop, port, hero };
}

describe("AgentPort", () => {
  it("observe → act → step: an agent can play the game", () => {
    const { port } = game();
    const before = port.observe();
    expect(before.self?.self.name).toBe("Hero");
    const res = port.act("move_to", { x: 100, y: 0 });
    expect(res.ok).toBe(true);
    const after = port.step(120); // 2 seconds, deterministic
    expect(after.tick).toBe(before.tick + 120);
    const heroRow = after.census.find((c: any) => c.name === "Hero");
    expect(heroRow.x).toBeGreaterThan(80); // it actually walked
  });

  it("rejected actions land in the actionLog with a reason", () => {
    const { port } = game();
    const res = port.act("move_to", { x: "garbage" as any, y: 0 });
    expect(res.ok).toBe(false);
    const log = port.actionLog();
    expect(log[log.length - 1].ok).toBe(false);
    expect(log[log.length - 1].error).toBeTruthy();
  });

  it("events ring buffer captures the journal across ticks", () => {
    const { port } = game();
    port.act("say", { text: "hello arena" });
    port.step(2);
    const evs = port.events();
    expect(evs.some((e) => e.type === "speech")).toBe(true);
  });

  it("state() exposes all components as plain data", () => {
    const { port } = game();
    const s = port.state();
    expect(s.Transform).toBeDefined();
    expect(s.Health).toBeDefined();
    expect(() => JSON.stringify(s)).not.toThrow();
  });

  it("pause stops real-time frames; step still advances", () => {
    const { port, loop, world } = game();
    port.pause();
    const t = world.tick;
    loop.frame(1000);
    loop.frame(2000);
    expect(world.tick).toBe(t); // paused: real time ignored
    port.step(5);
    expect(world.tick).toBe(t + 5);
  });
});

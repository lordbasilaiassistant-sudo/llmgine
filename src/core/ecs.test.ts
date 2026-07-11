import { describe, expect, it } from "vitest";
import { World } from "./ecs.js";
import { SpatialGrid } from "./spatial.js";
import { GameLoop } from "./loop.js";
import { Transform, Velocity } from "../components.js";
import { movementSystem } from "../systems/movement.js";

describe("ECS", () => {
  it("creates, queries, and destroys entities", () => {
    const w = new World();
    const a = w.create();
    const b = w.create();
    w.add(a, Transform, { x: 5 });
    w.add(a, Velocity);
    w.add(b, Transform);
    expect([...w.query(Transform)]).toHaveLength(2);
    expect([...w.query(Transform, Velocity)]).toEqual([a]);
    w.destroy(a);
    w.step(1 / 60); // deferred destroy applies at end of step
    expect(w.isAlive(a)).toBe(false);
    expect([...w.query(Transform)]).toEqual([b]);
  });

  it("journals in-tick events per tick; off-tick events land in the NEXT tick", () => {
    const w = new World();
    let heard = 0;
    w.events.on("boom", () => heard++);
    w.addSystem({
      name: "boomer",
      update: ({ world, tick }) => {
        if (tick === 1) world.events.emit("in-tick", {});
      },
    });
    w.step(1 / 60);
    expect(w.events.journal.some((j) => j.type === "in-tick")).toBe(true);

    // emitted between ticks (e.g. player input handler)
    w.events.emit("boom", { power: 9 });
    expect(heard).toBe(1); // listeners always fire immediately
    w.step(1 / 60);
    expect(w.events.journal.some((j) => j.type === "boom")).toBe(true); // visible to systems this tick
    expect(w.events.journal.some((j) => j.type === "in-tick")).toBe(false); // old tick cleared
    w.step(1 / 60);
    expect(w.events.journal.some((j) => j.type === "boom")).toBe(false);
  });

  it("saves and loads a world snapshot", () => {
    const w = new World(42);
    const e = w.create();
    w.add(e, Transform, { x: 10, y: 20 });
    w.rng.next();
    const snap = w.save();

    const w2 = new World();
    w2.load(structuredClone(snap), [Transform]);
    expect(w2.require(e, Transform).x).toBe(10);
    expect(w2.rng.next()).toBe(w.rng.next()); // rng state restored
  });

  it("is deterministic: same seed + 1000 ticks = identical state", () => {
    const run = () => {
      const w = new World(1234);
      const grid = new SpatialGrid();
      w.addSystem(movementSystem(grid, { minX: -500, minY: -500, maxX: 500, maxY: 500 }));
      for (let i = 0; i < 50; i++) {
        const e = w.create();
        w.add(e, Transform, { x: w.rng.int(-400, 400), y: w.rng.int(-400, 400) });
        w.add(e, Velocity, { vx: w.rng.int(-100, 100), vy: w.rng.int(-100, 100) });
      }
      const loop = new GameLoop(w);
      loop.advance(1000);
      return JSON.stringify(w.save());
    };
    expect(run()).toBe(run());
  });
});

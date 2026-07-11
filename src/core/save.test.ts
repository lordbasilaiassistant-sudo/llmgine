import { describe, expect, it } from "vitest";
import { World } from "./ecs.js";
import { GameLoop } from "./loop.js";
import { SpatialGrid } from "./spatial.js";
import { ALL_COMPONENTS, Health, Transform, Velocity } from "../components.js";
import { movementSystem } from "../systems/movement.js";
import { MemoryStorage, SaveStore } from "./save.js";

describe("SaveStore", () => {
  it("round-trips a world through a named slot, resuming deterministically", async () => {
    const store = new SaveStore(new MemoryStorage(), ALL_COMPONENTS);
    const mkWorld = () => {
      const w = new World(11);
      w.addSystem(movementSystem(new SpatialGrid()));
      return w;
    };
    const w1 = mkWorld();
    const e = w1.create();
    w1.add(e, Transform, { x: 5 });
    w1.add(e, Velocity, { vx: 60 });
    w1.add(e, Health, { hp: 77, maxHp: 100 });
    new GameLoop(w1).advance(120);
    await store.save("slot-a", w1, { name: "Camp before the boss" });

    // keep simulating the original; the save must not be affected
    new GameLoop(w1).advance(300);

    const w2 = mkWorld();
    const meta = await store.load("slot-a", w2);
    expect(meta.name).toBe("Camp before the boss");
    expect(w2.tick).toBe(120);
    expect(w2.require(e, Health).hp).toBe(77);
    // both continue identically from the restore point (same rng + state)
    const w3 = mkWorld();
    await store.load("slot-a", w3);
    new GameLoop(w2).advance(200);
    new GameLoop(w3).advance(200);
    expect(JSON.stringify(w2.save())).toBe(JSON.stringify(w3.save()));
  });

  it("lists slots with metadata and skips corrupt ones", async () => {
    const mem = new MemoryStorage();
    const store = new SaveStore(mem, ALL_COMPONENTS);
    const w = new World(1);
    await store.save("one", w, { area: "pit" });
    await store.save("two", w);
    mem.set("llmgine.save.bad", "{not json");
    const slots = await store.list();
    expect(slots.map((s) => s.slot).sort()).toEqual(["one", "two"]);
    expect(slots.find((s) => s.slot === "one")!.meta.area).toBe("pit");
    await store.remove("one");
    expect((await store.list()).map((s) => s.slot)).toEqual(["two"]);
  });

  it("throws a clear error for missing slots", async () => {
    const store = new SaveStore(new MemoryStorage(), ALL_COMPONENTS);
    await expect(store.load("nope", new World())).rejects.toThrow(/no save in slot/);
  });
});

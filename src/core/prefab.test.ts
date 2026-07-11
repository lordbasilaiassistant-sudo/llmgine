import { describe, expect, it } from "vitest";
import { World } from "./ecs.js";
import { PrefabRegistry } from "./prefab.js";
import { ALL_COMPONENTS, Health, Named, Transform } from "../components.js";

describe("prefabs", () => {
  const registry = () => new PrefabRegistry().registerComponents(ALL_COMPONENTS);

  it("defines and spawns a prefab with overrides", () => {
    const r = registry();
    r.define({
      name: "goblin",
      components: {
        Named: { name: "Goblin" },
        Transform: {},
        Health: { hp: 30, maxHp: 30 },
      },
    });
    const w = new World();
    const e = r.spawn(w, "goblin", { Transform: { x: 99 } });
    expect(w.require(e, Named).name).toBe("Goblin");
    expect(w.require(e, Transform).x).toBe(99);
    expect(w.require(e, Health).hp).toBe(30);
  });

  it("supports extends with deep merge", () => {
    const r = registry();
    r.define({ name: "creature", components: { Health: { hp: 50, maxHp: 50 }, Transform: {} } });
    r.define({ name: "boss", extends: "creature", components: { Health: { hp: 500, maxHp: 500 }, Named: { name: "Boss" } } });
    const w = new World();
    const e = r.spawn(w, "boss");
    expect(w.require(e, Health).maxHp).toBe(500);
    expect(w.has(e, Transform)).toBe(true); // inherited
  });

  it("rejects unknown components — the Genesis validation gate", () => {
    const r = registry();
    expect(() =>
      r.define({ name: "bad", components: { Teleporter: { range: 9999 } } }),
    ).toThrow(/unknown component "Teleporter"/);
  });

  it("rejects malformed prefab JSON", () => {
    const r = registry();
    expect(() => r.define({ components: {} })).toThrow();
    expect(() => r.define({ name: "x", extends: "nope", components: {} })).toThrow(/unknown prefab/);
  });
});

import { describe, expect, it } from "vitest";
import { PrefabRegistry } from "../core/prefab.js";
import { ALL_COMPONENTS } from "../components.js";
import { Genesis, extractJSON } from "./genesis.js";
import { MockProvider } from "./provider.js";

const goodPrefab = JSON.stringify({
  name: "cave-troll",
  components: {
    Named: { name: "Cave Troll", blurb: "hulking and slow" },
    Health: { hp: 300, maxHp: 300 },
    Transform: {},
  },
});

describe("genesis", () => {
  it("generates, validates, and registers a prefab (fenced output tolerated)", async () => {
    const provider = new MockProvider([{ text: "```json\n" + goodPrefab + "\n```" }]);
    const prefabs = new PrefabRegistry().registerComponents(ALL_COMPONENTS);
    const g = new Genesis({ provider, prefabs });
    const prefab = await g.generatePrefab("a big slow troll");
    expect(prefab.name).toBe("cave-troll");
    expect(prefabs.get("cave-troll")).toBeDefined();
    // component catalog was included in the prompt
    expect(String(provider.calls[0].messages[1].content)).toContain("Health: keys hp, maxHp");
  });

  it("feeds validation errors back and retries", async () => {
    const bad = JSON.stringify({ name: "x", components: { Teleporter: {} } });
    const provider = new MockProvider([{ text: bad }, { text: goodPrefab }]);
    const prefabs = new PrefabRegistry().registerComponents(ALL_COMPONENTS);
    const g = new Genesis({ provider, prefabs });
    const prefab = await g.generatePrefab("troll");
    expect(prefab.name).toBe("cave-troll");
    expect(provider.calls).toHaveLength(2);
    expect(String(provider.calls[1].messages[1].content)).toContain("rejected");
  });

  it("gives up with a useful error after retries exhausted", async () => {
    const provider = new MockProvider([{ text: "not json" }, { text: "still no" }, { text: "nope" }]);
    const prefabs = new PrefabRegistry().registerComponents(ALL_COMPONENTS);
    const g = new Genesis({ provider, prefabs, retries: 2 });
    await expect(g.generatePrefab("troll")).rejects.toThrow(/failed after 3 attempts/);
  });

  it("caches identical generation requests", async () => {
    const provider = new MockProvider([{ text: goodPrefab }]);
    const prefabs = new PrefabRegistry().registerComponents(ALL_COMPONENTS);
    const g = new Genesis({ provider, prefabs });
    await g.generatePrefab("a big slow troll");
    await g.generatePrefab("a big slow troll"); // second call: cache hit, no provider call
    expect(provider.calls).toHaveLength(1);
  });

  it("extractJSON finds objects inside noisy replies", () => {
    expect(extractJSON('Sure! Here you go: {"a":1} hope that helps')).toEqual({ a: 1 });
    expect(() => extractJSON("no json here")).toThrow(/no JSON/);
  });
});

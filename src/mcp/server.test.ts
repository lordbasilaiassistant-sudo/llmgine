import { beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

/**
 * Headless MCP server test — real client ↔ server over an in-memory
 * transport, no stdio subprocess, no network. Env keys are cleared BEFORE the
 * server module is imported so `hasKey` is false and no CognitionDriver ever
 * dials out (unit tests must stay offline).
 */

let client: Client;

function parse(res: any): any {
  expect(res.isError ?? false).toBe(false);
  return JSON.parse(res.content[0].text);
}

async function call(name: string, args: Record<string, unknown> = {}) {
  return client.callTool({ name, arguments: args });
}

beforeAll(async () => {
  delete process.env.ZAI_API_KEY;
  delete process.env.LLM_API_KEY;
  const { buildServer } = await import("./server.js");
  const server = buildServer();
  client = new Client({ name: "llmgine-test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

describe("llmgine MCP server", () => {
  it("exposes the full toolset", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    for (const expected of [
      "create_world", "define_prefab", "define_loot_table", "list_prefabs", "spawn",
      "attach_mind", "act", "run", "query_world", "save_world", "load_world",
      "destroy_world", "generate_prefab",
    ]) {
      expect(names).toContain(expected);
    }
  });

  it("creates bounded worlds — movement clamps at the world edge", async () => {
    const { worldId } = parse(await call("create_world", { seed: 7 }));
    parse(await call("define_prefab", {
      worldId,
      prefab: { name: "runner", components: { Transform: { x: 0, y: 0 }, Velocity: { vx: 500, vy: 0, maxSpeed: 500 } } },
    }));
    const { entity } = parse(await call("spawn", { worldId, prefab: "runner" }));
    // 600 ticks = 10 s @ 500 u/s = 5000 units unbounded; default bounds cap at +1000
    parse(await call("run", { worldId, ticks: 600 }));
    const entities = parse(await call("query_world", { worldId }));
    const runner = entities.find((e: any) => e.id === entity);
    expect(runner.position.x).toBeLessThanOrEqual(1000);
    expect(runner.position.x).toBeGreaterThan(900); // it really ran to the wall
  });

  it("attach_mind puts a Mind on an existing entity and reports capability gaps", async () => {
    const { worldId } = parse(await call("create_world", { seed: 3 }));
    parse(await call("define_prefab", {
      worldId,
      prefab: { name: "statue", components: { Transform: { x: 5, y: 5 }, Named: { name: "Old Statue" } } },
    }));
    const { entity } = parse(await call("spawn", { worldId, prefab: "statue" }));
    const res = parse(await call("attach_mind", {
      worldId, entity, persona: "An ancient statue that judges passersby.", goals: ["observe"],
    }));
    expect(res.ok).toBe(true);
    expect(res.entity.hasMind).toBe(true);
    expect(res.llm).toContain("disabled");
    // statue has no Speech/Behavior — the tool must say what it can't do
    expect(res.warning).toContain("no Speech");
    expect(res.warning).toContain("no Behavior");

    const bogus = await call("attach_mind", { worldId, entity: 9999, persona: "ghost" });
    expect(bogus.isError).toBe(true);
    expect((bogus.content as any)[0].text).toContain("no such entity");
  });

  it("list_prefabs returns registered templates", async () => {
    const { worldId } = parse(await call("create_world", {}));
    parse(await call("define_prefab", {
      worldId,
      prefab: { name: "goblin", components: { Transform: {}, Health: { hp: 20, maxHp: 20 } } },
    }));
    const prefabs = parse(await call("list_prefabs", { worldId }));
    expect(prefabs.map((p: any) => p.name)).toContain("goblin");
  });

  it("save_world / load_world round-trips full world state as a JSON string", async () => {
    const { worldId } = parse(await call("create_world", { seed: 11 }));
    parse(await call("define_prefab", {
      worldId,
      prefab: { name: "hero", components: { Transform: { x: 42, y: -7 }, Named: { name: "Hero" }, Health: { hp: 55, maxHp: 100 } } },
    }));
    parse(await call("spawn", { worldId, prefab: "hero" }));
    const saveRes = await call("save_world", { worldId });
    const snapshot = (saveRes.content as any)[0].text as string;
    expect(() => JSON.parse(snapshot)).not.toThrow();

    // mutate: extra entity + time passes
    parse(await call("spawn", { worldId, prefab: "hero" }));
    parse(await call("run", { worldId, ticks: 60 }));
    expect(parse(await call("query_world", { worldId })).length).toBe(2);

    // restore
    const loaded = parse(await call("load_world", { worldId, snapshot }));
    expect(loaded.entities).toBe(1);
    const entities = parse(await call("query_world", { worldId }));
    expect(entities.length).toBe(1);
    expect(entities[0].name).toBe("Hero");
    expect(entities[0].health.hp).toBe(55);
    expect(entities[0].position).toEqual({ x: 42, y: -7 });

    const bad = await call("load_world", { worldId, snapshot: "not json" });
    expect(bad.isError).toBe(true);

    // a "shaped" but truncated snapshot must be rejected too — nextEntity:
    // undefined would make every future create() return NaN
    const truncated = { ...JSON.parse(snapshot) };
    delete truncated.nextEntity;
    const bad2 = await call("load_world", { worldId, snapshot: JSON.stringify(truncated) });
    expect(bad2.isError).toBe(true);
    expect((bad2.content as any)[0].text).toContain("nextEntity");
  });

  it("run's event window survives the 500-event ring cap", async () => {
    const { worldId } = parse(await call("create_world", { seed: 5 }));
    parse(await call("define_prefab", {
      worldId,
      prefab: { name: "crier", components: { Transform: {}, Speech: {} } },
    }));
    const { entity } = parse(await call("spawn", { worldId, prefab: "crier" }));
    // pin the ring at its cap: every push now pairs with a shift, so
    // events.length stays constant — a length-based window sees nothing
    for (let i = 0; i < 505; i++) {
      await call("act", { worldId, actor: entity, verb: "say", params: { text: `cry ${i}` } });
    }
    // two hostiles generate combat events DURING the run window
    const brawler = (id: string, foe: string, x: number) => ({
      name: `brawler-${id}`,
      components: {
        Transform: { x, y: 0 },
        Velocity: { maxSpeed: 100 },
        Health: { hp: 500, maxHp: 500 },
        Attack: { damage: 5, range: 60, cooldown: 0.5 },
        Behavior: { mode: "idle", sightRange: 300 },
        Faction: { id, hostileTo: [foe] },
      },
    });
    parse(await call("define_prefab", { worldId, prefab: brawler("red", "blue", -20) }));
    parse(await call("define_prefab", { worldId, prefab: brawler("blue", "red", 20) }));
    parse(await call("spawn", { worldId, prefab: "brawler-red" }));
    parse(await call("spawn", { worldId, prefab: "brawler-blue" }));
    const res = parse(await call("run", { worldId, ticks: 600 }));
    expect(res.events.some((e: any) => e.type === "combat:damaged")).toBe(true);
  });

  it("destroy_world frees the session and later calls fail with known worlds listed", async () => {
    const { worldId } = parse(await call("create_world", {}));
    const res = parse(await call("destroy_world", { worldId }));
    expect(res.destroyed).toBe(worldId);
    const gone = await call("query_world", { worldId });
    expect(gone.isError).toBe(true);
    expect((gone.content as any)[0].text).toContain("unknown world");
  });

  it("act validation errors name the missing component (coupling is discoverable)", async () => {
    const { worldId } = parse(await call("create_world", {}));
    parse(await call("define_prefab", {
      worldId,
      prefab: { name: "rock", components: { Transform: {} } },
    }));
    const { entity } = parse(await call("spawn", { worldId, prefab: "rock" }));
    const res = parse(await call("act", { worldId, actor: entity, verb: "move_to", params: { x: 10, y: 10 } }));
    expect(res.ok).toBe(false);
    expect(res.error).toContain("Behavior");
  });
});

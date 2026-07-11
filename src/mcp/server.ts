#!/usr/bin/env node
/**
 * llmgine MCP server — the engine as an agent tool.
 *
 * An AI agent (Claude Code, etc.) can build and simulate games headlessly:
 * define prefabs, spawn entities, attach LLM minds, advance the sim, and
 * read back what happened. Run: `npx llmgine-mcp` (or node dist/mcp/server.js).
 * Set ZAI_API_KEY (or LLM_API_KEY + LLM_BASE_URL) to enable minds/genesis.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { World } from "../core/ecs.js";
import { GameLoop } from "../core/loop.js";
import { SpatialGrid } from "../core/spatial.js";
import { ActionRegistry, actionSystem } from "../core/actions.js";
import { PrefabRegistry } from "../core/prefab.js";
import {
  ALL_COMPONENTS, Named, Transform, Health, Faction, Inventory, Speech, Behavior,
} from "../components.js";
import { STANDARD_VERBS } from "../verbs.js";
import {
  movementSystem, collisionSystem, speechSystem, behaviorSystem, aggroSystem,
  combatSystem, LootTables, lootSystem, questSystem,
} from "../systems/index.js";
import { QuestLog } from "../systems/quest.js";
import { Mind, MindMemory } from "../ai/mind.js";
import { CognitionDriver } from "../ai/cognition.js";
import { OpenAICompatibleProvider } from "../ai/provider.js";
import { Genesis } from "../ai/genesis.js";

interface Session {
  world: World;
  loop: GameLoop;
  actions: ActionRegistry;
  prefabs: PrefabRegistry;
  loot: LootTables;
  driver: CognitionDriver | null;
  events: Array<{ type: string; payload: any; tick: number }>;
}

const sessions = new Map<string, Session>();
let nextId = 1;
const hasKey = !!(process.env.ZAI_API_KEY || process.env.LLM_API_KEY);

const AI_COMPONENTS = [Mind, MindMemory, QuestLog];

function createSession(seed: number): string {
  const id = `world-${nextId++}`;
  const world = new World(seed);
  const grid = new SpatialGrid();
  const actions = new ActionRegistry();
  for (const v of STANDARD_VERBS) actions.register(v);
  const prefabs = new PrefabRegistry().registerComponents([...ALL_COMPONENTS, ...AI_COMPONENTS]);
  const loot = new LootTables();
  let driver: CognitionDriver | null = null;
  if (hasKey) {
    driver = new CognitionDriver({ provider: new OpenAICompatibleProvider(), actions, grid });
  }
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
  if (driver) world.addSystem(driver.system());

  const events: Session["events"] = [];
  for (const type of ["speech", "combat:damaged", "combat:death", "loot:dropped", "quest:completed", "item:pickup", "entity:spawned"]) {
    world.events.on(type, (payload) => {
      events.push({ type, payload: JSON.parse(JSON.stringify(payload ?? {})), tick: world.tick });
      if (events.length > 500) events.shift();
    });
  }
  sessions.set(id, { world, loop: new GameLoop(world), actions, prefabs, loot, driver, events });
  return id;
}

function getSession(id: string): Session {
  const s = sessions.get(id);
  if (!s) throw new Error(`unknown world "${id}" — call create_world first`);
  return s;
}

function describeEntity(s: Session, e: number) {
  const { world } = s;
  return {
    id: e,
    name: world.get(e, Named)?.name,
    position: world.get(e, Transform) ? { x: Math.round(world.require(e, Transform).x), y: Math.round(world.require(e, Transform).y) } : undefined,
    health: world.get(e, Health),
    faction: world.get(e, Faction)?.id,
    behavior: world.get(e, Behavior)?.mode,
    hasMind: world.has(e, Mind),
    inventory: world.get(e, Inventory)?.items,
    saying: world.get(e, Speech)?.text || undefined,
  };
}

const server = new McpServer({ name: "llmgine", version: "0.1.0" });
const text = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });

server.tool(
  "create_world",
  "Create a new headless game world (deterministic ECS sim). Returns a worldId for the other tools.",
  { seed: z.number().int().default(1).describe("RNG seed — same seed = same world") },
  async ({ seed }) => text({ worldId: createSession(seed), llm: hasKey ? "enabled (minds will think)" : "disabled (no ZAI_API_KEY — deterministic fallbacks only)" }),
);

server.tool(
  "define_prefab",
  "Register an entity template (JSON). Components: Transform{x,y}, Velocity{maxSpeed}, Collider{radius}, Sprite{kind,color,size}, Named{name,blurb}, Health{hp,maxHp}, Faction{id,hostileTo[]}, Attack{damage,range,cooldown}, Inventory, LootDrop{table}, Behavior{mode,sightRange}, Speech, Mind{persona,goals,thinkEvery,verbs,fallbackMode}, MindMemory, QuestLog.",
  {
    worldId: z.string(),
    prefab: z.object({ name: z.string(), extends: z.string().optional(), components: z.record(z.string(), z.record(z.string(), z.any())) }),
  },
  async ({ worldId, prefab }) => {
    const s = getSession(worldId);
    s.prefabs.define(prefab);
    return text({ ok: true, registered: prefab.name });
  },
);

server.tool(
  "define_loot_table",
  "Register a weighted loot table; entities with LootDrop{table} spill these items on death.",
  {
    worldId: z.string(),
    table: z.object({
      name: z.string(),
      rolls: z.tuple([z.number().int(), z.number().int()]),
      chance: z.number().optional(),
      items: z.array(z.object({ id: z.string(), name: z.string(), weight: z.number(), qty: z.tuple([z.number().int(), z.number().int()]).optional() })),
    }),
  },
  async ({ worldId, table }) => {
    getSession(worldId).loot.define(table as any);
    return text({ ok: true, registered: table.name });
  },
);

server.tool(
  "spawn",
  "Instantiate a registered prefab into the world, with optional per-spawn component overrides.",
  { worldId: z.string(), prefab: z.string(), overrides: z.record(z.string(), z.record(z.string(), z.any())).optional() },
  async ({ worldId, prefab, overrides }) => {
    const s = getSession(worldId);
    const e = s.prefabs.spawn(s.world, prefab, overrides);
    return text({ ok: true, entity: e });
  },
);

server.tool(
  "act",
  "Submit an action for an entity through the validated intent pipeline (same gate players and minds use). Verbs: say{text}, emote{kind}, move_to{x,y}, follow{target}, attack{target}, flee{from}, stop, pickup{target}.",
  { worldId: z.string(), actor: z.number().int(), verb: z.string(), params: z.record(z.string(), z.any()).default({}) },
  async ({ worldId, actor, verb, params }) => {
    const s = getSession(worldId);
    const result = s.actions.execute(s.world, { actor, verb, params });
    return text(result);
  },
);

server.tool(
  "run",
  "Advance the simulation N ticks (60 ticks = 1s of game time). LLM minds think during the run when a key is configured. Returns the event log for the window.",
  { worldId: z.string(), ticks: z.number().int().min(1).max(36000).default(600) },
  async ({ worldId, ticks }) => {
    const s = getSession(worldId);
    const from = s.events.length;
    // advance in slices so in-flight thoughts land mid-run, like a real game
    let remaining = ticks;
    while (remaining > 0) {
      const slice = Math.min(remaining, 120);
      s.loop.advance(slice);
      remaining -= slice;
      if (s.driver) await s.driver.settle();
    }
    return text({
      tick: s.world.tick,
      time: `${Math.round(s.world.time * 10) / 10}s`,
      entities: s.world.entityCount(),
      events: s.events.slice(from),
    });
  },
);

server.tool(
  "query_world",
  "Inspect the world: all entities with their key components (position, health, faction, behavior, mind, inventory, speech).",
  { worldId: z.string() },
  async ({ worldId }) => {
    const s = getSession(worldId);
    return text([...s.world.query()].map((e) => describeEntity(s, e)));
  },
);

server.tool(
  "generate_prefab",
  "Have the LLM (Genesis) design a validated prefab from a description and register it. Requires ZAI_API_KEY/LLM_API_KEY.",
  { worldId: z.string(), description: z.string(), constraints: z.string().default("") },
  async ({ worldId, description, constraints }) => {
    if (!hasKey) throw new Error("no LLM key configured (set ZAI_API_KEY)");
    const s = getSession(worldId);
    const g = new Genesis({ provider: new OpenAICompatibleProvider(), prefabs: s.prefabs, tier: "fast" });
    const prefab = await g.generatePrefab(description, constraints);
    return text({ ok: true, prefab });
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`llmgine MCP server ready (LLM: ${hasKey ? "enabled" : "disabled — set ZAI_API_KEY"})`);

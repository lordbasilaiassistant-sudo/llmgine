#!/usr/bin/env node
/**
 * llmgine MCP server — the engine as an agent tool.
 *
 * An AI agent (Claude Code, etc.) can build and simulate games headlessly:
 * define prefabs, spawn entities, attach LLM minds, advance the sim, and
 * read back what happened. Run: `node dist/mcp/server.js` (or the
 * `llmgine-mcp` bin once installed). A repo-root `.mcp.json` wires this up
 * for Claude Code automatically.
 * Set ZAI_API_KEY (or LLM_API_KEY + LLM_BASE_URL) to enable minds/genesis.
 */
import { realpathSync } from "node:fs";
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
import type { WorldBounds } from "../systems/movement.js";
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

const AI_COMPONENTS = [Mind, MindMemory, QuestLog];

/** Default world bounds — unbounded movement let chase/collision drift entities off to x≈−592 in E2E. */
const DEFAULT_BOUNDS: WorldBounds = { minX: -1000, minY: -1000, maxX: 1000, maxY: 1000 };

/**
 * Build the llmgine MCP server (tools + session state). Exported so tests can
 * drive it over an in-memory transport; the stdio hookup below only runs when
 * this file is executed directly.
 */
export function buildServer(): McpServer {
  const sessions = new Map<string, Session>();
  let nextId = 1;
  const hasKey = !!(process.env.ZAI_API_KEY || process.env.LLM_API_KEY);

  function createSession(seed: number, bounds: WorldBounds): string {
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
      .addSystem(movementSystem(grid, bounds))
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
    if (!s) {
      const known = [...sessions.keys()];
      throw new Error(`unknown world "${id}" — ${known.length ? `known worlds: ${known.join(", ")}` : "call create_world first"}`);
    }
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
  const text = (data: unknown) => ({ content: [{ type: "text" as const, text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }] });

  server.tool(
    "create_world",
    "Create a new headless game world (deterministic ECS sim). Returns a worldId for the other tools. Movement is clamped to `bounds` (default ±1000) so entities can't drift off to infinity.",
    {
      seed: z.number().int().default(1).describe("RNG seed — same seed = same world"),
      bounds: z.object({ minX: z.number(), minY: z.number(), maxX: z.number(), maxY: z.number() })
        .default(DEFAULT_BOUNDS)
        .describe("World-edge clamp applied by the movement system"),
    },
    async ({ seed, bounds }) => text({ worldId: createSession(seed, bounds), bounds, llm: hasKey ? "enabled (minds will think)" : "disabled (no ZAI_API_KEY — deterministic fallbacks only)" }),
  );

  server.tool(
    "define_prefab",
    "Register an entity template (JSON). Components: Transform{x,y}, Velocity{maxSpeed}, Collider{radius}, Sprite{kind,color,size}, Named{name,blurb}, Health{hp,maxHp}, Faction{id,hostileTo[]}, Attack{damage,range,cooldown}, Inventory, LootDrop{table}, Behavior{mode,sightRange}, Speech, Mind{persona,goals,thinkEvery,verbs,fallbackMode}, MindMemory, QuestLog. Component coupling for verbs: move_to/follow/flee/stop need Behavior AND Velocity; attack additionally needs Attack; say/emote need Speech; pickup needs Inventory.",
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
    "list_prefabs",
    "List every prefab registered in this world (names + full component templates).",
    { worldId: z.string() },
    async ({ worldId }) => text(getSession(worldId).prefabs.list()),
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
    "attach_mind",
    "Attach a Mind (LLM cognition) + MindMemory to an EXISTING entity — anything in the world can think. The mind acts only through the validated verb pipeline, so its body must have the verbs' components: move_to/follow/flee/stop require Behavior+Velocity, attack also requires Attack, say/emote require Speech, pickup requires Inventory. Without an API key the mind runs its deterministic fallbackMode instead of thinking.",
    {
      worldId: z.string(),
      entity: z.number().int().describe("Existing entity id (from spawn/query_world)"),
      persona: z.string().describe("Who this entity is — becomes the system-prompt core"),
      goals: z.array(z.string()).default([]).describe("Standing objectives, priority order"),
      tier: z.enum(["fast", "smart", "vision"]).default("fast").describe("Model tier to think with"),
      thinkEvery: z.number().positive().default(6).describe("Seconds of sim time between thoughts"),
      verbs: z.array(z.string()).default([]).describe("Verb allowlist; empty = every registered verb"),
      fallbackMode: z.string().default("wander").describe("Deterministic Behavior mode when the LLM is unavailable/over budget"),
      sightRange: z.number().positive().default(220).describe("Perception radius in world units"),
    },
    async ({ worldId, entity, persona, goals, tier, thinkEvery, verbs, fallbackMode, sightRange }) => {
      const s = getSession(worldId);
      if (!s.world.isAlive(entity)) {
        throw new Error(`no such entity ${entity} — living entities: ${[...s.world.query()].join(", ") || "(none)"}`);
      }
      s.world.add(entity, Mind, { persona, goals, tier, thinkEvery, verbs, fallbackMode, sightRange });
      if (!s.world.has(entity, MindMemory)) s.world.add(entity, MindMemory);
      const caps: string[] = [];
      if (!s.world.has(entity, Speech)) caps.push("say/emote (no Speech)");
      if (!s.world.has(entity, Behavior)) caps.push("move_to/follow/attack/flee/stop (no Behavior)");
      return text({
        ok: true,
        entity: describeEntity(s, entity),
        llm: hasKey ? "enabled — this mind will think during `run`" : "disabled (no key) — runs fallbackMode only",
        ...(caps.length ? { warning: `entity currently lacks components for: ${caps.join("; ")}` } : {}),
      });
    },
  );

  server.tool(
    "act",
    "Submit an action for an entity through the validated intent pipeline (same gate players and minds use). Verbs and required components: say{text}/emote{kind} need Speech; move_to{x,y}, follow{target}, flee{from}, stop need Behavior+Velocity; attack{target} needs Attack+Behavior+Velocity; pickup{target} needs Inventory (and the target within 48 units). Validation failures name the missing component.",
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
    "save_world",
    "Snapshot the full world state (entities, components, RNG, tick) as a JSON string. Pass the string back to load_world to restore. Note: prefab/loot-table definitions and system config are NOT in the snapshot — they live on the session.",
    { worldId: z.string() },
    async ({ worldId }) => {
      const s = getSession(worldId);
      return text(JSON.stringify(s.world.save()));
    },
  );

  server.tool(
    "load_world",
    "Restore a world from a save_world JSON string, replacing the target world's entity/component state (systems, prefabs, and loot tables keep their current session config). Components not registered in this session are dropped.",
    { worldId: z.string(), snapshot: z.string().describe("The exact JSON string returned by save_world") },
    async ({ worldId, snapshot }) => {
      const s = getSession(worldId);
      let snap: any;
      try {
        snap = JSON.parse(snapshot);
      } catch {
        throw new Error("snapshot is not valid JSON — pass the exact string save_world returned");
      }
      if (!snap || typeof snap !== "object" || !Array.isArray(snap.alive) || typeof snap.components !== "object") {
        throw new Error("snapshot shape is wrong — expected the object produced by save_world (alive[], components{}, rng, tick)");
      }
      s.world.load(snap, s.prefabs.componentTypes());
      return text({ ok: true, tick: s.world.tick, entities: s.world.entityCount() });
    },
  );

  server.tool(
    "destroy_world",
    "Destroy a world session and free its state. Its worldId becomes invalid; other worlds are untouched.",
    { worldId: z.string() },
    async ({ worldId }) => {
      getSession(worldId); // throws with the known-worlds list if bogus
      sessions.delete(worldId);
      return text({ ok: true, destroyed: worldId, remainingWorlds: [...sessions.keys()] });
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

  return server;
}

// ── stdio entrypoint (only when executed directly, incl. via bin symlink) ──
const argvPath = (() => {
  const p = process.argv[1] ?? "";
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
})();
if (argvPath && /mcp[\\/]server\.(ts|js)$/.test(argvPath)) {
  const transport = new StdioServerTransport();
  await buildServer().connect(transport);
  const hasKey = !!(process.env.ZAI_API_KEY || process.env.LLM_API_KEY);
  console.error(`llmgine MCP server ready (LLM: ${hasKey ? "enabled" : "disabled — set ZAI_API_KEY"})`);
}

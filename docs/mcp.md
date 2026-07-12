# MCP server — the engine as an agent tool

Source: `src/mcp/server.ts`. An AI agent can define prefabs, spawn entities,
attach LLM minds, advance the deterministic sim headlessly, and read back
what happened — no browser, no human in the loop.

## Connect

From a clone (build first — the server runs from `dist/`):

```bash
git clone https://github.com/lordbasilaiassistant-sudo/llmgine
cd llmgine && npm install && npm run build
```

**Claude Code:** the repo ships a root `.mcp.json` — opening the repo
auto-connects the `llmgine` server. For any other MCP client:

```json
{
  "mcpServers": {
    "llmgine": {
      "command": "node",
      "args": ["<path-to-clone>/dist/mcp/server.js"],
      "env": { "ZAI_API_KEY": "…" }
    }
  }
}
```

`ZAI_API_KEY` (or `LLM_API_KEY` + `LLM_BASE_URL`) is optional: without it,
minds run their deterministic fallbacks and `generate_prefab` is unavailable —
everything else works.

## Tools

| Tool | What it does |
|---|---|
| `create_world {seed?, bounds?}` | New headless world → `worldId`. Movement clamps to `bounds` (default ±1000). |
| `define_prefab {worldId, prefab}` | Register a validated JSON entity template. |
| `list_prefabs {worldId}` | All registered templates. |
| `define_loot_table {worldId, table}` | Weighted drop table for `LootDrop` entities. |
| `spawn {worldId, prefab, overrides?}` | Instantiate a prefab → entity id. |
| `attach_mind {worldId, entity, persona, …}` | Put a Mind + MindMemory on an EXISTING entity (goals, tier, thinkEvery, verbs, fallbackMode, sightRange). |
| `act {worldId, actor, verb, params}` | One action through the validated intent pipeline. |
| `run {worldId, ticks?}` | Advance N ticks (60 = 1 s); minds think mid-run; returns the event log window. |
| `query_world {worldId}` | Every entity with position/health/faction/behavior/mind/inventory/speech. |
| `save_world {worldId}` | Full snapshot as a JSON string. |
| `load_world {worldId, snapshot}` | Restore that string into the world. |
| `destroy_world {worldId}` | Free the session. |
| `generate_prefab {worldId, description}` | Genesis: LLM designs a validated prefab (needs a key). |

Component coupling (validators tell you too): `say`/`emote` need `Speech`;
`move_to`/`follow`/`flee`/`stop` need `Behavior` + `Velocity`; `attack` also
needs `Attack`; `pickup` needs `Inventory` and the target within 48 units.

## Agent walkthrough

A complete session an agent can run verbatim:

1. `create_world {seed: 42}` → `world-1`
2. `define_prefab` — a goblin:
   ```json
   { "worldId": "world-1", "prefab": { "name": "goblin", "components": {
     "Transform": {"x": 100, "y": 0}, "Velocity": {"maxSpeed": 90},
     "Named": {"name": "Snag"}, "Health": {"hp": 25, "maxHp": 25},
     "Faction": {"id": "monsters", "hostileTo": ["player"]},
     "Attack": {"damage": 5, "range": 28}, "Behavior": {"mode": "wander"},
     "Speech": {} } } }
   ```
3. `define_prefab` — a hero (Faction `player`, more hp) and `spawn` both.
4. `attach_mind {entity: <goblin>, persona: "A cowardly goblin scout.", goals: ["survive"], fallbackMode: "flee"}`
5. `act {actor: <hero>, verb: "attack", params: {target: <goblin>}}`
6. `run {ticks: 600}` → read `combat:damaged`, `speech`, `combat:death`,
   `loot:dropped` events from the returned window.
7. `save_world` before an experiment, `load_world` to rewind it.
8. `query_world` any time to inspect state; `destroy_world` when done.

Determinism: same seed + same actions = same events, so an agent can A/B a
balance change by rewinding (`load_world`) and re-running.

## Notes

- Save/load: the snapshot is component state + RNG only — prefab and loot
  definitions live on the session (see [save-load.md](./save-load.md)).
- Event log is capped at the most recent 500 events per world.
- `run` is capped at 36000 ticks (10 min of sim time) per call.

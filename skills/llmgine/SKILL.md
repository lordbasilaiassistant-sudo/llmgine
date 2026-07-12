---
name: llmgine
description: Build, play, test, and debug games on the llmgine LLM-native game engine. Use when creating a game with llmgine, adding Minds/verbs/prefabs, wiring GLM or any OpenAI-compatible LLM into gameplay, debugging a running llmgine game, or verifying a game works end-to-end (headless or in-browser).
---

# Building games on llmgine with an agent

llmgine is an ECS game engine where **Mind (LLM cognition), Eyes (perception), and Voice (TTS)
are components** — attach a Mind to anything and it thinks. You (the agent) are a first-class
citizen: you build games with code, and you PLAY and DEBUG them through the same pipeline the
Minds use.

## The contract (never violate these)

1. `src/core` is deterministic: seeded RNG, fixed timestep, no LLM references, no imports.
2. LLM output enters the world ONLY via `ActionRegistry` verbs. New capability = new verb with
   a validator. NEVER mutate component state from LLM output directly.
3. Every LLM feature has a deterministic fallback (`Mind.fallbackMode`, scripted directors).
   API down = game still runs. Test the keyless path FIRST.
4. Components are plain serializable data — no classes, methods, or entity object refs.
5. 3D (`llmgine/render3d`, three.js) is the primary presentation layer. Never ship 2D-only.

## Build loop

```bash
git clone <repo> && cd llmgine && npm install && npm run build   # engine from a clone
node dist/cli/index.js create mygame                             # scaffold (links engine via file:)
cd mygame && npm install && npm run dev                          # play at localhost:5173
```

Order of work for a new game: prefabs (JSON entity templates, validated) → verbs (validator +
resolver) → systems (deterministic, ordered) → Minds (persona/goals/cadence/fallback) →
playtest via AgentPort → export.

## Playing and debugging a running game (Agent Play Protocol)

Every game wires an `AgentPort` (the arena demo shows how — examples/arena/main.ts):

```ts
const port = new AgentPort({ world, loop, actions, grid, avatar: hero });
world.addSystem(port.system());
exposeAgentPort(port);          // window.llmgine in the browser
connectAgentBridge(port);       // dev-server HTTP bridge (localhost)
```

Drive it from a shell while `npm run demo` is serving:

```bash
curl -s localhost:4173/agent/call -d '{"method":"observe"}'                     # what do I see?
curl -s localhost:4173/agent/call -d '{"method":"act","args":["move_to",{"x":0,"y":-100}]}'
curl -s localhost:4173/agent/call -d '{"method":"step","args":[120]}'           # 2s, deterministic
curl -s localhost:4173/agent/call -d '{"method":"actionLog"}'                   # why was my verb rejected?
curl -s localhost:4173/agent/call -d '{"method":"events","args":[0]}'           # what happened?
curl -s localhost:4173/agent/call -d '{"method":"state","args":[6]}'            # entity 6, all components
```

Or in the browser console / via browser automation: `llmgine.observe()`, `llmgine.act("strike")`,
`llmgine.step(60)`, `llmgine.pause()`. `step()` pauses real time and advances deterministically —
your playtest is reproducible. Headless (no browser): use the MCP server (`.mcp.json` in the repo,
tools: create_world/define_prefab/spawn/attach_mind/act/run/query_world/save_world/load_world).

## Gotchas ledger (each one cost a real debugging session)

- **GLM flash is a reasoning model**: without `thinking:{type:"disabled"}` content comes back
  empty. The provider auto-handles z.ai/bigmodel URLs; behind a proxy pass `thinkingControl: true`.
- **Browser bindings**: `fetch` and `requestAnimationFrame` stored in fields must be
  `.bind(globalThis)`. Node masks this — unit tests won't catch it.
- **three r155+ physical lights**: point lights need candela-scale intensity (~10⁴ at world
  scale ~400 units); never use dark light colors (linear-space multiply → black); CylinderGeometry
  defaults to closed caps (`openEnded: true` for walls). Use `defaultLighting(scene)` to start.
- **Save/load**: register EVERY component type you use in the save list — `World.load` warns and
  drops unknowns (a mid-flight `Projectile` you forgot = ghost bullets). Module-level game state
  (timers, HUD caches) needs your own reset-after-load hook.
- **Verb params are type-checked at the gate** (finite numbers, entity ids); rejected actions land
  in `actions.recent` with the reason — read it before assuming the sim is broken.
- **System order vs journal**: a system only sees THIS tick's events from earlier-ordered systems;
  use `world.events.recent()` (previous full tick + current) for reactions like retaliation.
- **The sim keeps stepping in hidden tabs** (GameLoop `runInBackground`, default on). For manual
  loop driving, use `port.step(n)` — never mix your own timestamps into `loop.frame()`.

## Verify loop (before calling ANY game done)

1. `npm test && npm run typecheck && npm run build` — the CI gate.
2. `npm run agent:verify` — headless engine acceptance: world steps deterministically, verbs
   validate adversarial input, Mind falls back with a dead provider.
3. Keyless playtest: run the game with NO api key — the fallback experience must be a real game.
4. Live playtest through AgentPort: observe → act → assert on `events()` (kills, quest
   progress, deaths). A game you haven't played through the port isn't verified.
5. With a key: verify a real Mind taunt/tool-call lands in-game (watch `actionLog()`).

# Architecture — LLM-Native Game Engine (working name: `llmgine`)

> Phase 0 document. This is the contract every module is built against.
> Neutral working name; branding comes later.

## 1. Thesis

Every game engine has components you attach to entities: a transform, a sprite, a
collider. This engine adds three more primitives at the same level: **Mind**
(LLM cognition), **Eyes** (perception/vision), and **Voice** (TTS/STT). Attach a
`Mind` to anything — an NPC, a boss, a door, a faction, a weather system, a drop
table — and it thinks. Intelligence is a component, not a feature bolted onto one
NPC's update loop.

The hard problem this creates: **games are deterministic real-time loops; LLMs
are slow, async, and non-deterministic.** The whole architecture is shaped by
resolving that tension:

- The simulation is a **fixed-timestep, seeded, deterministic ECS**. It never
  blocks on a thought.
- Minds run **outside the tick** as async processes. They observe snapshots,
  think on their own cadence, and return **intents**.
- Intents enter the same **validated action pipeline** as player input. A Mind
  cannot teleport, dupe items, or deal 9999 damage — it can only request actions
  its entity is actually capable of, and the deterministic sim resolves them.
- Every LLM-augmentable module has a **deterministic fallback** (behavior-tree
  style policies, static loot tables, canned dialogue). If the API is down, the
  game still runs.

```
              ┌────────────────────────────────────────────┐
              │       DETERMINISTIC SIM (fixed 60 Hz)      │
              │  ECS world · systems · events · seeded RNG │
              └───────▲────────────────────────┬───────────┘
              intents │                        │ snapshots + events
              (validated)                      ▼
              ┌───────┴────────────────────────────────────┐
              │        COGNITION SCHEDULER (async)         │
              │  per-Mind cadence · budgets · fallbacks    │
              └───────▲────────────────────────┬───────────┘
                      │ tool-call responses    │ prompts (+ images)
              ┌───────┴────────────────────────▼───────────┐
              │            INFERENCE LAYER                 │
              │ provider-agnostic · tiers: fast/smart/see  │
              │ default: GLM flash (OpenAI-compatible API) │
              └────────────────────────────────────────────┘
```

## 2. Layers & module map

```
src/
  core/        # zero-dependency deterministic kernel
    ecs.ts        # World, entities, components, systems, queries, save/load snapshots
    loop.ts       # fixed-timestep driver (headless + rAF)
    events.ts     # (in ecs.ts) typed bus + per-tick journal
    prefab.ts     # JSON entity templates — the LLM-generatable unit
    spatial.ts    # spatial hash grid for range queries / perception
    actions.ts    # the intent pipeline (shared by player input AND minds)
    nav.ts        # NavGrid — coarse blocked-cell grid + deterministic A*
    save.ts       # SaveStore — named save slots over pluggable storage adapters
  components.ts  # standard components (Transform, Health, Inventory, …)
  verbs.ts       # STANDARD_VERBS — say/emote/move_to/follow/attack/flee/stop/pickup
  systems/       # movement, collision, behavior, combat, projectiles, loot, quests
  ai/            # the LLM layer — depends on core, never vice versa
    provider.ts   # ChatProvider interface + OpenAI-compatible client (GLM default)
    budget.ts     # request-rate controls, caching (token accounting = roadmap)
    mind.ts       # Mind + MindMemory components; short-term memory ring buffer
                  #   (episodic summaries are roadmap — nothing writes episodes yet)
    eyes.ts       # perception: structured snapshot + pixel vision capture
    cognition.ts  # the scheduler system bridging sim ↔ inference
    voice.ts      # Voice component + TTS/STT service interface
    genesis.ts    # LLM content generation (prefabs, quests, loot, dialogue)
  render3d/      # three.js renderer — the PRIMARY presentation layer (+ glTF helpers)
  render/        # Renderer interface + headless (tests/MCP) & canvas-2D (prototyping)
  input/         # touch virtual joystick + gamepad polling
  audio/         # procedural SFX/music service + event-journal-driven audio system
  mcp/           # MCP server exposing engine tools to agents
  cli/           # `create` scaffolder + `export` platform wrappers
examples/        # playable games proving the engine (acceptance tests)
```

**Dependency rule (enforced by review):** `core` imports nothing. `systems`
import `core` + `components`. `ai` imports `core` (it is a consumer of the same
public API a game uses). `render`/`mcp`/`cli` sit on top. Games import the
package. Nothing in `core` may reference LLMs — that's how we keep the sim
deterministic and testable.

## 3. Core kernel (Phase 1)

### ECS
- Entities are integer ids; components are **plain serializable data** (a hard
  rule — it's what makes save/load, snapshots-for-perception, networking, and
  LLM-readable world state all fall out for free).
- `defineComponent(name, defaults)` gives typed stores. Systems are ordered
  functions over queries.
- `World.step(dt)` advances exactly one tick: event journal reset → systems in
  order → deferred destroys.

### Determinism
- Fixed timestep (default 1/60 s). Render interpolates; sim never varies.
- Seeded RNG (`mulberry32`) owned by the World. Same seed + same inputs =
  same world. LLM non-determinism only enters through the intent pipeline,
  which keeps a capped in-memory log. *(Roadmap — not yet implemented:
  replaying a session from the intent log; today the log is diagnostic only —
  it is capped/spliced and not captured by save.)*

### Events
- Typed pub/sub plus a **per-tick journal**. The journal is what Eyes read to
  tell a Mind "what happened near you" without every Mind subscribing to
  everything. It is also the future networking/replay surface.

### Actions (the intent pipeline)
- An **Action** = `{ actor, verb, params }`. Verbs are registered with a
  validator (can this actor do this now?) and a resolver (apply it to the sim).
- Player input, scripted behaviors, and Mind decisions all flow through the
  same registry. This is the engine's security boundary against hallucinated
  capabilities — and it doubles as the tool schema handed to the LLM.

### Prefabs
- JSON templates: `{ name, components: { Transform: {...}, Health: {...} } }`.
- Human-authorable, diffable, and — critically — **LLM-emittable**. Genesis
  (§5) generates content by emitting prefab/quest/loot JSON that is validated
  (zod) before it ever touches the world. Generation and simulation stay
  decoupled.

### Scenes, save/load
- A scene = prefab spawns + system configuration. `World.save()/load()` snapshot
  all component state + RNG, since components are plain data.

### Rendering abstraction
- **Choice: TypeScript, web-first.** Reasoning: (1) games ship in the browser →
  zero-install play, free static hosting, maximum reach for an OSS project;
  (2) the MCP/agent story needs a scriptable runtime with first-class JSON —
  Node headless mode is the same code; (3) renderer pixel capture gives the
  vision pipeline (§5) for free via `toDataURL()`.
- `Renderer` is an interface with three implementations:
  - **`render3d/ThreeRenderer` — the primary presentation layer.** three.js
    scene lifted from the planar sim (Transform x/y → ground plane); games
    register a *model factory* per entity kind (procedural meshes or loaded
    glTF) with per-frame `animate` callbacks that read live sim state — walk
    cycles from Velocity, attack lunges from cooldowns, glowing eyes while a
    Mind is thinking. Chase cam, shadows, fog, `capture()` for pixel Eyes,
    `project()` for HTML overlays (bars/bubbles/damage numbers).
  - `HeadlessRenderer` — tests, servers, MCP simulation.
  - `Canvas2DRenderer` — prototyping and minigames (skin registry per kind).
  Full 3D terrain (heightmaps/voxels) is a spatial-model roadmap item, not a
  rewrite — the sim is renderer-agnostic.

## 4. Inference layer (Phase 2)

### Provider interface
```ts
interface ChatProvider {
  chat(req: ChatRequest): Promise<ChatResponse>;   // messages, tools, images
  readonly supportsVision: boolean;
}
```
- One built-in implementation: **OpenAI-compatible HTTP client** — works with
  z.ai GLM (default), OpenAI, Ollama, LM Studio, vLLM, anything local. No
  provider SDKs.
- **Model tiers, not model names**, are what the engine requests:
  - `fast` — high-frequency ticks: NPC chatter, reactions (default `glm-4.5-flash`, free)
  - `smart` — rare deep reasoning: boss tactics, quest generation (default `glm-4.6` class)
  - `vision` — multimodal perception (default GLM-4V class)
  A game maps tiers → models once; every Mind just declares its tier.

### Budgets & caching
- Global request budgets per minute + per-Mind cooldowns. When over budget,
  minds silently degrade to their deterministic fallback policy. *(Roadmap —
  not yet implemented: token-level budgets; today only request counts are
  tracked and returned usage is discarded.)*
- Response cache keyed on (model, prompt hash) for Genesis-style generation.

### Mind
- Component config: `persona`, `goals[]`, `tier`, `thinkEvery` (seconds),
  `wakeOn` (event types that trigger immediate thought: damaged, spoken-to,
  saw-enemy), `fallback` (named deterministic policy).
- The **cognition scheduler** each tick: collects minds due to think (cadence
  elapsed or wake event), builds their perception, dispatches async LLM calls
  (batched, budgeted), and applies returned tool calls as intents. In-flight
  thoughts never block the sim; stale thoughts (world changed too much) are
  droppable.

### Eyes (perception & vision)
Modes, composable per entity (`Mind.perception: "structured" | "pixels" | "both"`):
1. **Structured** (default, works with any text model): a compact JSON snapshot
   — entities in radius (from the spatial grid), their salient components,
   recent event journal entries within earshot, self state.
2. **Pixels**: capture the renderer's view of the entity's viewpoint region and
   send to the `vision` tier. Browser: canvas crop → data URL. This is real
   sight — the boss looks at the actual screen.
3. **Raycast summary** *(roadmap — not yet implemented)*: line-of-sight
   filtered version of (1) for genres where "behind a wall" matters
   (FPS/stealth). No raycast mode exists in src/ today.

### Voice
- `Voice` component (voice id, style) + `VoiceService` engine service with
  `speak(text, voice)` / `listen()` hooks. Adapters: local TTS (user's local
  voice rig), Web Speech API fallback, silent headless. STT enters the sim as
  a `say` action from the player — symmetric with NPC speech.

## 5. Gameplay modules (Phase 3)

Each module = deterministic core + optional LLM augmentation. **The plain
version must be complete and fun-capable on its own**; the LLM version enriches.

| Module | Deterministic core | LLM augmentation (via Genesis/Mind) |
|---|---|---|
| Combat | health/damage/death, attack verbs, factions & aggro, PvE + PvP | boss tactics minds, taunts, adaptive difficulty |
| Loot | weighted drop tables, rarity, `drops` on death | generated item names/lore/stats within validated bounds |
| Quests | objective state machines (kill/fetch/reach/talk), rewards | dynamically authored quests from world state |
| Inventory | slots, stacking, equip, item defs as prefabs | — (pure core) |
| Dialogue | canned dialogue trees | free conversation with memory, in persona |
| Spawning | spawner components, waves | director mind pacing encounters |

Genre proof-of-expressiveness targets (not all built now): arena/FPS-style
combat (Phase 4 demo), RPG town (dialogue+quests+shops), sandbox voxel (chunked
spatial model + 3D renderer adapter — roadmap).

## 6. Distribution surfaces (Phase 5)

1. **Package**: npm (not yet published), ESM, subpath exports (`.`, `./ai`,
   `./render`, `./render3d`, `./input`, `./audio`, `./mcp`). Zero runtime deps
   in `core`.
2. **CLI**: `create` scaffolder (links the scaffold to the engine clone it ran
   from via a `file:` dependency until the package is published) + `export`
   platform wrappers (§6.5).
3. **MCP server**: the engine as an agent tool (`.mcp.json` at the repo root
   auto-connects Claude Code; see [docs/mcp.md](./docs/mcp.md)). Tools:
   `create_world`, `define_prefab`, `define_loot_table`, `list_prefabs`,
   `spawn`, `attach_mind`, `act`, `run` (headless N ticks → event/state
   report), `query_world`, `save_world`, `load_world`, `destroy_world`,
   `generate_prefab` (Genesis). An agent can build, simulate, and inspect a
   game without a browser.

## 6.5 Export pipeline (any game → any platform)

Because games are web-first bundles, one build fans out to every platform via
the `export` CLI, which scaffolds per-target wrappers around the same build:

| Target | Wrapper | Output | Notes |
|---|---|---|---|
| Web | none | static site / zip | GitHub Pages / itch.io ready |
| Windows | Electron + electron-builder | `.exe` (NSIS installer + portable) | built on the dev machine, free |
| Linux/macOS | same Electron config | AppImage / `.dmg` | macOS signing optional |
| Android | Capacitor | `.apk` / `.aab` | Play-ready; sideload-free |
| iOS | Capacitor | Xcode project | store build needs a Mac + Apple $99/yr (Apple's rule); no free path |
| Mobile (no store) | PWA manifest + service worker | installable PWA | free, instant, works on iPhone/Android today |

Each export also emits a **store listing kit** (`store/` folder): title,
short/long descriptions, tags, screenshot manifest, icon set, pricing/rating
placeholders — everything a storefront (Steam/itch/Play/App Store) asks for,
pre-drafted by Genesis and editable. Selling or free-launching a finished game
is a checklist, not a research project. The engine ships the *generators* for
these configs; heavy toolchains (Electron, Capacitor) are devDependencies of
the exported game project, not of the engine.

## 7. Testing & CI

- Vitest. Per-module unit tests colocated (`*.test.ts`).
- Determinism test: same seed, 1000 ticks, identical snapshot hash.
- LLM layer tested against a `MockProvider` (deterministic); one **live** suite
  (`test:live`, needs `ZAI_API_KEY`) proves the real GLM path — run before any
  release claim, never in CI.
- CI (GitHub Actions): typecheck + build + unit tests on PR. Conventional
  commits.

## 8. Honest status ledger

Maintained at the bottom of README: what works (with test evidence), what's
stubbed, what's broken. Nothing is called done unless it runs.

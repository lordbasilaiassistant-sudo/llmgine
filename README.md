# llmgine

**The LLM-native game engine.** An ECS game engine where intelligence is a core
primitive: attach a **Mind** (LLM cognition), **Eyes** (perception/vision), and
**Voice** (neural TTS) to *any* entity the same way you attach physics or a
sprite. An NPC, a boss, a monster, a quest giver, a faction, the weather — if
it's in the world, it can think, see, and speak.

> Working title. TypeScript · 3D (three.js) + headless + 2D canvas · MIT.

```
deterministic 60 Hz ECS sim  ←— validated intents —— async LLM minds
        │                                                  ▲
        └—————— perception snapshots + pixel vision ———————┘
```

The hard problem: games are deterministic real-time loops; LLMs are slow,
async, and non-deterministic. llmgine resolves it structurally:

- The sim **never blocks on a thought**. Minds observe snapshots, think on
  their own cadence (plus event wakeups: *damaged*, *spoken to*), and return
  intents.
- Intents pass the same **validated action pipeline** as player input — a Mind
  can only do what its body allows. No hallucinated teleports, no 9999 damage.
- Every LLM-augmented module has a **deterministic fallback** (behavior
  policies, weighted loot tables, quest state machines). **If the API is down,
  the game still runs.**
- **Genesis** turns the LLM into a content generator: prefabs, loot, quests as
  validated JSON. The model proposes; the engine disposes.

## Quickstart

```bash
npm install llmgine
```

```ts
import {
  World, GameLoop, SpatialGrid, ActionRegistry, actionSystem,
  Transform, Velocity, Named, Health, Speech, Behavior,
  STANDARD_VERBS, behaviorSystem, movementSystem,
  Mind, MindMemory, CognitionDriver, OpenAICompatibleProvider,
} from "llmgine";

const world = new World(42);            // seeded — deterministic
const grid = new SpatialGrid();
const actions = new ActionRegistry();
for (const v of STANDARD_VERBS) actions.register(v);

// any entity + Mind = intelligent entity
const guard = world.create();
world.add(guard, Transform, { x: 0, y: 0 });
world.add(guard, Velocity);
world.add(guard, Named, { name: "Gate Guard" });
world.add(guard, Health);
world.add(guard, Speech);
world.add(guard, Behavior, { mode: "idle" });
world.add(guard, Mind, {
  persona: "A vigilant town guard. Suspicious of strangers.",
  goals: ["guard the gate"],
  thinkEvery: 8,                        // seconds between thoughts
  fallbackMode: "wander",               // deterministic policy if the LLM is unavailable
});
world.add(guard, MindMemory);

const driver = new CognitionDriver({
  provider: new OpenAICompatibleProvider(),   // reads ZAI_API_KEY / LLM_API_KEY + LLM_BASE_URL
  actions, grid,
});
world.addSystem(actionSystem(actions));
world.addSystem(behaviorSystem());
world.addSystem(movementSystem(grid));
world.addSystem(driver.system());

new GameLoop(world).start();            // browser; or loop.advance(n) headless
```

## Get a free model (GLM)

The default provider targets [z.ai](https://z.ai)'s OpenAI-compatible API,
where **glm-4.5-flash is free** — free minds for every NPC in your game:

1. Create a key at z.ai and set `ZAI_API_KEY`.
2. That's it. Tiers: `fast` (flash — NPC chatter), `smart` (deep reasoning),
   `vision` (pixel Eyes). Map tiers to any models you like.

Any OpenAI-compatible endpoint works instead: OpenAI, Ollama, LM Studio, vLLM —
`new OpenAICompatibleProvider({ baseUrl, apiKey, models })`.

> *Disclosure: if you want more than the free tier, this is a referral link for
> the GLM Coding Plan — we may receive credit, which funds the project's
> development:* https://z.ai/subscribe?ic=BWTG6TRYYQ

## The demo — The Neural Colosseum

A 3D torchlit arena: you (a gladiator) vs **The Arena Master**, a boss whose
mind is a live GLM model. It perceives the pit, taunts you in character
(rendered in the "thought ribbon" and speech bubbles, voiced by local
[Kokoro](https://github.com/hexgrad/kokoro) neural TTS), commands its goblins,
fights, and drops loot through deterministic tables. Remove the API key and the
same fight runs on pure instinct.

```bash
git clone https://github.com/lordbasilaiassistant-sudo/llmgine
cd llmgine && npm install
npm run demo        # http://localhost:4173 — auto-detects ZAI_API_KEY locally
```

## For AI agents: the MCP server

The engine ships as an [MCP](https://modelcontextprotocol.io) tool so agents
can build and test games headlessly:

```json
{ "mcpServers": { "llmgine": { "command": "npx", "args": ["llmgine-mcp"], "env": { "ZAI_API_KEY": "…" } } } }
```

Tools: `create_world`, `define_prefab`, `define_loot_table`, `spawn`, `act`,
`run` (advance N ticks → event log), `query_world`, `generate_prefab`
(Genesis). An agent can design a boss, simulate 10 seconds of combat, and read
the death/loot events back — no browser, no human in the loop.

## What's in the box

| Layer | Contents |
|---|---|
| `core` | ECS, fixed-timestep loop, seeded RNG, event journal, spatial grid, prefabs (validated JSON), action/intent pipeline, save/load |
| gameplay | combat (PvE/PvP, factions, aggro), loot/drop tables, quests + rewards, inventory, dialogue/speech, spawning — each fully functional with zero LLM |
| `ai` | provider-agnostic inference (tiers: fast/smart/vision), Mind/Eyes/Voice components, cognition scheduler, memory, budgets + caching, Genesis content generation |
| `render3d` | three.js renderer: model factories with live-sim-driven animation, chase cam, `capture()` for pixel vision |
| `render` | headless renderer (tests/servers/MCP) + canvas 2D (prototyping/minigames) |
| `mcp` | the engine as an agent tool |

Full design: [ARCHITECTURE.md](./ARCHITECTURE.md).

## Honest status (v0.1)

**Works (tested):** everything in the table above — 29 unit tests + a live GLM
suite (`npm run test:live`) where a real model drives a Mind through the intent
pipeline and Genesis generates a valid, spawnable prefab. The demo runs the
full loop in-browser with a live boss mind.

**Stubbed / roadmap:**
- Export pipeline (Windows `.exe` via Electron, Android/iOS via Capacitor,
  PWA, store listing kits) — designed (see ARCHITECTURE §6.5), not yet built.
- `create` CLI game scaffolder.
- Multiplayer (the event journal + intent log are the designed foundation).
- Voxel/heightmap terrain; glTF model loading helpers; STT input.
- Vision ("pixels" Eyes) is wired end-to-end but not yet exercised by the demo.

## License

MIT. Contributions welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md).

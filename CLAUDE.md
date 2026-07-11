# llmgine — project notes for Claude

The LLM-native game engine (working name). Builds ALL our future games. Read
ARCHITECTURE.md before touching structure — it is the contract.

## Iron rules
- `src/core` imports nothing and never references LLMs. Sim stays deterministic
  (seeded RNG, fixed timestep); replayable from seed + intent log.
- LLM output enters the world ONLY via `ActionRegistry` verbs (validated). New
  capability = new verb with a validator, never direct state mutation.
- Every LLM-augmented feature has a deterministic fallback (API-down = game still runs).
- Components are plain serializable data. No classes/methods in component state.
- 3D (`src/render3d`, three.js) is the PRIMARY renderer. 2D canvas is for
  prototyping only — never demo the engine in 2D (Anthony's 1/10 rating, 2026-07-10).
- Voice = Kokoro neural TTS adapter; Web Speech is last-resort fallback only.

## Gotchas that already burned us
- GLM flash = reasoning model: without `thinking:{type:"disabled"}` content is
  empty (budget spent on reasoning_content). Provider handles it for z.ai URLs.
- Browser: `fetch` and `requestAnimationFrame` stored in fields must be
  `.bind(globalThis)` — Node masks this, tests won't catch it.
- three r155+ physical lights: point lights need candela-scale intensity
  (~10⁴ at our world scale); avoid dark light colors (linear-space multiply → black);
  CylinderGeometry defaults to CLOSED caps (openEnded=true for walls/stands).

## Commands
- `npm test` (unit, no network) · `npm run test:live` (real GLM; needs ZAI_API_KEY)
- `npm run demo` → builds + serves arena on :4173, auto-detects local key via /dev/key
- `npm run typecheck && npm run build` — CI gate. Conventional commits.

## State
- Live demo: https://lordbasilaiassistant-sudo.github.io/llmgine/ (Pages workflow)
- Phase 6 export pipeline (exe/Capacitor/PWA/store kit) = designed not built, issue #1.
- npm name `llmgine` reserved-by-availability; publish deliberately, not casually.

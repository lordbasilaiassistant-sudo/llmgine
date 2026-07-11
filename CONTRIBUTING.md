# Contributing to llmgine

## Ground rules

1. **`core` stays deterministic and dependency-free.** Nothing in `src/core`
   may import from `src/ai` or reference LLMs. The sim must be replayable from
   a seed + intent log.
2. **Components are plain serializable data.** No methods, no class instances.
3. **Every LLM-augmented feature ships a deterministic fallback.** If your
   feature dies when the API is down, it's not done.
4. **Minds act through the intent pipeline only.** Never let model output
   mutate world state directly — register a verb with a validator.
5. **Tests per module.** Colocated `*.test.ts` (Vitest, `MockProvider` for AI).
   PRs must pass `npm run typecheck && npm test`. Live-API tests go in
   `live.test.ts` (never run in CI).

## Workflow

- Fork → branch → PR against `main`. Conventional commits
  (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`).
- CI runs typecheck + build + unit tests on every PR.
- Keep PRs focused; describe *what runs differently* and paste test output.

## Setup

```bash
npm install
npm test              # unit tests (no network)
npm run typecheck
npm run demo          # the arena, http://localhost:4173
ZAI_API_KEY=… npm run test:live   # optional: real-model acceptance tests
```

## Where things go

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the module map and the dependency
rule. New gameplay systems → `src/systems/`. New providers → implement
`ChatProvider` in `src/ai/`. New renderers → implement `Renderer`.

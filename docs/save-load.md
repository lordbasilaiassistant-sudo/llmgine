# Save / load

Source: `src/core/ecs.ts` (`World.save/load`), `src/core/save.ts` (`SaveStore`).

Because components are plain serializable data (a hard engine rule),
`World.save()` is a complete snapshot: every living entity's components,
entity id counter, tick, sim time, and the RNG state.

## Raw snapshots

```ts
const snap = world.save();                       // WorldSnapshot (plain JSON-able object)
world.load(snap, componentTypes);                // replaces the world's state
```

## Named slots — SaveStore

```ts
import { SaveStore, LocalStorageAdapter, MemoryStorage, ALL_COMPONENTS } from "llmgine";
import { Mind, MindMemory } from "llmgine/ai";

const store = new SaveStore(
  new LocalStorageAdapter(),                     // browser; MemoryStorage for tests/headless
  [...ALL_COMPONENTS, Mind, MindMemory],         // ← register EVERY component you use (see gotcha)
);

await store.save("slot1", world, { label: "before boss" }); // meta = any plain data
const meta = await store.load("slot1", world);   // replaces world state, returns meta
await store.list();                              // [{ slot, savedAtTick, meta }]
await store.remove("slot1");
```

Storage is pluggable (`StorageAdapter`: get/set/remove/keys) — implement it
over files or cloud saves in ~10 lines. Corrupt slots are skipped by
`list()`, not fatal.

## Gotcha 1: register your components or they silently vanish

`World.load(snap, types)` **drops any component whose type is not in
`types`** (it can't reconstruct stores it doesn't know about). Symptoms: NPCs
load without their `Mind`, projectiles lose their `Ranged`. Always pass the
full list — `ALL_COMPONENTS` plus every AI component (`Mind`, `MindMemory`,
`QuestLog`) and every custom/gameplay component (`Ranged`, `Projectile`, …)
your game defines. If you use a `PrefabRegistry`, `prefabs.componentTypes()`
returns exactly what it was given via `registerComponents`.

## Gotcha 2: transient state is NOT in the snapshot

The snapshot covers component data + RNG only. It does **not** capture:

- systems and their configuration (bounds, nav grids, loot tables, verbs) —
  the world you load into must already be wired the same way;
- the `SpatialGrid` — rebuilt by `movementSystem` on the next tick;
- in-flight Mind thoughts (an LLM reply that lands after a load is stale —
  the cognition scheduler may apply it to the restored world);
- renderer objects, audio, DOM — presentation re-syncs from state;
- the event journal / intent log.

Practical pattern (the arena demo's F5/F9 quicksave): build the world once —
systems, verbs, loot — then treat `SaveStore.load` as "replace the component
state inside that fixed machine".

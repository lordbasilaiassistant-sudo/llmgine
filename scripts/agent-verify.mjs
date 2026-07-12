#!/usr/bin/env node
/**
 * agent:verify — headless engine acceptance an agent (or CI) can run in
 * seconds. Proves the three promises games rely on:
 *   1. deterministic sim (same seed → same state)
 *   2. the verb gate rejects adversarial input (types/finiteness/self-target)
 *   3. a Mind with a dead provider degrades to its deterministic fallback
 * Requires `npm run build` first (imports dist/).
 */
import {
  World, GameLoop, SpatialGrid, ActionRegistry, actionSystem,
  Transform, Velocity, Health, Attack, Behavior, Speech, Faction,
  STANDARD_VERBS, movementSystem, behaviorSystem, combatSystem,
  Mind, CognitionDriver, MockProvider,
} from "../dist/index.js";

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

// 1. determinism: same seed + same inputs → identical snapshots
function buildWorld(seed) {
  const world = new World(seed);
  const grid = new SpatialGrid();
  const actions = new ActionRegistry();
  for (const v of STANDARD_VERBS) actions.register(v);
  world.addSystem(actionSystem(actions)).addSystem(behaviorSystem()).addSystem(movementSystem(grid)).addSystem(combatSystem());
  const e = world.create();
  world.add(e, Transform, { x: 0, y: 0 });
  world.add(e, Velocity, { maxSpeed: 100 });
  world.add(e, Behavior, { mode: "wander" });
  return { world, actions, e };
}
const a = buildWorld(42);
const b = buildWorld(42);
new GameLoop(a.world).advance(600);
new GameLoop(b.world).advance(600);
check("deterministic 600-tick run", JSON.stringify(a.world.save()) === JSON.stringify(b.world.save()));

// 2. adversarial verbs: garbage never reaches the sim
const { world, actions, e } = a;
const r1 = actions.execute(world, { actor: e, verb: "move_to", params: { x: "north edge", y: 0 } });
check("string coord rejected", !r1.ok, r1.error);
const r2 = actions.execute(world, { actor: e, verb: "move_to", params: { x: 1e999, y: 0 } });
check("Infinity coord rejected", !r2.ok, r2.error);
world.add(e, Attack, {});
const r3 = actions.execute(world, { actor: e, verb: "attack", params: { target: e } });
check("self-attack rejected", !r3.ok, r3.error);
const t = world.get(e, Transform);
check("transform stayed finite", Number.isFinite(t.x) && Number.isFinite(t.y));

// 3. dead provider → deterministic fallback (API down = game still runs)
const w2 = new World(7);
const grid2 = new SpatialGrid();
const actions2 = new ActionRegistry();
for (const v of STANDARD_VERBS) actions2.register(v);
const driver = new CognitionDriver({
  provider: new MockProvider([new Error("api down"), new Error("api down")]),
  actions: actions2,
  grid: grid2,
});
w2.addSystem(actionSystem(actions2)).addSystem(behaviorSystem()).addSystem(movementSystem(grid2)).addSystem(driver.system());
const npc = w2.create();
w2.add(npc, Transform, {});
w2.add(npc, Velocity, {});
w2.add(npc, Speech, {});
w2.add(npc, Behavior, { mode: "idle" });
w2.add(npc, Mind, { thinkEvery: 0.05, fallbackMode: "wander" });
new GameLoop(w2).advance(10);
await driver.settle();
new GameLoop(w2).advance(1);
check("mind fell back to deterministic policy", w2.get(npc, Behavior).mode === "wander");

console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed — engine acceptance green");
process.exit(failures ? 1 : 0);

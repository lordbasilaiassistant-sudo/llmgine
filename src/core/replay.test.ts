import { describe, expect, it } from "vitest";
import { World, GameLoop } from "../index.js";
import { ActionRegistry, actionSystem } from "./actions.js";
import { SpatialGrid } from "./spatial.js";
import {
  Attack, Behavior, Collider, Faction, Health, PlayerControlled, Speech, Transform, Velocity,
  ALL_COMPONENTS,
} from "../components.js";
import { STANDARD_VERBS } from "../verbs.js";
import { behaviorSystem, aggroSystem } from "../systems/behavior.js";
import { movementSystem, collisionSystem } from "../systems/movement.js";
import { combatSystem } from "../systems/combat.js";
import { playerDriveSystem } from "../input/controller.js";
import { startRecording, replaySystem, verifyReplay } from "./replay.js";
import { CognitionDriver } from "../ai/cognition.js";
import { Mind, MindMemory } from "../ai/mind.js";
import { MockProvider } from "../ai/provider.js";

/**
 * The replay contract (ARCHITECTURE §3): a session = seed + intent log.
 * Everything below drives the world ONLY through verbs — then replays the
 * log into a fresh world and demands byte-identical final state.
 */

const TYPES = [...ALL_COMPONENTS, Mind, MindMemory];

function buildSim(withCognition = false) {
  const world = new World(777);
  const grid = new SpatialGrid();
  const actions = new ActionRegistry();
  for (const v of STANDARD_VERBS) actions.register(v);
  world
    .addSystem(actionSystem(actions))
    .addSystem(playerDriveSystem())
    .addSystem(aggroSystem())
    .addSystem(behaviorSystem())
    .addSystem(movementSystem(grid))
    .addSystem(collisionSystem(grid))
    .addSystem(combatSystem());
  let driver: CognitionDriver | null = null;
  if (withCognition) {
    driver = new CognitionDriver({
      provider: new MockProvider([
        { text: "", toolCalls: [{ id: "1", name: "move_to", args: { x: 150, y: 0 } }], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, model: "mock" },
      ]),
      actions,
      grid,
    });
    world.addSystem(driver.system());
  }
  return { world, actions, driver };
}

function spawnCast(world: World) {
  const player = world.create();
  world.add(player, Transform, { x: 0, y: 0 });
  world.add(player, Velocity, { maxSpeed: 170 });
  world.add(player, Collider, { radius: 12 });
  world.add(player, PlayerControlled, {});
  world.add(player, Behavior, { mode: "idle" });
  world.add(player, Attack, { windup: 0, knockback: 100 });
  world.add(player, Health, {});
  world.add(player, Faction, { id: "heroes", hostileTo: ["beasts"] });
  world.add(player, Speech, {});
  const foe = world.create();
  world.add(foe, Transform, { x: 120, y: 40 });
  world.add(foe, Velocity, { maxSpeed: 90 });
  world.add(foe, Collider, { radius: 10 });
  world.add(foe, Behavior, { mode: "idle" });
  world.add(foe, Attack, { damage: 3 });
  world.add(foe, Health, { hp: 40, maxHp: 40 });
  world.add(foe, Faction, { id: "beasts", hostileTo: ["heroes"] });
  return { player, foe };
}

describe("replay — a session is seed + intent log", () => {
  it("a played session replays to byte-identical state", () => {
    const { world, actions } = buildSim();
    const { player, foe } = spawnCast(world);
    const rec = startRecording(world, actions);
    const loop = new GameLoop(world);

    // a little "played" session — intents enter through the queue so they
    // land IN-tick at the drain slot, exactly like live input and replays
    actions.submit({ actor: player, verb: "move", params: { x: 1, y: 0 } });
    loop.advance(30);
    actions.submit({ actor: player, verb: "move", params: { x: 0, y: 0 } });
    actions.submit({ actor: player, verb: "jump", params: {} });
    loop.advance(20);
    actions.submit({ actor: player, verb: "attack", params: { target: foe } });
    loop.advance(90);
    actions.submit({ actor: player, verb: "say", params: { text: "for the record" } });
    loop.advance(30);

    const session = rec.stop();
    const final = world.save();
    expect(session.log.length).toBeGreaterThan(4);

    // fresh world, same deterministic systems, replay INSTEAD of live input
    const ok = verifyReplay(session, () => {
      const sim = buildSim();
      return { world: sim.world, actions: sim.actions };
    }, TYPES, final);
    expect(ok).toBe(true);
  });

  it("replays LLM decisions without the LLM", async () => {
    const { world, actions, driver } = buildSim(true);
    const { player, foe } = spawnCast(world);
    world.add(foe, Mind, { thinkEvery: 0.05, fallbackMode: "idle", verbs: ["move_to"] });
    world.add(foe, MindMemory, {});
    const rec = startRecording(world, actions);
    const loop = new GameLoop(world);
    loop.advance(10); // dispatch the thought
    await driver!.settle(); // mock "LLM" returns move_to(150, 0)
    loop.advance(120); // intent lands via the queue and plays out
    void player;

    const session = rec.stop();
    const final = world.save();
    expect(session.log.some((a) => a.verb === "move_to")).toBe(true); // the mind's decision is in the log

    // replay into a world with NO cognition at all — the decision still happens
    const ok = verifyReplay(session, () => {
      const sim = buildSim(false);
      return { world: sim.world, actions: sim.actions };
    }, TYPES, final);
    expect(ok).toBe(true);
  });
});

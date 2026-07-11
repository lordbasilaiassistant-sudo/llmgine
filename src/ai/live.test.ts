import { describe, expect, it } from "vitest";
import { World } from "../core/ecs.js";
import { ActionRegistry, actionSystem } from "../core/actions.js";
import { SpatialGrid } from "../core/spatial.js";
import { PrefabRegistry } from "../core/prefab.js";
import { ALL_COMPONENTS, Behavior, Named, Speech, Transform, Velocity, Health, Faction } from "../components.js";
import { STANDARD_VERBS } from "../verbs.js";
import { Mind, MindMemory } from "./mind.js";
import { CognitionDriver } from "./cognition.js";
import { OpenAICompatibleProvider } from "./provider.js";
import { Genesis } from "./genesis.js";

/**
 * LIVE acceptance tests — a real GLM flash model drives a real Mind inside a
 * real sim. This is the "LLM in the core" proof: perception in, validated
 * intents out, zero mocks.
 */

const hasKey = !!(process.env.ZAI_API_KEY || process.env.LLM_API_KEY);

describe.skipIf(!hasKey)("LIVE: GLM-driven cognition", () => {
  it("a Mind perceives the world and acts through the intent pipeline", async () => {
    const world = new World(99);
    const grid = new SpatialGrid();
    const actions = new ActionRegistry();
    for (const v of STANDARD_VERBS) actions.register(v);
    const provider = new OpenAICompatibleProvider();
    const thoughts: any[] = [];
    const driver = new CognitionDriver({
      provider,
      actions,
      grid,
      onThought: (t) => thoughts.push(t),
    });
    world.addSystem(actionSystem(actions));
    world.addSystem(driver.system());

    // an intruder the guard can see
    const intruder = world.create();
    world.add(intruder, Transform, { x: 60, y: 0 });
    world.add(intruder, Named, { name: "Hooded Stranger", blurb: "lurking near the gate" });
    world.add(intruder, Health);
    world.add(intruder, Faction, { id: "outlaws" });
    grid.set(intruder, 60, 0);

    const guard = world.create();
    world.add(guard, Transform, { x: 0, y: 0 });
    world.add(guard, Velocity);
    world.add(guard, Speech);
    world.add(guard, Behavior, { mode: "idle" });
    world.add(guard, Named, { name: "Gate Guard" });
    world.add(guard, Faction, { id: "town", hostileTo: ["outlaws"] });
    world.add(guard, Mind, {
      persona: "A vigilant town gate guard. Suspicious of strangers. You challenge anyone lurking.",
      goals: ["guard the gate", "challenge suspicious strangers"],
      thinkEvery: 5,
      cooldown: 0,
    });
    world.add(guard, MindMemory);

    world.step(1 / 60); // dispatch thought
    await driver.settle(); // real GLM call
    world.step(1 / 60); // drain resulting actions

    console.log("GLM thought:", JSON.stringify(thoughts, null, 2));
    console.log("action log:", JSON.stringify(actions.log, null, 2));
    console.log("guard speech:", world.require(guard, Speech).text);
    console.log("guard behavior:", world.require(guard, Behavior).mode);

    expect(thoughts).toHaveLength(1);
    expect(thoughts[0].error).toBeUndefined();
    // the mind did SOMETHING observable: spoke or moved or acted
    const spoke = world.require(guard, Speech).text.length > 0;
    const acted = actions.log.length > 0;
    expect(spoke || acted).toBe(true);
  });

  it("Genesis generates a valid prefab with a real model", async () => {
    const prefabs = new PrefabRegistry().registerComponents(ALL_COMPONENTS);
    const provider = new OpenAICompatibleProvider();
    const g = new Genesis({ provider, prefabs, tier: "fast" });
    const prefab = await g.generatePrefab(
      "a venomous swamp lurker mini-boss, tanky but slow, drops rare loot",
    );
    console.log("generated prefab:", JSON.stringify(prefab, null, 2));
    expect(prefabs.get(prefab.name)).toBeDefined();
    // it must be spawnable
    const world = new World();
    const e = prefabs.spawn(world, prefab.name);
    expect(world.isAlive(e)).toBe(true);
  });
});

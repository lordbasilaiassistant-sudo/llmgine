import { describe, expect, it } from "vitest";
import { World } from "../core/ecs.js";
import { ActionRegistry, actionSystem } from "../core/actions.js";
import { SpatialGrid } from "../core/spatial.js";
import { Behavior, Named, Speech, Transform, Velocity } from "../components.js";
import { sayVerb, moveToVerb } from "../verbs.js";
import { Mind, MindMemory } from "./mind.js";
import { CognitionDriver } from "./cognition.js";
import { MockProvider } from "./provider.js";
import { InferenceBudget } from "./budget.js";
import { Voice, SilentVoice, voiceSystem } from "./voice.js";

function setup(provider: MockProvider, budget?: InferenceBudget) {
  const world = new World(7);
  const grid = new SpatialGrid();
  const actions = new ActionRegistry().register(sayVerb).register(moveToVerb);
  const driver = new CognitionDriver({ provider, actions, grid, budget });
  world.addSystem(actionSystem(actions));
  world.addSystem(driver.system());

  const npc = world.create();
  world.add(npc, Transform, { x: 0, y: 0 });
  world.add(npc, Velocity);
  world.add(npc, Speech);
  world.add(npc, Behavior, { mode: "idle" });
  world.add(npc, Named, { name: "Guard" });
  world.add(npc, Mind, { persona: "A stoic guard.", thinkEvery: 1, cooldown: 0 });
  world.add(npc, MindMemory);
  return { world, grid, actions, driver, npc };
}

const dt = 1 / 60;

describe("cognition", () => {
  it("a Mind thinks, and its tool calls become validated actions next tick", async () => {
    const provider = new MockProvider([
      { toolCalls: [{ id: "1", name: "say", args: { text: "Halt!" } }] },
    ]);
    const { world, driver, npc } = setup(provider);
    world.step(dt); // dispatches the thought
    await driver.settle();
    world.step(dt); // drains the queued action
    expect(world.require(npc, Speech).text).toBe("Halt!");
    expect(provider.calls).toHaveLength(1);
    // perception + persona actually reached the model
    const sys = provider.calls[0].messages[0].content as string;
    expect(sys).toContain("stoic guard");
    expect(provider.calls[0].tools!.length).toBe(2);
  });

  it("plain-text replies become speech (flash models often skip tool calls)", async () => {
    const provider = new MockProvider([{ text: "Who goes there?" }]);
    const { world, driver, npc } = setup(provider);
    world.step(dt);
    await driver.settle();
    world.step(dt);
    expect(world.require(npc, Speech).text).toBe("Who goes there?");
  });

  it("hallucinated verbs are rejected by the action gate, not crashed on", async () => {
    const provider = new MockProvider([
      { toolCalls: [{ id: "1", name: "teleport", args: { x: 9e9 } }] },
    ]);
    const { world, driver, npc } = setup(provider);
    world.step(dt);
    await driver.settle();
    expect(() => world.step(dt)).not.toThrow();
    expect(world.require(npc, Transform).x).toBe(0);
  });

  it("falls back to deterministic behavior on provider failure", async () => {
    const provider = new MockProvider([new Error("api down")]);
    const { world, driver, npc } = setup(provider);
    world.require(npc, Mind).fallbackMode = "wander";
    world.step(dt);
    await driver.settle();
    expect(world.require(npc, Behavior).mode).toBe("wander");
    const mem = world.require(npc, MindMemory);
    expect(mem.shortTerm.some((s) => s.text.includes("instinct"))).toBe(true);
  });

  it("falls back when the budget is exhausted — zero LLM calls", () => {
    const provider = new MockProvider();
    const budget = new InferenceBudget({ maxTotal: 0, requestsPerMinute: 0 });
    const { world, npc } = setup(provider, budget);
    world.step(dt);
    expect(provider.calls).toHaveLength(0);
    expect(world.require(npc, Behavior).mode).toBe("wander");
  });

  it("wake events trigger immediate thought before cadence elapses", async () => {
    const provider = new MockProvider([{ text: "ow" }, { text: "ow again" }]);
    const { world, driver, npc } = setup(provider);
    const mind = world.require(npc, Mind);
    mind.thinkEvery = 9999;
    world.step(dt); // first thought (cooldown was 0)
    await driver.settle();
    world.step(dt);
    expect(provider.calls).toHaveLength(1);
    // now damage it — wakeOn includes combat:damaged by default
    world.events.emit("combat:damaged", { target: npc, source: npc, amount: 5 });
    world.step(dt);
    await driver.settle();
    expect(provider.calls).toHaveLength(2);
  });

  it("speech from entities with Voice reaches the voice service", async () => {
    const provider = new MockProvider([{ text: "hello traveler" }]);
    const { world, driver, npc } = setup(provider);
    const speaker = new SilentVoice();
    world.addSystem(voiceSystem(speaker));
    world.add(npc, Voice, { voiceId: "guard-1" });
    world.step(dt);
    await driver.settle();
    world.step(dt);
    expect(speaker.spoken).toHaveLength(1);
    expect(speaker.spoken[0].text).toBe("hello traveler");
    expect(speaker.spoken[0].opts?.voiceId).toBe("guard-1");
  });
});

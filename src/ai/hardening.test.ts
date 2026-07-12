import { describe, expect, it } from "vitest";
import { World, GameLoop } from "../index.js";
import { ActionRegistry, actionSystem } from "../core/actions.js";
import { SpatialGrid } from "../core/spatial.js";
import { Behavior, Health, Speech, Transform, Velocity, ALL_COMPONENTS } from "../components.js";
import { STANDARD_VERBS } from "../verbs.js";
import { behaviorSystem } from "../systems/behavior.js";
import { movementSystem } from "../systems/movement.js";
import { CognitionDriver } from "./cognition.js";
import { Mind, MindMemory } from "./mind.js";
import { MockProvider, OpenAICompatibleProvider } from "./provider.js";
import { InferenceBudget } from "./budget.js";

/** Regression tests for the AI-layer audit findings (#22, #23). */

function setup(provider: MockProvider | OpenAICompatibleProvider, budget?: InferenceBudget) {
  const world = new World(3);
  const grid = new SpatialGrid();
  const actions = new ActionRegistry();
  for (const v of STANDARD_VERBS) actions.register(v);
  const driver = new CognitionDriver({ provider: provider as any, actions, grid, budget });
  world
    .addSystem(actionSystem(actions))
    .addSystem(behaviorSystem())
    .addSystem(movementSystem(grid))
    .addSystem(driver.system());
  return { world, actions, driver };
}

function mkMind(world: World, opts: Record<string, any> = {}) {
  const e = world.create();
  world.add(e, Transform, {});
  world.add(e, Velocity, {});
  world.add(e, Speech, {});
  world.add(e, Behavior, { mode: "idle" });
  world.add(e, Mind, { thinkEvery: 0.03, fallbackMode: "wander", ...opts });
  world.add(e, MindMemory, {});
  return e;
}

describe("cognition robustness (#22)", () => {
  it("a Mind on a Transform-less entity still thinks (disembodied minds)", async () => {
    const provider = new MockProvider([{ text: "the winds shift" }]);
    const { world, driver } = setup(provider);
    const e = world.create(); // no Transform — a weather director
    world.add(e, Speech, {});
    world.add(e, Mind, { thinkEvery: 0.03 });
    new GameLoop(world).advance(5);
    await driver.settle();
    expect(provider.calls.length).toBe(1); // it thought, no silent no-op
  });

  it("errors thrown before the provider call still apply the fallback", async () => {
    // a provider whose chat throws synchronously during argument prep
    const provider = new MockProvider([new Error("early boom")]);
    const { world, driver } = setup(provider);
    const e = mkMind(world);
    new GameLoop(world).advance(5);
    await driver.settle();
    new GameLoop(world).advance(1);
    expect(world.require(e, Behavior).mode).toBe("wander");
  });

  it("stale thoughts are dropped after a world rewind (quickload)", async () => {
    let release: (v: any) => void = () => {};
    const gate = new Promise((r) => (release = r));
    const provider = {
      supportsVision: false,
      calls: 0,
      async chat() {
        (this as any).calls++;
        await gate;
        return {
          text: "",
          toolCalls: [{ id: "1", name: "move_to", args: { x: 99, y: 99 } }],
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          model: "mock",
        };
      },
    };
    const { world, driver } = setup(provider as any);
    const e = mkMind(world);
    const snap = world.save();
    new GameLoop(world).advance(5); // dispatches the thought at tick ~2
    world.load(snap, [...ALL_COMPONENTS, Mind, MindMemory]); // rewind to tick 0
    release(null); // thought resolves AFTER the rewind
    await driver.settle();
    new GameLoop(world).advance(2); // drain queue
    expect(world.require(e, Behavior).mode).toBe("idle"); // stale move_to never applied
  });

  it("a save carrying thinking=true does not lobotomize the mind", async () => {
    const provider = new MockProvider([{ text: "alive!" }]);
    const { world, driver } = setup(provider);
    const e = mkMind(world);
    world.require(e, Mind).thinking = true; // as restored from a mid-thought save
    new GameLoop(world).advance(5);
    await driver.settle();
    expect(provider.calls.length).toBe(1); // driver dispatched anyway
  });

  it("over-budget minds degrade silently to fallback", async () => {
    const provider = new MockProvider([]);
    const { world, driver } = setup(provider, new InferenceBudget({ maxTotal: 0, requestsPerMinute: 0 }));
    const e = mkMind(world);
    new GameLoop(world).advance(5);
    await driver.settle();
    new GameLoop(world).advance(1);
    expect(world.require(e, Behavior).mode).toBe("wander");
    expect(provider.calls.length).toBe(0);
  });
});

describe("provider hardening (#23)", () => {
  const tools = [
    {
      type: "function",
      function: { name: "say", parameters: { properties: { text: { type: "string" } }, required: ["text"] } },
    },
  ];

  function fakeFetch(status: number, body: any): typeof fetch {
    return (async () =>
      new Response(typeof body === "string" ? body : JSON.stringify(body), { status })) as any;
  }

  it("chain-of-thought never lands in text", async () => {
    const p = new OpenAICompatibleProvider({
      apiKey: "k",
      baseUrl: "http://proxy.local/v1",
      fetchFn: fakeFetch(200, {
        choices: [{ message: { content: "", reasoning_content: "The user wants me to taunt, so I will…" } }],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      }),
    });
    const res = await p.chat({ tier: "fast", messages: [] });
    expect(res.text).toBe("");
    expect(res.reasoning).toContain("taunt");
    expect(res.usage.totalTokens).toBe(3);
  });

  it("non-2xx surfaces as a typed error (fallback path)", async () => {
    const p = new OpenAICompatibleProvider({
      apiKey: "k",
      fetchFn: fakeFetch(500, "upstream sad"),
    });
    await expect(p.chat({ tier: "fast", messages: [] })).rejects.toThrow(/LLM HTTP 500/);
  });

  it("malformed JSON body rejects instead of hanging", async () => {
    const p = new OpenAICompatibleProvider({ apiKey: "k", fetchFn: fakeFetch(200, "not json{{") });
    await expect(p.chat({ tier: "fast", messages: [] })).rejects.toThrow();
  });

  it("does not leak the api key through enumeration", () => {
    const p = new OpenAICompatibleProvider({ apiKey: "sk-secret" });
    expect(JSON.stringify(p)).not.toContain("sk-secret");
  });

  it("repairs XML-mangled tool calls against the request schema", async () => {
    const p = new OpenAICompatibleProvider({
      apiKey: "k",
      fetchFn: fakeFetch(200, {
        choices: [
          {
            message: {
              content: "",
              tool_calls: [
                { id: "1", function: { name: "say\n<arg_value>Halt!</arg_value>", arguments: "{}" } },
              ],
            },
          },
        ],
      }),
    });
    const res = await p.chat({ tier: "fast", messages: [], tools });
    expect(res.toolCalls[0]).toMatchObject({ name: "say", args: { text: "Halt!" } });
  });
});

describe("token budget (#23.4)", () => {
  it("denies once the rolling token window is spent", () => {
    const b = new InferenceBudget({ tokensPerMinute: 100, requestsPerMinute: 100 });
    expect(b.tryAcquire(1000)).toBe(true);
    b.noteUsage(150, 1000);
    b.release();
    expect(b.tryAcquire(2000)).toBe(false); // window spent
    expect(b.tryAcquire(62_000)).toBe(true); // window rolled off
  });
});

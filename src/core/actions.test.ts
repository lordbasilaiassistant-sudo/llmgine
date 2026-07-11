import { describe, expect, it } from "vitest";
import { World } from "./ecs.js";
import { ActionRegistry, actionSystem } from "./actions.js";
import { Speech, Transform } from "../components.js";

function sayVerb() {
  return {
    name: "say",
    description: "Speak aloud",
    params: { text: { type: "string" as const, required: true } },
    validate: (w: World, a: { actor: number }) => (w.has(a.actor, Speech) ? null : "cannot speak"),
    resolve: (w: World, a: any) => {
      const s = w.require(a.actor, Speech);
      s.text = String(a.params.text);
      s.ttl = 3;
    },
  };
}

describe("action pipeline", () => {
  it("executes valid actions and logs them", () => {
    const w = new World();
    const reg = new ActionRegistry().register(sayVerb());
    const e = w.create();
    w.add(e, Speech);
    const res = reg.execute(w, { actor: e, verb: "say", params: { text: "hello" } });
    expect(res.ok).toBe(true);
    expect(w.require(e, Speech).text).toBe("hello");
    expect(reg.log).toHaveLength(1);
  });

  it("rejects unknown verbs, missing params, and incapable actors", () => {
    const w = new World();
    const reg = new ActionRegistry().register(sayVerb());
    const mute = w.create(); // no Speech component
    expect(reg.execute(w, { actor: mute, verb: "teleport", params: {} }).error).toMatch(/unknown verb/);
    expect(reg.execute(w, { actor: mute, verb: "say", params: {} }).error).toMatch(/missing param/);
    expect(reg.execute(w, { actor: mute, verb: "say", params: { text: "hi" } }).error).toBe("cannot speak");
    expect(reg.log).toHaveLength(0);
  });

  it("drains async-submitted actions on the next tick", () => {
    const w = new World();
    const reg = new ActionRegistry().register(sayVerb());
    w.addSystem(actionSystem(reg));
    const e = w.create();
    w.add(e, Speech);
    reg.submit({ actor: e, verb: "say", params: { text: "from a mind" } }); // async context
    expect(w.require(e, Speech).text).toBe("");
    w.step(1 / 60);
    expect(w.require(e, Speech).text).toBe("from a mind");
  });

  it("exports verbs as LLM tool schema", () => {
    const reg = new ActionRegistry().register(sayVerb());
    const tools = reg.toToolSchema();
    expect(tools[0].function.name).toBe("say");
    expect(tools[0].function.parameters.required).toEqual(["text"]);
  });

  it("rejects actions from dead actors", () => {
    const w = new World();
    const reg = new ActionRegistry().register(sayVerb());
    const e = w.create();
    w.add(e, Speech);
    w.destroyNow(e);
    expect(reg.execute(w, { actor: e, verb: "say", params: { text: "ghost" } }).error).toBe("actor is dead");
  });
});

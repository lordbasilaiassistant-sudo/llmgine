import { describe, expect, it } from "vitest";
import { applyComponentJson, attachInspector, entityLabel } from "./inspector.js";

describe("applyComponentJson", () => {
  it("merges parsed JSON onto the live ref", () => {
    const live = { x: 1, y: 2, tag: "a" };
    const res = applyComponentJson(live, '{"x": 10, "tag": "b"}');
    expect(res).toEqual({ ok: true });
    expect(live).toEqual({ x: 10, y: 2, tag: "b" }); // same object, merged
  });

  it("reports parse errors without throwing or mutating", () => {
    const live = { x: 1 };
    const res = applyComponentJson(live, "{not json");
    expect(res.ok).toBe(false);
    expect(res.error).toBeTruthy();
    expect(live).toEqual({ x: 1 });
  });

  it.each(["[1,2]", "null", '"str"', "42"])("rejects non-object JSON %s", (json) => {
    const live = { x: 1 };
    const res = applyComponentJson(live, json);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/plain object/);
    expect(live).toEqual({ x: 1 });
  });
});

describe("entityLabel", () => {
  it("prefers Named.name, shows rounded hp", () => {
    expect(
      entityLabel(7, {
        Named: { name: "goblin" },
        Sprite: { kind: "circle" },
        Health: { hp: 33.6, maxHp: 50 },
      }),
    ).toBe("#7 goblin 34/50hp");
  });

  it("falls back to Sprite.kind, clamps hp at 0", () => {
    expect(entityLabel(3, { Sprite: { kind: "crate" }, Health: { hp: -5, maxHp: 10 } })).toBe(
      "#3 crate 0/10hp",
    );
  });

  it("bare id when nothing to show", () => {
    expect(entityLabel(1, {})).toBe("#1");
  });
});

describe("attachInspector headless guard", () => {
  it("throws a clear error when document is undefined", () => {
    expect(typeof document).toBe("undefined"); // unit tests run in Node
    expect(() => attachInspector({} as any)).toThrow(/document is undefined/);
  });
});

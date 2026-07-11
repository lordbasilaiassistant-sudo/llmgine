import { describe, expect, it } from "vitest";
import { repairToolCall } from "./provider.js";

const TOOLS = [
  { type: "function", function: { name: "say", parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } } },
  { type: "function", function: { name: "move_to", parameters: { type: "object", properties: { x: { type: "number" }, y: { type: "number" } }, required: ["x", "y"] } } },
];

describe("repairToolCall (GLM flash malformed tool calls)", () => {
  it("passes well-formed calls through untouched", () => {
    expect(repairToolCall("say", { text: "hi" }, TOOLS)).toEqual({ name: "say", args: { text: "hi" } });
  });

  it("recovers the exact degenerate payload captured live from glm-4.5-flash", () => {
    const r = repairToolCall("say\n<arg_value>Welcome to the pit, little lamb!</arg_value>", {}, TOOLS);
    expect(r.name).toBe("say");
    expect(r.args).toEqual({ text: "Welcome to the pit, little lamb!" });
  });

  it("maps arg_key/arg_value pairs and coerces numbers", () => {
    const raw = "move_to\n<arg_key>x</arg_key>\n<arg_value>120</arg_value>\n<arg_key>y</arg_key>\n<arg_value>-40</arg_value>";
    expect(repairToolCall(raw, {}, TOOLS)).toEqual({ name: "move_to", args: { x: 120, y: -40 } });
  });

  it("keeps parsed args and cleans the name when both are present", () => {
    const r = repairToolCall("say\n<extra>junk</extra>", { text: "kept" }, TOOLS);
    expect(r).toEqual({ name: "say", args: { text: "kept" } });
  });
});

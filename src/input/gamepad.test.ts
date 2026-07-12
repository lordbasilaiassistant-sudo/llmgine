import { afterEach, describe, expect, it, vi } from "vitest";
import { GamepadInput } from "./gamepad.js";

function stubPad(pad: Partial<Gamepad> | null): void {
  vi.stubGlobal("navigator", { getGamepads: () => [pad] });
}

const button = (pressed: boolean) => ({ pressed, touched: pressed, value: pressed ? 1 : 0 });

describe("gamepad", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reads the left stick on standard-mapping pads", () => {
    stubPad({ connected: true, mapping: "standard", axes: [0.9, 0], buttons: [] });
    const input = new GamepadInput();
    input.poll();
    expect(input.state.active).toBe(true);
    expect(input.state.x).toBeGreaterThan(0.8);
    expect(input.state.y).toBe(0);
  });

  it("ignores axes on non-standard mappings (flight sticks) but keeps buttons", () => {
    const fire = vi.fn();
    stubPad({ connected: true, mapping: "" as GamepadMappingType, axes: [1, 1], buttons: [button(true)] });
    const input = new GamepadInput({ buttons: { 0: fire } });
    input.poll();
    expect(input.state.x).toBe(0);
    expect(input.state.y).toBe(0);
    expect(input.state.active).toBe(false);
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it("buttons fire on press edge only", () => {
    const fire = vi.fn();
    stubPad({ connected: true, mapping: "standard", axes: [0, 0], buttons: [button(true)] });
    const input = new GamepadInput({ buttons: { 0: fire } });
    input.poll();
    input.poll(); // held — no second fire
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it("no-ops without a pad", () => {
    stubPad(null);
    const input = new GamepadInput();
    input.poll();
    expect(input.state).toEqual({ x: 0, y: 0, active: false });
  });
});

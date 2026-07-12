import { describe, expect, it } from "vitest";
import { JOYSTICK_DEADZONE, isUiTouch, joystickVector, touchZone } from "./touch.js";

describe("touch zones", () => {
  it("splits by the target's own rect, not the viewport", () => {
    // 800px-wide target starting at x=100, moveZone 0.45 → split at clientX 460
    expect(touchZone(459, 100, 800, 0.45)).toBe("move");
    expect(touchZone(460, 100, 800, 0.45)).toBe("action");
    // same clientX, different rect → different zone (the innerWidth bug)
    expect(touchZone(459, 300, 800, 0.45)).toBe("move");
    expect(touchZone(661, 300, 800, 0.45)).toBe("action");
  });
});

describe("joystick dead zone", () => {
  const r = 56;

  it("zero displacement is zero", () => {
    expect(joystickVector(0, 0, r)).toEqual({ x: 0, y: 0 });
  });

  it("resting-thumb jitter inside the dead zone reads as zero", () => {
    const dx = r * JOYSTICK_DEADZONE * 0.9;
    expect(joystickVector(dx, 0, r)).toEqual({ x: 0, y: 0 });
    expect(joystickVector(0, -dx, r)).toEqual({ x: 0, y: 0 });
  });

  it("re-scales past the dead zone so full deflection still reaches 1", () => {
    const full = joystickVector(r * 2, 0, r); // clamped to radius
    expect(full.x).toBeCloseTo(1);
    expect(full.y).toBeCloseTo(0);
    const half = joystickVector(r * 0.5, 0, r);
    expect(half.x).toBeCloseTo((0.5 - JOYSTICK_DEADZONE) / (1 - JOYSTICK_DEADZONE));
  });

  it("preserves direction", () => {
    const v = joystickVector(30, 40, r); // 3-4-5 triangle
    expect(v.x / v.y).toBeCloseTo(3 / 4);
    expect(Math.hypot(v.x, v.y)).toBeLessThanOrEqual(1);
  });
});

describe("UI touch escape", () => {
  const el = (matches: boolean) => ({ closest: () => (matches ? {} : null) }) as unknown as EventTarget;

  it("touches on buttons/inputs/[data-ui] are left to the UI", () => {
    expect(isUiTouch(el(true))).toBe(true);
  });

  it("touches on the game surface are handled", () => {
    expect(isUiTouch(el(false))).toBe(false);
    expect(isUiTouch(null)).toBe(false);
    expect(isUiTouch({} as EventTarget)).toBe(false); // no closest (non-Element target)
  });
});

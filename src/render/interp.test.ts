import { describe, expect, it } from "vitest";
import { TransformLerp, lerp, lerpAngle } from "./interp.js";

describe("render interpolation", () => {
  it("lerp blends linearly", () => {
    expect(lerp(0, 10, 0)).toBe(0);
    expect(lerp(0, 10, 0.5)).toBe(5);
    expect(lerp(0, 10, 1)).toBe(10);
  });

  it("lerpAngle takes the shortest path across ±π", () => {
    // 170° → -170° should pass through 180°, not spin back through 0
    const a = (170 * Math.PI) / 180;
    const b = (-170 * Math.PI) / 180;
    const mid = lerpAngle(a, b, 0.5);
    expect(Math.abs(mid)).toBeCloseTo(Math.PI, 5);
    expect(lerpAngle(0, Math.PI / 2, 0.5)).toBeCloseTo(Math.PI / 4, 10);
  });

  it("first sample renders at the sampled position (no streak from origin)", () => {
    const xf = new TransformLerp();
    xf.sample(1, 100, 50, 0);
    expect(xf.at(1, 0)).toEqual({ x: 100, y: 50, rot: 0, z: 0 });
    expect(xf.at(1, 0.99)).toEqual({ x: 100, y: 50, rot: 0, z: 0 });
  });

  it("interpolates between the previous and current tick by alpha", () => {
    const xf = new TransformLerp();
    xf.sample(1, 0, 0, 0);
    xf.sample(1, 10, 20, 1); // new tick landed
    expect(xf.at(1, 0)).toEqual({ x: 0, y: 0, rot: 0, z: 0 });
    const half = xf.at(1, 0.5)!;
    expect(half.x).toBeCloseTo(5);
    expect(half.y).toBeCloseTo(10);
    expect(half.rot).toBeCloseTo(0.5);
    expect(xf.at(1, 1)).toEqual({ x: 10, y: 20, rot: 1, z: 0 });
  });

  it("re-sampling the same values keeps the pair (multiple draws per tick)", () => {
    const xf = new TransformLerp();
    xf.sample(1, 0, 0, 0);
    xf.sample(1, 10, 0, 0);
    xf.sample(1, 10, 0, 0); // second draw, same tick
    expect(xf.at(1, 0.5)!.x).toBeCloseTo(5); // prev is still the old tick
  });

  it("advances the pair when the next tick lands", () => {
    const xf = new TransformLerp();
    xf.sample(1, 0, 0, 0);
    xf.sample(1, 10, 0, 0);
    xf.sample(1, 20, 0, 0);
    expect(xf.at(1, 0)!.x).toBe(10);
    expect(xf.at(1, 1)!.x).toBe(20);
  });

  it("snaps on teleport-sized jumps instead of streaking", () => {
    const xf = new TransformLerp(120);
    xf.sample(1, 0, 0, 0);
    xf.sample(1, 500, 0, 0); // respawn across the map
    expect(xf.at(1, 0)!.x).toBe(500);
  });

  it("prunes despawned entities and forgets their history", () => {
    const xf = new TransformLerp();
    xf.sample(1, 0, 0, 0);
    xf.sample(2, 5, 5, 0);
    xf.prune(new Set([2]));
    expect(xf.at(1, 0.5)).toBeUndefined();
    expect(xf.at(2, 0.5)).toBeDefined();
  });
});

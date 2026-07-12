import { describe, expect, it } from "vitest";
import { resolveBloom, type BloomOptions, type ThreeRendererOptions } from "./three.js";

/**
 * Bloom is WebGL post-processing — vitest has no GL context, so ThreeRenderer
 * can't be constructed here. What CAN be locked down without a browser:
 * option resolution (defaults / off / overrides) and the option surface's
 * type conformance. The visual path is covered by demo:build + live demo.
 */

describe("bloom option resolution", () => {
  it("is OFF by default (undefined / false → null)", () => {
    expect(resolveBloom(undefined)).toBeNull();
    expect(resolveBloom(false)).toBeNull();
  });

  it("bloom: true → tuned defaults (accent, not white-out)", () => {
    expect(resolveBloom(true)).toEqual({ strength: 0.55, radius: 0.3, threshold: 0.85 });
  });

  it("empty object → same defaults as true", () => {
    expect(resolveBloom({})).toEqual(resolveBloom(true));
  });

  it("partial overrides merge over defaults", () => {
    expect(resolveBloom({ strength: 1.2 })).toEqual({
      strength: 1.2,
      radius: 0.3,
      threshold: 0.85,
    });
    expect(resolveBloom({ radius: 0.8, threshold: 0.5 })).toEqual({
      strength: 0.55,
      radius: 0.8,
      threshold: 0.5,
    });
  });

  it("threshold 0 / strength 0 are respected (not treated as unset)", () => {
    expect(resolveBloom({ strength: 0, threshold: 0 })).toEqual({
      strength: 0,
      radius: 0.3,
      threshold: 0,
    });
  });

  it("ThreeRendererOptions accepts boolean and object bloom (type conformance)", () => {
    const asBool: ThreeRendererOptions = { bloom: true };
    const asObj: ThreeRendererOptions = { bloom: { strength: 0.7, radius: 0.2, threshold: 0.9 } };
    const partial: BloomOptions = { strength: 0.7 };
    expect(asBool.bloom).toBe(true);
    expect(typeof asObj.bloom).toBe("object");
    expect(partial.strength).toBe(0.7);
  });
});

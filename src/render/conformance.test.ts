import { describe, expect, it } from "vitest";
import type { World } from "../core/ecs.js";
import type { Renderer } from "./renderer.js";
import { HeadlessRenderer } from "./renderer.js";
import type { Canvas2DRenderer } from "./canvas2d.js";
import type { ThreeRenderer } from "../render3d/three.js";

/**
 * Renderer conformance (issue #24). TypeScript's structural typing lets a
 * NARROWER capture() signature satisfy the Renderer interface — which is
 * exactly how ThreeRenderer shipped ignoring (world, x, y, radius). These
 * assertions fail `npm run typecheck` if any renderer's capture drifts from
 * the exact 4-arg contract again.
 */
type CaptureParams = [world: World, x: number, y: number, radius: number];
type AssertExact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

describe("renderer conformance", () => {
  it("all three renderers type capture(world, x, y, radius) exactly", () => {
    const headless: AssertExact<Parameters<HeadlessRenderer["capture"]>, CaptureParams> = true;
    const canvas2d: AssertExact<Parameters<Canvas2DRenderer["capture"]>, CaptureParams> = true;
    const three: AssertExact<Parameters<ThreeRenderer["capture"]>, CaptureParams> = true;
    expect(headless && canvas2d && three).toBe(true);
  });

  it("all three renderers type draw(world, alpha)", () => {
    type DrawWorldAlpha<T extends Renderer> = Parameters<T["draw"]> extends [World, number?]
      ? true
      : Parameters<T["draw"]> extends [World, number]
        ? true
        : never;
    const headless: DrawWorldAlpha<HeadlessRenderer> = true;
    const canvas2d: DrawWorldAlpha<Canvas2DRenderer> = true;
    const three: DrawWorldAlpha<ThreeRenderer> = true;
    expect(headless && canvas2d && three).toBe(true);
  });

  it("HeadlessRenderer returns null pixels", () => {
    const r: Renderer = new HeadlessRenderer();
    expect(r.capture({} as World, 0, 0, 100)).toBeNull();
  });
});

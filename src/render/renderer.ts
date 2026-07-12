import type { World } from "../core/ecs.js";

/**
 * Renderer abstraction. The sim never knows how (or whether) it is drawn —
 * tests and servers use HeadlessRenderer; browsers use Canvas2DRenderer; a 3D
 * adapter (three.js) plugs in here later without touching core.
 *
 * capture() is part of the contract because it feeds the vision pipeline:
 * Eyes in "pixels" mode ask the renderer for a view from an entity's
 * position and send it to a multimodal model. Real sight.
 */
export interface Renderer {
  /** Draw the current world state. alpha = interpolation factor [0,1). */
  draw(world: World, alpha: number): void;
  /**
   * Capture a region of the world view as a data URL (png), centered on
   * (x, y) world units, covering `radius` around it. Returns null if this
   * renderer cannot produce pixels (headless).
   */
  capture(world: World, x: number, y: number, radius: number): string | null;
  resize?(width: number, height: number): void;
}

/** No-op renderer for tests, servers, and MCP headless simulation. */
export class HeadlessRenderer implements Renderer {
  draw(_world: World, _alpha: number): void {}
  capture(_world: World, _x: number, _y: number, _radius: number): string | null {
    return null;
  }
}

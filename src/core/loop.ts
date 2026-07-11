import type { World } from "./ecs.js";

export interface LoopOptions {
  /** Fixed simulation timestep in seconds. Default 1/60. */
  timestep?: number;
  /** Max sim steps per frame (spiral-of-death guard). Default 5. */
  maxStepsPerFrame?: number;
  /** Called after sim steps each frame, with interpolation alpha [0,1). */
  render?: (alpha: number) => void;
}

/**
 * Fixed-timestep game loop. The simulation always advances in exact `timestep`
 * increments regardless of frame rate; rendering interpolates between steps.
 * Works in the browser (requestAnimationFrame) and headless (manual/run).
 */
export class GameLoop {
  readonly timestep: number;
  private maxSteps: number;
  private render?: (alpha: number) => void;
  private accumulator = 0;
  private last = 0;
  private rafId: number | null = null;
  running = false;

  constructor(readonly world: World, opts: LoopOptions = {}) {
    this.timestep = opts.timestep ?? 1 / 60;
    this.maxSteps = opts.maxStepsPerFrame ?? 5;
    this.render = opts.render;
  }

  /** Advance the sim exactly n ticks (headless / tests / MCP run_sim). */
  advance(n: number): void {
    for (let i = 0; i < n; i++) this.world.step(this.timestep);
  }

  /** Feed a real-time frame (ms timestamp). Used by start(); callable manually. */
  frame(nowMs: number): void {
    if (this.last === 0) this.last = nowMs;
    this.accumulator += Math.min((nowMs - this.last) / 1000, 0.25);
    this.last = nowMs;
    let steps = 0;
    while (this.accumulator >= this.timestep && steps < this.maxSteps) {
      this.world.step(this.timestep);
      this.accumulator -= this.timestep;
      steps++;
    }
    if (steps === this.maxSteps) this.accumulator = 0; // drop backlog
    this.render?.(this.accumulator / this.timestep);
  }

  /** Start a requestAnimationFrame-driven loop (browser). */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.last = 0;
    const raf =
      typeof requestAnimationFrame !== "undefined"
        ? requestAnimationFrame.bind(globalThis) // unbound raf throws "Illegal invocation"
        : (cb: FrameRequestCallback) =>
            setTimeout(() => cb(performance.now()), this.timestep * 1000) as unknown as number;
    const tick = (t: number) => {
      if (!this.running) return;
      this.frame(t);
      this.rafId = raf(tick);
    };
    this.rafId = raf(tick);
  }

  stop(): void {
    this.running = false;
    if (this.rafId !== null && typeof cancelAnimationFrame !== "undefined") {
      cancelAnimationFrame(this.rafId);
    }
    this.rafId = null;
  }
}

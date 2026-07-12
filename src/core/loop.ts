import type { World } from "./ecs.js";

export interface LoopOptions {
  /** Fixed simulation timestep in seconds. Default 1/60. */
  timestep?: number;
  /** Max sim steps per frame (spiral-of-death guard). Default 5. */
  maxStepsPerFrame?: number;
  /** Called after sim steps each frame, with interpolation alpha [0,1). */
  render?: (alpha: number) => void;
  /**
   * Keep the sim stepping while the tab is hidden (rAF stops firing there).
   * Uses a setInterval fallback at the sim timestep, without rendering.
   * Default true in browsers — an LLM-native game's minds shouldn't flatline
   * because the player switched tabs (and agents drive games headlessly).
   */
  runInBackground?: boolean;
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
  private runInBackground: boolean;
  private accumulator = 0;
  private last: number | null = null;
  private rafId: number | null = null;
  private bgTimer: ReturnType<typeof setInterval> | null = null;
  private visListener: (() => void) | null = null;
  running = false;
  /** True while the sim is being driven externally (AgentPort step/pause). */
  paused = false;

  constructor(readonly world: World, opts: LoopOptions = {}) {
    this.timestep = opts.timestep ?? 1 / 60;
    this.maxSteps = opts.maxStepsPerFrame ?? 5;
    this.render = opts.render;
    this.runInBackground = opts.runInBackground ?? true;
  }

  /** Advance the sim exactly n ticks (headless / tests / MCP run_sim / agents). */
  advance(n: number): void {
    for (let i = 0; i < n; i++) this.world.step(this.timestep);
  }

  /** Feed a real-time frame (ms timestamp). Used by start(); callable manually. */
  frame(nowMs: number): void {
    if (this.paused) {
      this.render?.(0);
      return;
    }
    // null sentinel, not 0 — a first rAF timestamp of exactly 0 is legal.
    // Backwards clock jumps clamp to 0 — negative dt must never accumulate
    // (a mixed timebase once buried the sim under -175s of debt).
    if (this.last === null) this.last = nowMs;
    this.accumulator += Math.min(Math.max((nowMs - this.last) / 1000, 0), 0.25);
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
    this.last = null;
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
    // rAF stops firing in hidden tabs — without this, the whole sim (and
    // every Mind in it) freezes when the player switches tabs
    if (this.runInBackground && typeof document !== "undefined") {
      this.visListener = () => {
        if (document.hidden && this.running) {
          // browsers clamp hidden-tab timers to ~1 Hz — step the ELAPSED
          // time per firing (capped), not one tick per firing, or the sim
          // crawls at 1/60th speed in the background
          let bgLast = performance.now();
          this.bgTimer ??= setInterval(() => {
            if (this.paused) return;
            const now = performance.now();
            let elapsed = Math.min((now - bgLast) / 1000, 2);
            bgLast = now;
            while (elapsed >= this.timestep) {
              this.world.step(this.timestep);
              elapsed -= this.timestep;
            }
            this.last = null; // resync the rAF timebase on return
          }, this.timestep * 1000);
        } else if (this.bgTimer !== null) {
          clearInterval(this.bgTimer);
          this.bgTimer = null;
        }
      };
      document.addEventListener("visibilitychange", this.visListener);
      this.visListener();
    }
  }

  stop(): void {
    this.running = false;
    if (this.rafId !== null && typeof cancelAnimationFrame !== "undefined") {
      cancelAnimationFrame(this.rafId);
    }
    this.rafId = null;
    if (this.bgTimer !== null) {
      clearInterval(this.bgTimer);
      this.bgTimer = null;
    }
    if (this.visListener && typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.visListener);
      this.visListener = null;
    }
  }
}

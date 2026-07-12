import type { Entity, System, World } from "../core/ecs.js";
import type { ActionRegistry } from "../core/actions.js";
import type { SpatialGrid } from "../core/spatial.js";
import { Behavior, Faction, Health, PlayerControlled, Velocity } from "../components.js";
import { TouchControls } from "./touch.js";
import { GamepadInput } from "./gamepad.js";

/**
 * Turns PlayerControlled.moveX/moveY (set by the `move` verb) into velocity
 * each tick. Pure sim logic — used identically in live play AND replays, so
 * a recorded session reproduces movement exactly. Add it wherever a player
 * exists (TopDownControls.system() includes it automatically).
 */
export function playerDriveSystem(): System {
  return {
    name: "player-drive",
    order: -25, // after input verbs land, before behavior
    update({ world }) {
      for (const e of world.query(PlayerControlled, Velocity)) {
        const pc = world.require(e, PlayerControlled);
        const v = world.require(e, Velocity);
        const active = pc.moveX !== 0 || pc.moveY !== 0;
        if (active) {
          v.vx = pc.moveX * v.maxSpeed;
          v.vy = pc.moveY * v.maxSpeed;
        } else {
          const b = world.get(e, Behavior);
          if (!b || b.mode === "idle") {
            v.vx = 0;
            v.vy = 0;
          }
        }
      }
    },
  };
}

/**
 * Standard top-down player controls — the conventions people already know
 * from a decade of ARPGs/MOBAs, so ANY game built on this engine is
 * intuitively playable out of the box:
 *
 *   WASD / arrows / left stick  — direct movement (always wins)
 *   click / tap on the ground   — move there (routes around obstacles via
 *                                 the move_to verb → NavGrid pathing)
 *   click / tap on an enemy     — attack it (chase into range via verb)
 *   Space                       — jump (the standard `jump` verb; falls back
 *                                 to the primary action if jump isn't registered)
 *   F / right touch zone        — primary action (game-defined)
 *
 * Direct input cancels click-to-move; releasing the keys mid-goto lets the
 * pathing finish. Everything indirect goes through the verb pipeline, so
 * player clicks, Minds, and agents all steer entities the same way.
 * Per-game remapping: pass your own `keyMap` / disable `clickToMove` —
 * the defaults are the contract, not a cage.
 */
export interface TopDownControlsOptions {
  world: World;
  actions: ActionRegistry;
  /** The controlled entity (getter, so restarts/respawns stay wired). */
  avatar: () => Entity;
  /** Screen → ground-plane world point (ThreeRenderer.groundPoint). Enables click/tap-to-move. */
  screenToWorld?: (clientX: number, clientY: number) => { x: number; y: number } | null;
  /** Spatial grid for click-to-attack target picking (optional). */
  grid?: SpatialGrid;
  /** Primary action (F / gamepad / touch action zone). Return the verb's
   * ActionResult (or `{ok:false}`) to enable input buffering: a press that
   * lands during a cooldown is retried for `bufferWindow` seconds instead of
   * being eaten — mashing attack always yields the next possible swing. */
  onAction?: () => void | { ok: boolean };
  /** Seconds a failed action/jump press stays buffered. Default 0.25 / 0.18. */
  bufferWindow?: number;
  /** Reuse existing input instances, or let the controller create its own. */
  touch?: TouchControls;
  gamepad?: GamepadInput;
  /** Clicks within this world distance of a hostile snap to attack. Default 34. */
  attackRadius?: number;
  /** Custom movement keys (lowercase `key` values) — defaults WASD + arrows. */
  keyMap?: { up: string[]; down: string[]; left: string[]; right: string[] };
  /** Keys that fire the primary action. Default ["f"]. */
  actionKeys?: string[];
  /** Keys that jump. Default [" "] (Space). */
  jumpKeys?: string[];
  /** Element for pointer events. Default: window (canvas clicks only). */
  clickTarget?: HTMLElement | Window;
}

const DEFAULT_KEYS = {
  up: ["w", "arrowup"],
  down: ["s", "arrowdown"],
  left: ["a", "arrowleft"],
  right: ["d", "arrowright"],
};

export class TopDownControls {
  readonly keys = new Set<string>();
  private opts: TopDownControlsOptions;
  private km: typeof DEFAULT_KEYS;
  private disposers: Array<() => void> = [];
  private moveMarker: { x: number; y: number; t: number } | null = null;
  private actionBuf = 0;
  private jumpBuf = 0;
  private pendingClick: { x: number; y: number } | null = null;
  private lastMoveX = 0;
  private lastMoveY = 0;

  constructor(opts: TopDownControlsOptions) {
    this.opts = opts;
    this.km = opts.keyMap ?? DEFAULT_KEYS;

    const actionKeys = opts.actionKeys ?? ["f"];
    const jumpKeys = opts.jumpKeys ?? [" "];
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const k = e.key.toLowerCase();
      this.keys.add(k);
      // intent only — verbs execute inside system() so every sim mutation
      // happens IN the tick (off-tick executes break replay determinism)
      if (jumpKeys.includes(e.key) || jumpKeys.includes(k)) {
        e.preventDefault();
        this.queueJump();
      } else if (actionKeys.includes(k)) {
        e.preventDefault();
        this.queueAction();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => this.keys.delete(e.key.toLowerCase());
    addEventListener("keydown", onKeyDown);
    addEventListener("keyup", onKeyUp);
    this.disposers.push(() => {
      removeEventListener("keydown", onKeyDown);
      removeEventListener("keyup", onKeyUp);
    });

    if (opts.screenToWorld) {
      const target: any = opts.clickTarget ?? window;
      const onPointer = (e: PointerEvent) => {
        if ((e.target as HTMLElement)?.tagName !== "CANVAS") return;
        // resolve the ground point now (render/camera state), act in-tick
        const p = opts.screenToWorld!(e.clientX, e.clientY);
        if (p) this.pendingClick = p;
      };
      target.addEventListener("pointerdown", onPointer);
      this.disposers.push(() => target.removeEventListener("pointerdown", onPointer));
    }
  }

  /** Where the last click-to-move order landed (for a destination marker VFX). */
  get destination(): { x: number; y: number; t: number } | null {
    return this.moveMarker;
  }

  /** Queue the primary action (buffered — a press during cooldown fires when ready). */
  queueAction(): void {
    this.actionBuf = this.opts.bufferWindow ?? 0.25;
  }

  /** Queue a jump (buffered — pressing just before landing still jumps). */
  queueJump(): void {
    this.jumpBuf = 0.18;
  }

  /** Jump via the standard verb; primary action if jump isn't registered. */
  jump(): boolean {
    const { world, actions } = this.opts;
    const avatar = this.opts.avatar();
    if (!world.isAlive(avatar)) return true;
    const res = actions.execute(world, { actor: avatar, verb: "jump", params: {} });
    if (!res.ok && res.error?.startsWith("unknown verb")) {
      return this.tryAction();
    }
    return res.ok;
  }

  private tryAction(): boolean {
    const r = this.opts.onAction?.();
    return !r || (r as { ok?: boolean }).ok !== false;
  }

  private handleClick(p: { x: number; y: number }): void {
    const { world, actions, grid } = this.opts;
    const avatar = this.opts.avatar();
    if (!world.isAlive(avatar)) return;
    // enemy under the cursor → attack (the ARPG convention)
    if (grid) {
      const radius = this.opts.attackRadius ?? 34;
      const myFaction = world.get(avatar, Faction)?.id;
      let best: Entity | 0 = 0;
      let bestD = radius;
      for (const e of grid.near(p.x, p.y, radius)) {
        if (e === avatar || !world.isAlive(e)) continue;
        if (!world.has(e, Health)) continue;
        const f = world.get(e, Faction);
        if (myFaction && f && f.id === myFaction) continue;
        const et = world.componentsOf(e)["Transform"];
        if (!et) continue;
        const d = Math.hypot(et.x - p.x, et.y - p.y);
        if (d < bestD) {
          bestD = d;
          best = e;
        }
      }
      if (best) {
        const res = actions.execute(world, { actor: avatar, verb: "attack", params: { target: best } });
        if (res.ok) return;
      }
    }
    // ground → walk there through the verb pipeline (NavGrid routing included)
    const res = actions.execute(world, { actor: avatar, verb: "move_to", params: { x: p.x, y: p.y } });
    if (res.ok) this.moveMarker = { x: p.x, y: p.y, t: 0.9 };
  }

  /** Add with the game's systems. Runs before behavior (order -30). Movement
   * flows DOM → `move` verb (on change) → PlayerControlled.moveX/moveY →
   * playerDriveSystem → Velocity, so every input is in the action log and a
   * recorded session replays identically. */
  system(): System {
    const gamepad = this.opts.gamepad;
    const touch = this.opts.touch;
    const drive = playerDriveSystem();
    return {
      name: "player-controls",
      order: -30,
      update: (ctx) => {
        const { world, dt } = ctx;
        if (this.moveMarker && (this.moveMarker.t -= dt) <= 0) this.moveMarker = null;
        // clicks resolve in-tick (replayable through the action log)
        if (this.pendingClick) {
          const p = this.pendingClick;
          this.pendingClick = null;
          this.handleClick(p);
        }
        // buffered inputs retry until they land or the window closes
        if (this.actionBuf > 0) {
          this.actionBuf -= dt;
          if (this.tryAction()) this.actionBuf = 0;
        }
        if (this.jumpBuf > 0) {
          this.jumpBuf -= dt;
          if (this.jump()) this.jumpBuf = 0;
        }
        const avatar = this.opts.avatar();
        if (world.isAlive(avatar)) {
          let x = 0;
          let y = 0;
          if (this.km.up.some((k) => this.keys.has(k))) y -= 1;
          if (this.km.down.some((k) => this.keys.has(k))) y += 1;
          if (this.km.left.some((k) => this.keys.has(k))) x -= 1;
          if (this.km.right.some((k) => this.keys.has(k))) x += 1;
          if (x !== 0 || y !== 0) {
            const m = Math.hypot(x, y);
            x /= m;
            y /= m;
          }
          gamepad?.poll();
          if (touch?.state.active) {
            x = touch.state.x;
            y = touch.state.y;
          } else if (gamepad?.state.active) {
            x = gamepad.state.x;
            y = gamepad.state.y;
          }
          // quantize analog so the log isn't spammed with micro-deltas
          x = Math.round(x * 20) / 20;
          y = Math.round(y * 20) / 20;
          if (x !== this.lastMoveX || y !== this.lastMoveY) {
            const res = this.opts.actions.execute(world, {
              actor: avatar,
              verb: "move",
              params: { x, y },
            });
            if (res.ok) {
              this.lastMoveX = x;
              this.lastMoveY = y;
              if (x !== 0 || y !== 0) this.moveMarker = null;
            }
          }
        }
        // convert stick state → velocity (shared with replays)
        drive.update(ctx);
      },
    };
  }

  dispose(): void {
    for (const d of this.disposers) d();
    this.disposers.length = 0;
  }
}

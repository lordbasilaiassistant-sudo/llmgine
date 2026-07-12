import type { Entity, System, World } from "../core/ecs.js";
import type { ActionRegistry } from "../core/actions.js";
import type { SpatialGrid } from "../core/spatial.js";
import { Behavior, Faction, Health, PlayerControlled, Velocity } from "../components.js";
import { TouchControls } from "./touch.js";
import { GamepadInput } from "./gamepad.js";

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

  /** Add with the game's systems. Runs before behavior (order -30). */
  system(): System {
    const gamepad = this.opts.gamepad;
    const touch = this.opts.touch;
    return {
      name: "player-controls",
      order: -30,
      update: ({ world, dt }) => {
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
        if (!world.isAlive(avatar)) return;
        const v = world.get(avatar, Velocity);
        if (!v) return;
        let x = 0;
        let y = 0;
        if (this.km.up.some((k) => this.keys.has(k))) y -= 1;
        if (this.km.down.some((k) => this.keys.has(k))) y += 1;
        if (this.km.left.some((k) => this.keys.has(k))) x -= 1;
        if (this.km.right.some((k) => this.keys.has(k))) x += 1;
        gamepad?.poll();
        let analog = false;
        if (touch?.state.active) {
          x = touch.state.x;
          y = touch.state.y;
          analog = true;
        } else if (gamepad?.state.active) {
          x = gamepad.state.x;
          y = gamepad.state.y;
          analog = true;
        }
        const pc = world.get(avatar, PlayerControlled);
        const direct = x !== 0 || y !== 0;
        const b = world.get(avatar, Behavior);
        if (direct) {
          // direct input always wins — cancel ANY behavior order (goto,
          // chase, attack, flee); a steering behavior left active fights
          // the stick every tick and the character rubber-bands
          if (b && b.mode !== "idle") {
            b.mode = "idle";
            b.target = 0;
          }
          const m = Math.hypot(x, y) || 1;
          const mag = Math.min(1, Math.hypot(x, y));
          v.vx = (x / m) * v.maxSpeed * (analog ? mag : 1);
          v.vy = (y / m) * v.maxSpeed * (analog ? mag : 1);
          this.moveMarker = null;
        } else if (!b || b.mode === "idle") {
          // nobody driving: stop. (behaviorSystem leaves PlayerControlled
          // entities alone in idle mode — the controller owns their velocity)
          v.vx = 0;
          v.vy = 0;
        }
        if (pc) {
          pc.moveX = x;
          pc.moveY = y;
        }
      },
    };
  }

  dispose(): void {
    for (const d of this.disposers) d();
    this.disposers.length = 0;
  }
}

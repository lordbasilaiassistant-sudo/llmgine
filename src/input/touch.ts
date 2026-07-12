/**
 * Touch input — engine basics for mobile play (issue #3).
 *
 * A virtual joystick: touches on the left portion of the screen steer a
 * normalized move vector; touches on the right fire an action callback
 * (strike/interact). Desktop-safe (no-ops without touch). Renders its own
 * minimal thumbstick overlay so games get playable mobile controls in one
 * call, and can restyle or replace it freely.
 */

export interface TouchControlsOptions {
  /** 0..1 — screen fraction (from left) that steers. Default 0.45. */
  moveZone?: number;
  /** Called on taps in the action zone (right side). */
  onAction?: () => void;
  /** Joystick visual radius in px. Default 56. */
  radius?: number;
  /** Skip creating the visual overlay (headless/custom UI). */
  hideOverlay?: boolean;
}

export interface TouchState {
  /** Normalized move vector, magnitude 0..1. */
  x: number;
  y: number;
  active: boolean;
}

/** Resting-thumb jitter below this normalized magnitude reads as zero. */
export const JOYSTICK_DEADZONE = 0.12;

/** Selector for touches that belong to the UI, not the game (escape hatch: data-ui). */
const UI_SELECTOR = "button,input,a,select,textarea,[data-ui]";

/** True when a touch landed on interactive UI — the game must not swallow it. */
export function isUiTouch(target: EventTarget | null): boolean {
  return !!(target as Element | null)?.closest?.(UI_SELECTOR);
}

/**
 * Which control zone a touch falls in, measured against the ATTACHED
 * element's bounding rect (not innerWidth — the target may not span the
 * viewport).
 */
export function touchZone(
  clientX: number,
  rectLeft: number,
  rectWidth: number,
  moveZone: number,
): "move" | "action" {
  return clientX - rectLeft < rectWidth * moveZone ? "move" : "action";
}

/**
 * Joystick displacement (px from the touch origin) → normalized move vector,
 * clamped to `radius`, with a dead zone re-scaled so output still spans 0..1.
 */
export function joystickVector(
  dx: number,
  dy: number,
  radius: number,
  deadzone = JOYSTICK_DEADZONE,
): { x: number; y: number } {
  const len = Math.hypot(dx, dy);
  if (len === 0) return { x: 0, y: 0 };
  const m = Math.min(len, radius) / radius;
  if (m <= deadzone) return { x: 0, y: 0 };
  const scaled = (m - deadzone) / (1 - deadzone);
  return { x: (dx / len) * scaled, y: (dy / len) * scaled };
}

export class TouchControls {
  readonly state: TouchState = { x: 0, y: 0, active: false };
  private moveId: number | null = null;
  private origin = { x: 0, y: 0 };
  private opts: Required<Omit<TouchControlsOptions, "onAction">> & Pick<TouchControlsOptions, "onAction">;
  private base: HTMLDivElement | null = null;
  private knob: HTMLDivElement | null = null;
  private detach: Array<() => void> = [];

  constructor(private target: HTMLElement, opts: TouchControlsOptions = {}) {
    this.opts = { moveZone: 0.45, radius: 56, hideOverlay: false, ...opts };
    if (typeof window === "undefined") return;
    const on = <K extends keyof HTMLElementEventMap>(
      type: K,
      fn: (ev: HTMLElementEventMap[K]) => void,
    ) => {
      target.addEventListener(type, fn as EventListener, { passive: false });
      this.detach.push(() => target.removeEventListener(type, fn as EventListener));
    };
    on("touchstart", (e) => this.start(e));
    on("touchmove", (e) => this.move(e));
    on("touchend", (e) => this.end(e));
    on("touchcancel", (e) => this.end(e));
    if (!this.opts.hideOverlay) this.buildOverlay();
  }

  /** True on devices that report touch support. */
  static isTouchDevice(): boolean {
    return typeof navigator !== "undefined" && (navigator.maxTouchPoints > 0 || "ontouchstart" in globalThis);
  }

  private buildOverlay(): void {
    const mk = (size: number, alpha: number) => {
      const d = document.createElement("div");
      d.style.cssText = `position:fixed;width:${size}px;height:${size}px;border-radius:50%;` +
        `border:2px solid rgba(255,255,255,${alpha});background:rgba(255,255,255,${alpha / 3});` +
        `pointer-events:none;z-index:40;display:none;transform:translate(-50%,-50%)`;
      document.body.appendChild(d);
      return d;
    };
    this.base = mk(this.opts.radius * 2, 0.25);
    this.knob = mk(this.opts.radius * 0.9, 0.45);
  }

  private start(e: TouchEvent): void {
    const rect = this.target.getBoundingClientRect();
    const width = rect.width || innerWidth;
    for (const t of Array.from(e.changedTouches)) {
      // touches on buttons/inputs/links (or anything inside [data-ui]) belong
      // to the UI — never preventDefault them or swing the sword
      if (isUiTouch(t.target)) continue;
      e.preventDefault(); // consume game-area touches (stops scroll/zoom mid-game)
      if (touchZone(t.clientX, rect.left, width, this.opts.moveZone) === "move") {
        if (this.moveId !== null) continue; // second left-zone touch: consumed, joystick already owned
        this.moveId = t.identifier;
        this.origin = { x: t.clientX, y: t.clientY };
        this.state.active = true;
        if (this.base) {
          this.base.style.display = this.knob!.style.display = "block";
          this.base.style.left = `${t.clientX}px`;
          this.base.style.top = `${t.clientY}px`;
          this.knob!.style.left = `${t.clientX}px`;
          this.knob!.style.top = `${t.clientY}px`;
        }
      } else {
        this.opts.onAction?.();
      }
    }
  }

  private move(e: TouchEvent): void {
    for (const t of Array.from(e.changedTouches)) {
      if (t.identifier !== this.moveId) continue;
      e.preventDefault();
      const dx = t.clientX - this.origin.x;
      const dy = t.clientY - this.origin.y;
      const v = joystickVector(dx, dy, this.opts.radius);
      this.state.x = v.x;
      this.state.y = v.y;
      if (this.knob) {
        const len = Math.hypot(dx, dy);
        const clamp = Math.min(len, this.opts.radius) / (len || 1);
        this.knob.style.left = `${this.origin.x + dx * clamp}px`;
        this.knob.style.top = `${this.origin.y + dy * clamp}px`;
      }
    }
  }

  private end(e: TouchEvent): void {
    for (const t of Array.from(e.changedTouches)) {
      if (t.identifier !== this.moveId) continue;
      this.moveId = null;
      this.state.x = 0;
      this.state.y = 0;
      this.state.active = false;
      if (this.base) this.base.style.display = this.knob!.style.display = "none";
    }
  }

  dispose(): void {
    for (const fn of this.detach) fn();
    this.base?.remove();
    this.knob?.remove();
  }
}

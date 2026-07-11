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
    for (const t of Array.from(e.changedTouches)) {
      if (t.clientX < innerWidth * this.opts.moveZone && this.moveId === null) {
        e.preventDefault();
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
      } else if (t.clientX >= innerWidth * this.opts.moveZone) {
        e.preventDefault();
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
      const len = Math.hypot(dx, dy);
      const r = this.opts.radius;
      const k = len > 0 ? Math.min(len, r) / r / (len || 1) : 0;
      this.state.x = dx * k;
      this.state.y = dy * k;
      if (this.knob) {
        const clamp = Math.min(len, r) / (len || 1);
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

/**
 * Gamepad input — engine basics. Polls the standard-mapping Gamepad API:
 * left stick = move vector, buttons fire named actions once per press.
 * Desktop/headless safe (no-ops without the API or a connected pad).
 */

export interface GamepadOptions {
  /** Stick deadzone. Default 0.18. */
  deadzone?: number;
  /** Standard-mapping button index → action callback (fires on press edge). */
  buttons?: Record<number, () => void>;
}

export class GamepadInput {
  readonly state = { x: 0, y: 0, active: false };
  private prevPressed = new Set<number>();
  private deadzone: number;
  private buttons: Record<number, () => void>;

  constructor(opts: GamepadOptions = {}) {
    this.deadzone = opts.deadzone ?? 0.18;
    this.buttons = opts.buttons ?? {};
  }

  /** Call once per frame (input system / render loop). */
  poll(): void {
    this.state.active = false;
    if (typeof navigator === "undefined" || !navigator.getGamepads) return;
    const pad = [...navigator.getGamepads()].find((p) => p?.connected);
    if (!pad) {
      this.state.x = 0;
      this.state.y = 0;
      return;
    }
    // Only trust axes 0/1 as "left stick" on standard-mapping pads — flight
    // sticks / odd BT pads map arbitrary axes there. Buttons still work.
    if (pad.mapping === "standard") {
      const [x, y] = [pad.axes[0] ?? 0, pad.axes[1] ?? 0];
      const mag = Math.hypot(x, y);
      if (mag > this.deadzone) {
        const k = Math.min(1, (mag - this.deadzone) / (1 - this.deadzone)) / (mag || 1);
        this.state.x = x * k;
        this.state.y = y * k;
        this.state.active = true;
      } else {
        this.state.x = 0;
        this.state.y = 0;
      }
    } else {
      this.state.x = 0;
      this.state.y = 0;
    }
    for (const [idx, fn] of Object.entries(this.buttons)) {
      const i = Number(idx);
      const pressed = !!pad.buttons[i]?.pressed;
      if (pressed && !this.prevPressed.has(i)) fn();
      if (pressed) this.prevPressed.add(i);
      else this.prevPressed.delete(i);
    }
  }
}

# Input — touch joystick + gamepad

Source: `src/input/touch.ts`, `src/input/gamepad.ts`. Import: `llmgine` root or `llmgine/input`.

Both classes expose a normalized `state = { x, y, active }` you copy into your
player intent (e.g. `PlayerControlled.moveX/moveY`) each frame. Both are
desktop/headless safe — they no-op without the underlying API.

## Touch (virtual joystick)

```ts
import { TouchControls } from "llmgine/input";

const touch = new TouchControls(document.getElementById("stage")!, {
  moveZone: 0.45,          // left 45% of the screen steers (default)
  radius: 56,              // joystick visual radius px (default)
  onAction: () => attack(), // taps on the RIGHT side fire this
  // hideOverlay: true,    // suppress the built-in thumbstick visuals
});

// per frame:
player.moveX = touch.state.x;   // magnitude 0..1
player.moveY = touch.state.y;

if (TouchControls.isTouchDevice()) { /* show mobile HUD */ }
touch.dispose();                // removes listeners + overlay
```

The overlay is two fixed-position divs (base ring + knob) that follow the
finger; restyle by passing `hideOverlay: true` and drawing your own from
`state`.

## Gamepad

Polls the standard-mapping Gamepad API. Left stick = move vector (deadzone
0.18, rescaled), buttons fire callbacks once per press edge.

```ts
import { GamepadInput } from "llmgine/input";

const pad = new GamepadInput({
  deadzone: 0.18,
  buttons: {
    0: () => attack(),   // A / Cross
    9: () => pause(),    // Start
  },
});

// call once per frame (input system or render loop):
pad.poll();
if (pad.state.active) {
  player.moveX = pad.state.x;
  player.moveY = pad.state.y;
}
```

## Combining sources

Priority is yours; a common pattern is gamepad > touch > keyboard:

```ts
pad.poll();
const src = pad.state.active ? pad.state : touch.state.active ? touch.state : keys;
player.moveX = src.x;
player.moveY = src.y;
```

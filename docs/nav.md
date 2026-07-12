# Navigation — NavGrid + A*

Source: `src/core/nav.ts` (grid + pathfinding), `src/systems/behavior.ts`
(integration). Deterministic: no randomness, stable tie-breaking.

`NavGrid` is a coarse blocked-cell grid. You stamp static obstacles in once
(walls, pillars, buildings); `behaviorSystem(nav)` then makes `goto` / `chase`
/ `attack` / `flee` movement route around them instead of face-planting.

## Setup

```ts
import { NavGrid, behaviorSystem } from "llmgine";

const nav = new NavGrid(32);          // cell size in world units (default 32)
nav.blockCircle(120, -40, 30);        // a pillar
nav.blockRect(-300, 100, 300, 140);   // a wall
// nav.clear() to re-stamp (e.g. level change)

world.addSystem(behaviorSystem(nav)); // omit nav → straight-line steering
```

That's the whole integration: verbs like `move_to`/`follow`/`attack` set
Behavior modes, and the behavior system consults the grid every time steering
would cross a blocked cell.

## How it steers (what to expect)

- Straight line clear (`nav.lineClear`) → walks directly, no path computed.
- Blocked → A* over 8-connected cells (no diagonal corner-cutting), waypoints
  smoothed with line-of-sight skips, stored on `Behavior.path`.
- Re-paths at most every 0.5 s, or immediately when the goal moved more than
  1.5 cells (chasing a runner).
- Unreachable goal → pushes straight toward it anyway (leash/collision decide
  what happens), rather than freezing.

## Direct API

```ts
nav.isBlocked(x, y);                       // point test
nav.lineClear(x0, y0, x1, y1);             // cheap LOS pre-check
const pts = nav.findPath(x0, y0, x1, y1);  // PathPoint[] incl. goal, or null
```

`findPath` gives up after `maxExpand` (default 2000) cell expansions — bound
your worlds or raise it for maze-heavy maps. Sealed-off goals return `null`.

Notes:
- Obstacles are **static**: entities are not stamped into the grid (dynamic
  avoidance is the collision system's job).
- Grid cells are stamped generously (circle stamps include cells whose center
  is within `radius + cellSize/2`), so paths keep a little clearance.

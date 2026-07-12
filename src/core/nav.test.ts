import { describe, expect, it } from "vitest";
import { NavGrid } from "./nav.js";
import { World } from "./ecs.js";
import { GameLoop } from "./loop.js";
import { SpatialGrid } from "./spatial.js";
import { Behavior, Transform, Velocity } from "../components.js";
import { behaviorSystem } from "../systems/behavior.js";
import { movementSystem } from "../systems/movement.js";

describe("NavGrid", () => {
  it("goes straight when the line is clear", () => {
    const nav = new NavGrid(32);
    expect(nav.findPath(0, 0, 200, 0)).toEqual([{ x: 200, y: 0 }]);
  });

  it("routes around a wall", () => {
    const nav = new NavGrid(32);
    nav.blockRect(96, -160, 128, 160); // vertical wall between start and goal
    const path = nav.findPath(0, 0, 300, 0)!;
    expect(path).not.toBeNull();
    expect(path.length).toBeGreaterThan(1); // had to detour
    expect(path[path.length - 1]).toEqual({ x: 300, y: 0 });
    // no waypoint sits inside the wall
    for (const p of path) expect(nav.isBlocked(p.x, p.y)).toBe(false);
  });

  it("routes to the nearest walkable cell when the goal itself is blocked", () => {
    const nav = new NavGrid(32);
    nav.blockRect(180, -60, 320, 60);
    // goal (250,0) is inside the block — chase targets hugging walls must
    // still be approachable, so the path ends at the nearest walkable cell
    const path = nav.findPath(0, 0, 250, 0)!;
    expect(path).not.toBeNull();
    const end = path[path.length - 1];
    expect(nav.isBlocked(end.x, end.y)).toBe(false);
    expect(Math.hypot(end.x - 250, end.y - 0)).toBeLessThan(32 * 4);
  });

  it("supercover lineClear catches clipped cells", () => {
    const nav = new NavGrid(32);
    nav.blockRect(64, 64, 95, 95); // single cell (2,2) = world [64,96)²
    // diagonal exactly through the cell (corner-crossing traversal case)
    expect(nav.lineClear(0, 0, 160, 160)).toBe(false);
    // segment that only clips the cell's corner region
    expect(nav.lineClear(50, 98, 98, 50)).toBe(false);
    // a clearly separated line stays clear
    expect(nav.lineClear(0, 200, 200, 200)).toBe(true);
  });

  it("behavior goto actually walks an entity around an obstacle", () => {
    const world = new World(5);
    const grid = new SpatialGrid();
    const nav = new NavGrid(32);
    nav.blockRect(96, -200, 128, 200);
    world.addSystem(behaviorSystem(nav)).addSystem(movementSystem(grid));
    const e = world.create();
    world.add(e, Transform, { x: 0, y: 0 });
    world.add(e, Velocity, { maxSpeed: 150 });
    world.add(e, Behavior, { mode: "goto", dirX: 300, dirY: 0 });
    new GameLoop(world).advance(60 * 8);
    const t = world.require(e, Transform);
    expect(Math.hypot(t.x - 300, t.y - 0)).toBeLessThan(12); // arrived
  });
});

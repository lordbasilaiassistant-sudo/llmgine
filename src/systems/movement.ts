import type { System } from "../core/ecs.js";
import { SpatialGrid } from "../core/spatial.js";
import { Collider, Speech, Transform, Velocity } from "../components.js";

export interface WorldBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Integrates velocity into position, clamps to bounds, maintains the spatial grid. */
export function movementSystem(grid: SpatialGrid, bounds?: WorldBounds): System {
  let wired: unknown = null;
  return {
    name: "movement",
    order: 0,
    update({ world, dt }) {
      // keep the grid honest: destroyed entities must leave their cell
      if (wired !== world) {
        wired = world;
        world.events.on("entity:destroyed", ({ entity }) => grid.delete(entity));
      }
      for (const e of world.query(Transform, Velocity)) {
        const t = world.require(e, Transform);
        const v = world.require(e, Velocity);
        if (!Number.isFinite(v.vx) || !Number.isFinite(v.vy)) {
          v.vx = 0;
          v.vy = 0;
        }
        const speed = Math.hypot(v.vx, v.vy);
        if (speed > v.maxSpeed && speed > 0) {
          const k = v.maxSpeed / speed;
          v.vx *= k;
          v.vy *= k;
        }
        t.x += v.vx * dt;
        t.y += v.vy * dt;
        if (bounds) {
          t.x = Math.min(Math.max(t.x, bounds.minX), bounds.maxX);
          t.y = Math.min(Math.max(t.y, bounds.minY), bounds.maxY);
        }
      }
      // grid maintenance for every positioned entity (movers or not)
      for (const [e, t] of world.each(Transform)) {
        grid.set(e, t.x, t.y);
      }
    },
  };
}

/** Circle-vs-circle separation for solid colliders. Simple, stable, genre-agnostic.
 * Entities are immovable when `Collider.static` is set OR they have no Velocity
 * (walls/pillars can't be shoved out from under their NavGrid stamp). */
export function collisionSystem(grid: SpatialGrid, bounds?: WorldBounds): System {
  return {
    name: "collision",
    order: 10,
    update({ world }) {
      for (const e of world.query(Transform, Collider)) {
        const c = world.require(e, Collider);
        if (!c.solid) continue;
        const t = world.require(e, Transform);
        const eFixed = c.static || !world.has(e, Velocity);
        for (const other of grid.near(t.x, t.y, c.radius + 32)) {
          if (other === e || !world.isAlive(other)) continue;
          const oc = world.get(other, Collider);
          const ot = world.get(other, Transform);
          if (!oc?.solid || !ot) continue;
          const oFixed = oc.static || !world.has(other, Velocity);
          if (eFixed && oFixed) continue;
          const dx = t.x - ot.x;
          const dy = t.y - ot.y;
          let dist = Math.hypot(dx, dy);
          const minDist = c.radius + oc.radius;
          if (dist >= minDist) continue;
          // exact overlap (spawn stack): deterministic split along x by id order
          let nx: number;
          let ny: number;
          if (dist === 0) {
            nx = e < other ? 1 : -1;
            ny = 0;
            dist = minDist; // full push apart
          } else {
            nx = dx / dist;
            ny = dy / dist;
          }
          const overlap = minDist - (dist === minDist ? 0 : dist);
          if (eFixed) {
            ot.x -= nx * overlap;
            ot.y -= ny * overlap;
          } else if (oFixed) {
            t.x += nx * overlap;
            t.y += ny * overlap;
          } else {
            t.x += nx * (overlap / 2);
            t.y += ny * (overlap / 2);
            ot.x -= nx * (overlap / 2);
            ot.y -= ny * (overlap / 2);
          }
          if (bounds) {
            t.x = Math.min(Math.max(t.x, bounds.minX), bounds.maxX);
            t.y = Math.min(Math.max(t.y, bounds.minY), bounds.maxY);
            ot.x = Math.min(Math.max(ot.x, bounds.minX), bounds.maxX);
            ot.y = Math.min(Math.max(ot.y, bounds.minY), bounds.maxY);
          }
        }
      }
    },
  };
}

/** Ticks down speech bubbles. */
export function speechSystem(): System {
  return {
    name: "speech",
    order: 90,
    update({ world, dt }) {
      for (const [e, s] of world.each(Speech)) {
        if (s.ttl > 0) {
          s.ttl -= dt;
          if (s.ttl <= 0) {
            s.text = "";
            s.ttl = 0;
            void e;
          }
        }
      }
    },
  };
}

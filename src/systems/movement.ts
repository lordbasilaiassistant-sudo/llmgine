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
  return {
    name: "movement",
    order: 0,
    update({ world, dt }) {
      for (const e of world.query(Transform, Velocity)) {
        const t = world.require(e, Transform);
        const v = world.require(e, Velocity);
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

/** Circle-vs-circle separation for solid colliders. Simple, stable, genre-agnostic. */
export function collisionSystem(grid: SpatialGrid): System {
  return {
    name: "collision",
    order: 10,
    update({ world }) {
      for (const e of world.query(Transform, Collider)) {
        const c = world.require(e, Collider);
        if (!c.solid) continue;
        const t = world.require(e, Transform);
        for (const other of grid.near(t.x, t.y, c.radius + 32)) {
          if (other === e || !world.isAlive(other)) continue;
          const oc = world.get(other, Collider);
          const ot = world.get(other, Transform);
          if (!oc?.solid || !ot) continue;
          const dx = t.x - ot.x;
          const dy = t.y - ot.y;
          const dist = Math.hypot(dx, dy);
          const minDist = c.radius + oc.radius;
          if (dist > 0 && dist < minDist) {
            const push = (minDist - dist) / 2;
            const nx = dx / dist;
            const ny = dy / dist;
            t.x += nx * push;
            t.y += ny * push;
            ot.x -= nx * push;
            ot.y -= ny * push;
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

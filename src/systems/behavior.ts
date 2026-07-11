import type { System } from "../core/ecs.js";
import { Attack, Behavior, Faction, Health, Transform, Velocity } from "../components.js";

/**
 * Deterministic behavior policies — the 60 Hz actuator under every entity.
 * LLM Minds steer by setting modes/targets (via verbs); entities without a
 * Mind (or whose Mind is over budget / offline) run these policies alone.
 * This is the "game works with the API down" guarantee.
 *
 * Modes: idle | wander | goto | chase | attack | flee
 */
export function behaviorSystem(): System {
  return {
    name: "behavior",
    order: -10, // before movement integrates velocity
    update({ world, dt }) {
      for (const e of world.query(Behavior, Transform, Velocity)) {
        const b = world.require(e, Behavior);
        const t = world.require(e, Transform);
        const v = world.require(e, Velocity);

        const steerTo = (x: number, y: number, speedMul = 1): number => {
          const dx = x - t.x;
          const dy = y - t.y;
          const dist = Math.hypot(dx, dy);
          if (dist > 1) {
            v.vx = (dx / dist) * v.maxSpeed * speedMul;
            v.vy = (dy / dist) * v.maxSpeed * speedMul;
          } else {
            v.vx = 0;
            v.vy = 0;
          }
          return dist;
        };

        const targetAlive = b.target !== 0 && world.isAlive(b.target);
        const targetT = targetAlive ? world.get(b.target, Transform) : undefined;

        switch (b.mode) {
          case "idle":
            v.vx = 0;
            v.vy = 0;
            break;

          case "wander": {
            b.dirTimer -= dt;
            if (b.dirTimer <= 0) {
              b.dirTimer = 1 + world.rng.next() * 2.5;
              if (world.rng.chance(0.3)) {
                b.dirX = 0;
                b.dirY = 0;
              } else {
                const a = world.rng.next() * Math.PI * 2;
                b.dirX = Math.cos(a);
                b.dirY = Math.sin(a);
              }
            }
            // leash: drift home when too far
            if (b.leash > 0 && Math.hypot(t.x - b.homeX, t.y - b.homeY) > b.leash) {
              steerTo(b.homeX, b.homeY, 0.5);
            } else {
              v.vx = b.dirX * v.maxSpeed * 0.4;
              v.vy = b.dirY * v.maxSpeed * 0.4;
            }
            break;
          }

          case "goto": {
            const dist = steerTo(b.dirX, b.dirY);
            if (dist < 6) {
              b.mode = "idle";
              v.vx = 0;
              v.vy = 0;
            }
            break;
          }

          case "chase": {
            if (!targetT) {
              b.mode = "idle";
              break;
            }
            const dist = steerTo(targetT.x, targetT.y);
            if (dist < 40) {
              v.vx = 0;
              v.vy = 0;
            }
            break;
          }

          case "attack": {
            if (!targetT) {
              b.mode = "idle";
              break;
            }
            const atk = world.get(e, Attack);
            const range = atk?.range ?? 30;
            const dist = Math.hypot(targetT.x - t.x, targetT.y - t.y);
            if (dist > range * 0.9) steerTo(targetT.x, targetT.y);
            else {
              v.vx = 0;
              v.vy = 0;
            }
            break;
          }

          case "flee": {
            if (!targetT) {
              b.mode = "idle";
              break;
            }
            steerTo(t.x * 2 - targetT.x, t.y * 2 - targetT.y);
            break;
          }
        }
      }
    },
  };
}

/**
 * Faction aggro — passive entities acquire hostile targets on sight and
 * retaliate when hit. Deterministic PvE without any LLM. A Mind can always
 * override by setting a different mode next thought.
 */
export function aggroSystem(): System {
  return {
    name: "aggro",
    order: -20, // before behavior acts on it
    update({ world }) {
      // retaliation: whoever damaged me becomes my target
      for (const j of world.events.journal) {
        if (j.type !== "combat:damaged") continue;
        const victim = j.payload?.target;
        const attacker = j.payload?.source;
        if (victim === undefined || attacker === undefined) continue;
        const b = world.get(victim, Behavior);
        if (!b || !world.has(victim, Attack)) continue;
        if ((b.mode === "wander" || b.mode === "idle" || b.mode === "chase") && world.isAlive(attacker)) {
          b.mode = "attack";
          b.target = attacker;
        }
      }
      // sight-based acquisition
      for (const e of world.query(Behavior, Faction, Attack, Transform)) {
        const b = world.require(e, Behavior);
        if (b.mode !== "wander" && b.mode !== "idle") continue;
        const f = world.require(e, Faction);
        if (!f.hostileTo.length) continue;
        const t = world.require(e, Transform);
        let best = 0;
        let bestDist = b.sightRange;
        for (const [other, of] of world.each(Faction)) {
          if (other === e || !f.hostileTo.includes(of.id)) continue;
          if (!world.has(other, Health)) continue;
          const ot = world.get(other, Transform);
          if (!ot) continue;
          const d = Math.hypot(ot.x - t.x, ot.y - t.y);
          if (d < bestDist) {
            bestDist = d;
            best = other;
          }
        }
        if (best) {
          b.mode = "attack";
          b.target = best;
        }
      }
    },
  };
}

import { defineComponent } from "../core/ecs.js";
import type { System } from "../core/ecs.js";
import type { VerbDef } from "../core/actions.js";
import type { SpatialGrid } from "../core/spatial.js";
import { Collider, Faction, Health, Sprite, Transform, Velocity } from "../components.js";
import { dealDamage } from "./combat.js";

/**
 * Ranged combat — engine basics (issue #4). Deterministic projectiles spawned
 * through the verb gate: players, scripts, and LLM Minds all `shoot` the same
 * way, and a Mind can only shoot if its body has a Ranged component.
 */

export const Ranged = defineComponent("Ranged", () => ({
  damage: 8,
  /** Projectile speed, units/sec. */
  speed: 420,
  /** Max travel distance. */
  range: 320,
  cooldown: 0.5,
  /** Internal: seconds until next shot. */
  ready: 0,
  /** Projectile visual. */
  color: "#ffd166",
}));

export const Projectile = defineComponent("Projectile", () => ({
  damage: 8,
  source: 0,
  /** Faction id copied from the shooter; same faction is never hit. */
  faction: "",
  /** Seconds until the projectile expires. */
  ttl: 1,
  hitRadius: 10,
}));

export const shootVerb: VerbDef = {
  name: "shoot",
  description: "Fire a projectile at a target entity or a position.",
  params: {
    target: { type: "entity", description: "Entity id to shoot at (or give x,y)" },
    x: { type: "number" },
    y: { type: "number" },
  },
  validate: (w, a) => {
    const r = w.get(a.actor, Ranged);
    if (!r) return "you cannot shoot (no Ranged)";
    if (r.ready > 0) return "not ready";
    if (!w.has(a.actor, Transform)) return "nowhere to shoot from";
    const hasTarget = a.params.target !== undefined && w.isAlive(Number(a.params.target));
    const hasPos = a.params.x !== undefined && a.params.y !== undefined;
    return hasTarget || hasPos ? null : "no target";
  },
  resolve: (w, a) => {
    const r = w.require(a.actor, Ranged);
    const t = w.require(a.actor, Transform);
    let tx = Number(a.params.x);
    let ty = Number(a.params.y);
    if (a.params.target !== undefined && w.isAlive(Number(a.params.target))) {
      const tt = w.get(Number(a.params.target), Transform);
      if (tt) {
        tx = tt.x;
        ty = tt.y;
      }
    }
    const dx = tx - t.x;
    const dy = ty - t.y;
    const d = Math.hypot(dx, dy) || 1;
    r.ready = r.cooldown;

    const p = w.create();
    w.add(p, Transform, { x: t.x + (dx / d) * 14, y: t.y + (dy / d) * 14, rot: Math.atan2(dy, dx) });
    w.add(p, Velocity, { vx: (dx / d) * r.speed, vy: (dy / d) * r.speed, maxSpeed: r.speed });
    w.add(p, Projectile, {
      damage: r.damage,
      source: a.actor,
      faction: w.get(a.actor, Faction)?.id ?? "",
      ttl: r.range / r.speed,
    });
    w.add(p, Sprite, { kind: "projectile", color: r.color, size: 8, layer: 2 });
    w.add(p, Collider, { radius: 4, solid: false });
    w.events.emit("combat:shot", { entity: a.actor, projectile: p, x: t.x, y: t.y });
  },
};

export function projectileSystem(grid: SpatialGrid): System {
  return {
    name: "projectiles",
    order: 18, // after movement, before melee combat resolution
    update({ world, dt }) {
      for (const [, r] of world.each(Ranged)) {
        if (r.ready > 0) r.ready -= dt;
      }
      for (const [e, p] of world.each(Projectile)) {
        p.ttl -= dt;
        if (p.ttl <= 0) {
          world.destroy(e);
          continue;
        }
        const t = world.get(e, Transform);
        if (!t) continue;
        for (const other of grid.near(t.x, t.y, p.hitRadius + 24)) {
          if (other === e || other === p.source || !world.isAlive(other)) continue;
          const oh = world.get(other, Health);
          const ot = world.get(other, Transform);
          if (!oh || oh.hp <= 0 || !ot) continue;
          if (p.faction && world.get(other, Faction)?.id === p.faction) continue; // no friendly fire
          const reach = p.hitRadius + (world.get(other, Collider)?.radius ?? 8);
          if (Math.hypot(ot.x - t.x, ot.y - t.y) <= reach) {
            dealDamage(world, p.source, other, p.damage);
            world.destroy(e);
            break;
          }
        }
      }
    },
  };
}

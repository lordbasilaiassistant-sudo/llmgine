import { defineComponent } from "../core/ecs.js";
import type { System } from "../core/ecs.js";
import type { VerbDef } from "../core/actions.js";
import type { SpatialGrid } from "../core/spatial.js";
import { DODGE_HEIGHT, Faction, Health, Transform } from "../components.js";
import { dealDamage } from "./combat.js";

/**
 * AreaStrike — the telegraphed danger-circle primitive (mortars, slams,
 * shockwaves, Hades-style ground AoE). The missing piece that capped the
 * enemy-design space at melee + bolts.
 *
 * Flow: the `area_strike` verb (capability = AreaAttack component) marks a
 * zone → `area:telegraph` event fires immediately (renderers draw the ring)
 * → after `delay` seconds the zone detonates: everything hostile inside
 * takes damage + radial knockback — EXCEPT airborne entities (jumping the
 * shockwave is the counter, same DODGE_HEIGHT rule as melee/bolts).
 * Deterministic; strikes are plain entities, so they save/load mid-flight.
 */

export const AreaAttack = defineComponent("AreaAttack", () => ({
  damage: 20,
  radius: 70,
  /** Telegraph time before detonation — the reaction window. Min 0.3s. */
  delay: 0.8,
  /** Max distance from the caster a zone can be placed. */
  range: 240,
  cooldown: 4,
  /** Internal: seconds until next strike allowed. */
  ready: 0,
  knockback: 260,
}));

/** A live danger zone in the world (transient entity). */
export const AreaStrikeZone = defineComponent("AreaStrikeZone", () => ({
  radius: 70,
  /** Seconds until detonation. */
  fuse: 0.8,
  damage: 20,
  knockback: 260,
  source: 0,
  /** Faction id that is NOT hit (no friendly fire). */
  faction: "",
}));

export const areaStrikeVerb: VerbDef = {
  name: "area_strike",
  description:
    "Slam a telegraphed danger zone onto ground coordinates. Detonates after a visible delay; jumping clears it.",
  params: {
    x: { type: "number", required: true },
    y: { type: "number", required: true },
  },
  validate: (w, a) => {
    const aa = w.get(a.actor, AreaAttack);
    if (!aa) return "you cannot area-strike (no AreaAttack)";
    if (aa.ready > 0) return "not ready";
    const t = w.get(a.actor, Transform);
    if (!t) return "nowhere to strike from";
    if (Math.hypot(Number(a.params.x) - t.x, Number(a.params.y) - t.y) > aa.range) {
      return "out of range";
    }
    return null;
  },
  resolve: (w, a) => {
    const aa = w.require(a.actor, AreaAttack);
    aa.ready = aa.cooldown;
    const zone = w.create();
    w.add(zone, Transform, { x: Number(a.params.x), y: Number(a.params.y) });
    w.add(zone, AreaStrikeZone, {
      radius: aa.radius,
      fuse: Math.max(0.3, aa.delay), // telegraphs are ALWAYS readable
      damage: aa.damage,
      knockback: aa.knockback,
      source: a.actor,
      faction: w.get(a.actor, Faction)?.id ?? "",
    });
    w.events.emit("area:telegraph", {
      zone,
      source: a.actor,
      x: Number(a.params.x),
      y: Number(a.params.y),
      radius: aa.radius,
      duration: Math.max(0.3, aa.delay),
    });
  },
};

export function areaStrikeSystem(grid: SpatialGrid): System {
  return {
    name: "area-strike",
    order: 19,
    update({ world, dt }) {
      for (const [, aa] of world.each(AreaAttack)) {
        if (aa.ready > 0) aa.ready -= dt;
      }
      for (const [e, z] of world.each(AreaStrikeZone)) {
        z.fuse -= dt;
        if (z.fuse > 0) continue;
        const t = world.require(e, Transform);
        for (const other of grid.near(t.x, t.y, z.radius + 24)) {
          if (other === e || other === z.source || !world.isAlive(other)) continue;
          const oh = world.get(other, Health);
          const ot = world.get(other, Transform);
          if (!oh || oh.hp <= 0 || !ot) continue;
          if ((ot.z ?? 0) > DODGE_HEIGHT) continue; // jumped the shockwave
          if (z.faction && world.get(other, Faction)?.id === z.faction) continue;
          if (Math.hypot(ot.x - t.x, ot.y - t.y) > z.radius) continue;
          dealDamage(world, z.source, other, z.damage, z.knockback);
        }
        world.events.emit("area:hit", { x: t.x, y: t.y, radius: z.radius, source: z.source });
        world.destroy(e);
      }
    },
  };
}

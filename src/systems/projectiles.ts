import { defineComponent } from "../core/ecs.js";
import type { System } from "../core/ecs.js";
import type { ActionRegistry, VerbDef } from "../core/actions.js";
import type { SpatialGrid } from "../core/spatial.js";
import { Behavior, Collider, DODGE_HEIGHT, Faction, Health, Sprite, Transform, Velocity } from "../components.js";
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
  /** Knockback impulse on hit, units/sec. */
  knockback: 90,
  /** Telegraph before an AI shot (rangedCombatSystem): seconds of visible
   * windup. 0 = fire instantly (bolt travel time is the reaction window). */
  windup: 0,
  /** Internal: seconds left in the current ranged windup. */
  winding: 0,
}));

export const Projectile = defineComponent("Projectile", () => ({
  damage: 8,
  source: 0,
  /** Faction id copied from the shooter; same faction is never hit. */
  faction: "",
  /** Seconds until the projectile expires. */
  ttl: 1,
  hitRadius: 10,
  knockback: 90,
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
    // a target is only aimable if it has a position
    const hasTarget =
      a.params.target !== undefined &&
      w.isAlive(Number(a.params.target)) &&
      w.has(Number(a.params.target), Transform);
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
        // lead a moving target by ~65% of the flight time — aiming at the
        // current position means any strafing target dodges every shot
        const tv = w.get(Number(a.params.target), Velocity);
        if (tv && (tv.vx !== 0 || tv.vy !== 0)) {
          const flight = Math.hypot(tt.x - t.x, tt.y - t.y) / r.speed;
          tx += tv.vx * flight * 0.65;
          ty += tv.vy * flight * 0.65;
        }
      }
    }
    if (!Number.isFinite(tx) || !Number.isFinite(ty)) return; // no aim point survived validation
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
      knockback: r.knockback,
    });
    w.add(p, Sprite, { kind: "projectile", color: r.color, size: 8, layer: 2 });
    w.add(p, Collider, { radius: 4, solid: false });
    w.events.emit("combat:shot", { entity: a.actor, projectile: p, x: t.x, y: t.y });
  },
};

/**
 * Deterministic ranged-combat policy: entities in `attack`/`skirmish` mode
 * with a Ranged component fire through the SAME shoot verb as players and
 * Minds (verb-gated, logged as internal — replays re-derive these shots).
 * `Ranged.windup > 0` telegraphs the shot (combat:windup, kind "ranged")
 * before firing — parity with melee readability. Pass a NavGrid to hold
 * fire without line of sight (cover works for the defender too).
 */
export function rangedCombatSystem(actions: ActionRegistry, nav?: import("../core/nav.js").NavGrid): System {
  return {
    name: "ranged-combat",
    order: 17, // with combat cadence, before projectile stepping
    update({ world, dt }) {
      for (const e of world.query(Behavior, Ranged, Transform)) {
        const selfHp = world.get(e, Health);
        if (selfHp && selfHp.hp <= 0) continue;
        const r = world.require(e, Ranged);
        const t = world.require(e, Transform);
        // resolve an in-flight ranged windup
        if (r.winding > 0) {
          r.winding -= dt;
          if (r.winding <= 0) {
            r.winding = 0;
            const b = world.require(e, Behavior);
            if (world.isAlive(b.target)) {
              actions.execute(world, { actor: e, verb: "shoot", params: { target: b.target } }, { internal: true });
            }
          }
          continue;
        }
        const b = world.require(e, Behavior);
        if (b.mode !== "skirmish" && b.mode !== "attack") continue;
        if (!world.isAlive(b.target)) continue;
        if (r.ready > 0) continue;
        const tt = world.get(b.target, Transform);
        if (!tt) continue;
        const dist = Math.hypot(tt.x - t.x, tt.y - t.y);
        if (dist > r.range) continue;
        if (nav && !nav.lineClear(t.x, t.y, tt.x, tt.y)) continue; // no wallhacks
        if (r.windup > 0) {
          r.winding = r.windup;
          t.rot = Math.atan2(tt.y - t.y, tt.x - t.x);
          world.events.emit("combat:windup", { entity: e, target: b.target, duration: r.windup, kind: "ranged" });
        } else {
          actions.execute(world, { actor: e, verb: "shoot", params: { target: b.target } }, { internal: true });
        }
      }
    },
  };
}

/** Closest approach of point (cx,cy) to segment (ax,ay)→(bx,by); returns [dist, u]. */
function segDist(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): [number, number] {
  const abx = bx - ax;
  const aby = by - ay;
  const len2 = abx * abx + aby * aby;
  let u = len2 > 0 ? ((cx - ax) * abx + (cy - ay) * aby) / len2 : 0;
  u = Math.max(0, Math.min(1, u));
  return [Math.hypot(ax + abx * u - cx, ay + aby * u - cy), u];
}

/**
 * Pass a NavGrid to make projectiles stop on walls/pillars (cover works).
 * Collision is swept over the tick's travel segment — fast projectiles
 * cannot tunnel through targets between ticks.
 */
export function projectileSystem(grid: SpatialGrid, nav?: import("../core/nav.js").NavGrid): System {
  return {
    name: "projectiles",
    order: 18, // after movement, before melee combat resolution
    update({ world, dt }) {
      for (const [, r] of world.each(Ranged)) {
        if (r.ready > 0) r.ready -= dt;
      }
      // widest collider this tick — grid query radius must cover any target,
      // not an assumed max of 24 units
      let maxR = 8;
      for (const [, c] of world.each(Collider)) {
        if (c.radius > maxR) maxR = c.radius;
      }
      for (const [e, p] of world.each(Projectile)) {
        p.ttl -= dt;
        if (p.ttl <= 0) {
          world.destroy(e);
          continue;
        }
        const t = world.get(e, Transform);
        if (!t) continue;
        const v = world.get(e, Velocity);
        // movement already integrated this tick — sweep from where it was
        const px = t.x - (v?.vx ?? 0) * dt;
        const py = t.y - (v?.vy ?? 0) * dt;
        // walls block shots: cover is real
        if (nav && !nav.lineClear(px, py, t.x, t.y)) {
          world.events.emit("projectile:blocked", { projectile: e, x: t.x, y: t.y });
          world.destroy(e);
          continue;
        }
        const travel = Math.hypot(t.x - px, t.y - py);
        let hit = 0;
        let hitU = Infinity;
        for (const other of grid.near((px + t.x) / 2, (py + t.y) / 2, p.hitRadius + maxR + travel / 2)) {
          if (other === e || other === p.source || !world.isAlive(other)) continue;
          const oh = world.get(other, Health);
          const ot = world.get(other, Transform);
          if (!oh || oh.hp <= 0 || !ot) continue;
          if ((ot.z ?? 0) > DODGE_HEIGHT) continue; // jumped over it
          if (p.faction && world.get(other, Faction)?.id === p.faction) continue; // no friendly fire
          const reach = p.hitRadius + (world.get(other, Collider)?.radius ?? 8);
          const [dist, u] = segDist(px, py, t.x, t.y, ot.x, ot.y);
          if (dist <= reach && (u < hitU || (u === hitU && other < hit))) {
            hit = other;
            hitU = u;
          }
        }
        if (hit) {
          dealDamage(world, p.source, hit, p.damage, p.knockback);
          world.destroy(e);
        }
      }
    },
  };
}

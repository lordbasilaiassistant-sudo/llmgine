import type { Entity, World } from "../core/ecs.js";
import type { SpatialGrid } from "../core/spatial.js";
import { Faction, Health, Named, Pickup, Speech, Transform } from "../components.js";

/**
 * Eyes — the perception pipeline. Builds what a Mind "sees" each time it
 * thinks. Structured mode produces a compact JSON world-snapshot from the
 * spatial grid + event journal; pixel mode (renderer.capture) adds real
 * sight for vision-tier models. Perception is computed from the same
 * component data as everything else — there is no separate "AI world".
 */

export interface PerceivedEntity {
  id: Entity;
  name: string;
  blurb?: string;
  faction?: string;
  hp?: string;
  dist: number;
  dir: string;
  saying?: string;
  pickup?: string;
}

export interface Perception {
  self: {
    id: Entity;
    name: string;
    hp?: string;
    /** Absent for disembodied minds (factions, weather, directors). */
    x?: number;
    y?: number;
  };
  nearby: PerceivedEntity[];
  /** Notable events since the last thought (damage, deaths, speech, actions). */
  events: string[];
  time: number;
}

const DIRS = ["E", "SE", "S", "SW", "W", "NW", "N", "NE"];

function dirOf(dx: number, dy: number): string {
  const a = Math.atan2(dy, dx);
  return DIRS[((Math.round((a / (Math.PI * 2)) * 8) % 8) + 8) % 8];
}

function hpStr(world: World, e: Entity): string | undefined {
  const h = world.get(e, Health);
  return h ? `${Math.max(0, Math.round(h.hp))}/${h.maxHp}` : undefined;
}

export function buildPerception(
  world: World,
  grid: SpatialGrid,
  self: Entity,
  range: number,
  sinceTick = 0,
): Perception {
  // Disembodied minds (a faction, the weather, a drop-table director) have
  // no Transform — they still think, they just have no spatial neighborhood.
  const t = world.get(self, Transform);
  const nearby: PerceivedEntity[] = [];

  for (const e of t ? grid.near(t.x, t.y, range) : []) {
    if (!t) break;
    if (e === self || !world.isAlive(e)) continue;
    const et = world.get(e, Transform);
    if (!et) continue;
    const dx = et.x - t.x;
    const dy = et.y - t.y;
    const dist = Math.hypot(dx, dy);
    if (dist > range) continue;
    const p: PerceivedEntity = {
      id: e,
      name: world.get(e, Named)?.name ?? `entity#${e}`,
      dist: Math.round(dist),
      dir: dirOf(dx, dy),
    };
    const blurb = world.get(e, Named)?.blurb;
    if (blurb) p.blurb = blurb;
    const f = world.get(e, Faction);
    if (f) p.faction = f.id;
    const hp = hpStr(world, e);
    if (hp) p.hp = hp;
    const sp = world.get(e, Speech);
    if (sp?.text && sp.ttl > 0) p.saying = sp.text;
    const pk = world.get(e, Pickup);
    if (pk) p.pickup = `${pk.item.name} x${pk.item.qty}`;
    nearby.push(p);
  }
  nearby.sort((a, b) => a.dist - b.dist);

  // journal → short human-readable event lines (current tick's journal only
  // holds this tick; drivers accumulate across ticks — see cognition.ts)
  const events: string[] = [];
  for (const j of world.events.journal) {
    if (j.tick <= sinceTick) continue;
    const line = describeEvent(world, j.type, j.payload);
    if (line) events.push(line);
  }

  return {
    self: {
      id: self,
      name: world.get(self, Named)?.name ?? `entity#${self}`,
      hp: hpStr(world, self),
      ...(t ? { x: Math.round(t.x), y: Math.round(t.y) } : {}),
    },
    nearby: nearby.slice(0, 12),
    events: events.slice(-10),
    time: Math.round(world.time),
  };
}

/** Render an engine event as a short line a Mind can read. Games can extend via EVENT_DESCRIBERS. */
export const EVENT_DESCRIBERS: Record<
  string,
  (world: World, payload: any) => string | null
> = {
  "combat:damaged": (w, p) =>
    `${nameOf(w, p.target)} took ${p.amount} damage from ${nameOf(w, p.source)}`,
  "combat:death": (w, p) => `${p.name ?? nameOf(w, p.entity)} died`,
  "loot:dropped": (_w, p) => `loot dropped: ${p.items?.map((i: any) => i.name).join(", ")}`,
  speech: (w, p) => `${nameOf(w, p.entity)} said: "${p.text}"`,
  "quest:completed": (_w, p) => `quest completed: ${p.name}`,
};

function nameOf(world: World, e: Entity | undefined): string {
  if (e === undefined) return "someone";
  return world.get(e, Named)?.name ?? `entity#${e}`;
}

export function describeEvent(world: World, type: string, payload: any): string | null {
  const fn = EVENT_DESCRIBERS[type];
  return fn ? fn(world, payload) : null;
}

/** Compact perception → prompt text. Kept terse: flash-tier context is precious. */
export function perceptionToText(p: Perception): string {
  const lines: string[] = [
    `You are ${p.self.name} at (${p.self.x},${p.self.y})${p.self.hp ? `, hp ${p.self.hp}` : ""}. t=${p.time}s.`,
  ];
  if (p.nearby.length) {
    lines.push("You see:");
    for (const n of p.nearby) {
      const bits = [
        `- ${n.name} (#${n.id})`,
        n.faction ? `[${n.faction}]` : "",
        n.hp ? `hp ${n.hp}` : "",
        `${n.dist}u ${n.dir}`,
        n.blurb ? `— ${n.blurb}` : "",
        n.saying ? `— saying: "${n.saying}"` : "",
        n.pickup ? `— pickup: ${n.pickup}` : "",
      ].filter(Boolean);
      lines.push(bits.join(" "));
    }
  } else {
    lines.push("You see no one nearby.");
  }
  if (p.events.length) {
    lines.push("Recently:");
    for (const e of p.events) lines.push(`- ${e}`);
  }
  return lines.join("\n");
}

import { defineComponent } from "../core/ecs.js";
import type { Entity, System, World } from "../core/ecs.js";
import { Health, Inventory, Hotbar } from "../components.js";
import type { VerbDef } from "../core/actions.js";

/**
 * Items-as-gameplay + status effects — the layer that lets ANY game have
 * potions, damage boosts, speed buffs, hotbars… without constraining what
 * an item can mean. Effects are ITEM DATA (`stats`), not engine registries:
 *
 *   { id: "potion",  name: "Potion",       stats: { heal: 30 } }
 *   { id: "fury",    name: "Fury Draught", stats: { buffDamage: 1.6, buffDuration: 8 } }
 *   { id: "haste",   name: "Wind Vial",    stats: { buffSpeed: 1.4, buffDuration: 6 } }
 *
 * `use_item` consumes one and applies what it understands (heal, buff*);
 * everything it doesn't understand still fires `item:used`, so games invent
 * arbitrary effects by listening. Buffs live in the Status component and
 * modify stats through `statOf` — combat and movement respect them for
 * every entity, including Minds using items on themselves.
 */

export const Status = defineComponent("Status", () => ({
  effects: [] as Array<{ id: string; stat: string; mult: number; timeLeft: number }>,
}));

/** Combined multiplier for a stat ("damage" | "speed" | anything games add). */
export function statOf(world: World, e: Entity, stat: string): number {
  const s = world.get(e, Status);
  if (!s) return 1;
  let m = 1;
  for (const fx of s.effects) if (fx.stat === stat && fx.timeLeft > 0) m *= fx.mult;
  return m;
}

/** Ticks buff durations down; emits status:expired as they fall off. */
export function statusSystem(): System {
  return {
    name: "status",
    order: -5,
    update({ world, dt }) {
      for (const [e, s] of world.each(Status)) {
        for (let i = s.effects.length - 1; i >= 0; i--) {
          const fx = s.effects[i];
          fx.timeLeft -= dt;
          if (fx.timeLeft <= 0) {
            s.effects.splice(i, 1);
            world.events.emit("status:expired", { entity: e, id: fx.id, stat: fx.stat });
          }
        }
      }
    },
  };
}

export const useItemVerb: VerbDef = {
  name: "use_item",
  description:
    "Use one of an item from your inventory (potions heal, draughts buff — effects come from the item's stats).",
  params: { item: { type: "string", description: "Item id", required: true } },
  validate: (w, a) => {
    const inv = w.get(a.actor, Inventory);
    if (!inv) return "you have no inventory";
    const it = inv.items.find((i) => i.id === a.params.item && i.qty > 0);
    if (!it) return `no ${a.params.item} to use`;
    const stats = it.stats ?? {};
    if (stats.heal) {
      const h = w.get(a.actor, Health);
      if (h && h.hp >= h.maxHp) return "already at full health";
    }
    return null;
  },
  resolve: (w, a) => {
    const inv = w.require(a.actor, Inventory);
    const idx = inv.items.findIndex((i) => i.id === a.params.item && i.qty > 0);
    const it = inv.items[idx];
    if (--it.qty <= 0) inv.items.splice(idx, 1);
    const stats = it.stats ?? {};
    if (stats.heal) {
      const h = w.get(a.actor, Health);
      if (h) h.hp = Math.min(h.maxHp, h.hp + stats.heal);
    }
    // any stats key shaped buffX + buffDuration becomes a timed multiplier
    const duration = stats.buffDuration ?? 6;
    for (const [k, v] of Object.entries(stats)) {
      if (!k.startsWith("buff") || k === "buffDuration" || typeof v !== "number") continue;
      const stat = k.slice(4).toLowerCase(); // buffDamage → damage
      let s = w.get(a.actor, Status);
      if (!s) s = w.add(a.actor, Status, {});
      // refresh, don't stack the same item id
      const existing = s.effects.find((fx) => fx.id === it.id && fx.stat === stat);
      if (existing) {
        existing.timeLeft = duration;
        existing.mult = v;
      } else {
        s.effects.push({ id: it.id, stat, mult: v, timeLeft: duration });
      }
    }
    w.events.emit("item:used", { entity: a.actor, item: { ...it, qty: 1 }, stats });
  },
};

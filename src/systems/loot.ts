import type { Rng, System } from "../core/ecs.js";
import { Collider, LootDrop, Pickup, Sprite, Transform } from "../components.js";

/**
 * Loot — weighted drop tables, deterministic under the world seed. Entities
 * with a LootDrop component spill pickups where they die. LLM augmentation:
 * Genesis can author whole tables (validated here) or name/flavor generated
 * items — but the ROLL is always deterministic engine code, so drops are
 * fair, replayable, and API-independent.
 */

export interface LootItemDef {
  id: string;
  name: string;
  /** Relative weight within the table. */
  weight: number;
  /** [min, max] quantity. */
  qty?: [number, number];
  tags?: string[];
  stats?: Record<string, number>;
  /** Visual for the world pickup. */
  glyph?: string;
  color?: string;
}

export interface LootTable {
  name: string;
  /** How many rolls on the table. */
  rolls: [number, number];
  /** Chance any loot drops at all. Default 1. */
  chance?: number;
  items: LootItemDef[];
}

export class LootTables {
  private tables = new Map<string, LootTable>();

  define(table: LootTable): this {
    if (!table.items.length) throw new Error(`loot table "${table.name}" has no items`);
    for (const i of table.items) {
      if (!(i.weight > 0)) throw new Error(`loot item "${i.id}" needs weight > 0`);
    }
    this.tables.set(table.name, table);
    return this;
  }

  get(name: string): LootTable | undefined {
    return this.tables.get(name);
  }

  roll(name: string, rng: Rng): Array<{ id: string; name: string; qty: number; tags?: string[]; stats?: Record<string, number>; glyph?: string; color?: string }> {
    const t = this.tables.get(name);
    if (!t) return [];
    if (!rng.chance(t.chance ?? 1)) return [];
    const total = t.items.reduce((s, i) => s + i.weight, 0);
    const n = rng.int(t.rolls[0], t.rolls[1]);
    const out: Array<{ id: string; name: string; qty: number; tags?: string[]; stats?: Record<string, number>; glyph?: string; color?: string }> = [];
    for (let i = 0; i < n; i++) {
      let r = rng.next() * total;
      for (const item of t.items) {
        r -= item.weight;
        if (r <= 0) {
          const qty = item.qty ? rng.int(item.qty[0], item.qty[1]) : 1;
          out.push({ id: item.id, name: item.name, qty, tags: item.tags, stats: item.stats, glyph: item.glyph, color: item.color });
          break;
        }
      }
    }
    return out;
  }
}

/** Spawns pickups for dying entities that carry a LootDrop. */
export function lootSystem(tables: LootTables): System {
  return {
    name: "loot",
    order: 30, // after combat emits deaths, before end-of-tick destroys apply
    update({ world }) {
      for (const j of world.events.journal) {
        if (j.type !== "combat:death") continue;
        const e = j.payload?.entity;
        if (e === undefined || !world.isAlive(e)) continue; // destroy is deferred, so components are still readable
        const drop = world.get(e, LootDrop);
        const t = world.get(e, Transform);
        if (!drop?.table || !t) continue;
        const items = tables.roll(drop.table, world.rng);
        for (const item of items) {
          const p = world.create();
          world.add(p, Transform, {
            x: t.x + world.rng.int(-18, 18),
            y: t.y + world.rng.int(-18, 18),
          });
          world.add(p, Pickup, { item: { id: item.id, name: item.name, qty: item.qty, tags: item.tags, stats: item.stats } });
          world.add(p, Sprite, { kind: "pickup", color: item.color ?? "#ffd166", size: 14, glyph: item.glyph ?? "✦", layer: -1 });
          world.add(p, Collider, { radius: 8, solid: false });
        }
        if (items.length) {
          world.events.emit("loot:dropped", { from: e, items, x: t.x, y: t.y });
        }
      }
    },
  };
}

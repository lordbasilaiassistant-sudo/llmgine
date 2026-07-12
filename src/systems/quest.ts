import { z } from "zod";
import { defineComponent } from "../core/ecs.js";
import type { Entity, System, World } from "../core/ecs.js";
import { Inventory, Transform } from "../components.js";

/**
 * Quests — objective state machines with rewards. Deterministic core; LLM
 * augmentation is authorship: Genesis can write quest JSON (validated by
 * QuestSchema) from live world state, and Minds can GIVE quests through the
 * offer_quest verb pattern. Progress tracking is pure engine code.
 */

export const ObjectiveSchema = z.object({
  /** kill: count deaths matching `match` (faction or name). collect: hold N of item id. reach: get within 40u of (x,y). talk: hear speech from entity name. */
  kind: z.enum(["kill", "collect", "reach", "talk"]),
  match: z.string().optional(),
  item: z.string().optional(),
  count: z.number().int().positive().default(1),
  x: z.number().optional(),
  y: z.number().optional(),
  label: z.string(),
});

export const QuestSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().default(""),
  objectives: z.array(ObjectiveSchema).min(1),
  rewards: z
    .object({
      items: z
        .array(z.object({ id: z.string(), name: z.string(), qty: z.number().int().positive().default(1) }))
        .default([]),
    })
    .default({ items: [] }),
});

export type Quest = z.infer<typeof QuestSchema>;

/** Attach to the entity that carries quests (usually the player). */
export const QuestLog = defineComponent("QuestLog", () => ({
  active: [] as Array<{
    quest: Quest;
    progress: number[];
    state: "active" | "completed";
  }>,
}));

export function offerQuest(world: World, holder: Entity, questRaw: unknown): Quest {
  const quest = QuestSchema.parse(questRaw);
  const log = world.require(holder, QuestLog);
  if (log.active.some((q) => q.quest.id === quest.id)) return quest;
  log.active.push({ quest, progress: quest.objectives.map(() => 0), state: "active" });
  world.events.emit("quest:accepted", { entity: holder, id: quest.id, name: quest.name });
  return quest;
}

export function questSystem(): System {
  return {
    name: "quests",
    order: 40,
    update({ world }) {
      for (const [holder, log] of world.each(QuestLog)) {
        for (const q of log.active) {
          if (q.state !== "active") continue;
          q.quest.objectives.forEach((obj, i) => {
            if (q.progress[i] >= obj.count) return;
            switch (obj.kind) {
              case "kill":
                for (const j of world.events.journal) {
                  if (j.type !== "combat:death") continue;
                  if (j.payload?.killer !== holder) continue;
                  const m = obj.match ?? "";
                  if (m === "" || j.payload?.faction === m || j.payload?.name === m) q.progress[i]++;
                }
                break;
              case "collect": {
                const inv = world.get(holder, Inventory);
                const have = inv?.items.find((it) => it.id === obj.item)?.qty ?? 0;
                q.progress[i] = Math.min(have, obj.count);
                break;
              }
              case "reach": {
                const t = world.get(holder, Transform);
                if (t && obj.x !== undefined && obj.y !== undefined) {
                  if (Math.hypot(t.x - obj.x, t.y - obj.y) < 40) q.progress[i] = obj.count;
                }
                break;
              }
              case "talk":
                for (const j of world.events.journal) {
                  if (j.type !== "speech") continue;
                  if (j.payload?.entity === holder) continue;
                  // one increment per speech event — "talk to 3 villagers"
                  // must not complete on the first conversation
                  if (!obj.match || j.payload?.name === obj.match) {
                    q.progress[i] = Math.min(obj.count, q.progress[i] + 1);
                  }
                }
                break;
            }
          });

          if (q.quest.objectives.every((obj, i) => q.progress[i] >= obj.count)) {
            q.state = "completed";
            const inv = world.get(holder, Inventory);
            if (inv) {
              for (const item of q.quest.rewards.items) {
                const existing = inv.items.find((i2) => i2.id === item.id);
                if (existing) existing.qty += item.qty;
                else inv.items.push({ id: item.id, name: item.name, qty: item.qty });
              }
            } else if (q.quest.rewards.items.length) {
              console.warn(`quest "${q.quest.id}": holder has no Inventory — rewards not granted`);
            }
            world.events.emit("quest:completed", {
              entity: holder,
              id: q.quest.id,
              name: q.quest.name,
              rewards: q.quest.rewards,
              rewardsGranted: !!inv,
            });
          }
        }
      }
    },
  };
}

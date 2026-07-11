import { defineComponent } from "../core/ecs.js";
import type { ModelTier } from "./provider.js";

/**
 * Mind — attach to ANY entity to make it intelligent. An NPC, a boss, a
 * door, a shopkeeper, a faction, the weather. Plain data like every other
 * component; the CognitionDriver (cognition.ts) does the thinking.
 */
export const Mind = defineComponent("Mind", () => ({
  /** Who am I? Injected as the system prompt core. */
  persona: "",
  /** Standing objectives, in priority order. */
  goals: [] as string[],
  /** Model tier this mind thinks with. */
  tier: "fast" as ModelTier,
  /** Think at most every N seconds of sim time (cadence). */
  thinkEvery: 6,
  /** Event types that wake this mind immediately (e.g. "combat:damaged", "speech"). */
  wakeOn: ["combat:damaged", "speech"] as string[],
  /** Verb names this mind may use. Empty = every registered verb. */
  verbs: [] as string[],
  /** How far this mind perceives, in world units. */
  sightRange: 220,
  /**
   * Perception mode: "structured" (JSON snapshot), "pixels" (renderer capture
   * → vision tier), or "both".
   */
  perception: "structured" as "structured" | "pixels" | "both",
  /** Behavior mode applied when the LLM is unavailable/over budget (deterministic fallback). */
  fallbackMode: "wander",
  /** Internal: seconds until next scheduled thought. */
  cooldown: 0,
  /** Internal: a wake event arrived; think ASAP. */
  wake: false,
  /** Internal: request in flight — don't double-dispatch. */
  thinking: false,
}));

/**
 * MindMemory — what this entity remembers. Short-term entries roll into an
 * LLM-summarized episodic log so long-lived NPCs stay coherent without
 * unbounded prompts.
 */
export const MindMemory = defineComponent("MindMemory", () => ({
  shortTerm: [] as Array<{ t: number; text: string }>,
  maxShortTerm: 12,
  episodes: [] as string[],
  maxEpisodes: 5,
}));

export function remember(
  mem: { shortTerm: Array<{ t: number; text: string }>; maxShortTerm: number },
  time: number,
  text: string,
): void {
  mem.shortTerm.push({ t: Math.round(time), text });
  if (mem.shortTerm.length > mem.maxShortTerm) {
    mem.shortTerm.splice(0, mem.shortTerm.length - mem.maxShortTerm);
  }
}

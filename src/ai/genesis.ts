import type { PrefabRegistry, Prefab } from "../core/prefab.js";
import type { ChatProvider, ModelTier } from "./provider.js";
import { ResponseCache } from "./budget.js";

/**
 * Genesis — the LLM as a content generator. Where Mind gives entities
 * runtime intelligence, Genesis creates the *stuff* of the game: prefabs,
 * loot tables, quests, dialogue. Everything generated is validated before it
 * can touch a world — the model proposes, the engine disposes.
 */

export interface GenesisOptions {
  provider: ChatProvider;
  prefabs: PrefabRegistry;
  tier?: ModelTier;
  cache?: ResponseCache;
  /** Retries after a validation failure (the error is fed back). Default 2. */
  retries?: number;
}

export class Genesis {
  private tier: ModelTier;
  private cache: ResponseCache;
  private retries: number;

  constructor(private opts: GenesisOptions) {
    this.tier = opts.tier ?? "smart";
    this.cache = opts.cache ?? new ResponseCache();
    this.retries = opts.retries ?? 2;
  }

  /**
   * Generate any JSON content with a validate-and-retry loop. `validate`
   * must throw (with a helpful message) on bad content and may return a
   * transformed value.
   */
  async generateJSON<T>(
    task: string,
    shape: string,
    validate: (raw: any) => T,
    opts: { cacheKey?: unknown[]; temperature?: number } = {},
  ): Promise<T> {
    const key = opts.cacheKey ? this.cache.key(opts.cacheKey) : null;
    if (key) {
      const hit = this.cache.get(key);
      if (hit) {
        try {
          return validate(JSON.parse(hit));
        } catch {
          // poisoned entry (validators changed, bad write) — drop it and
          // regenerate instead of failing this key forever
          this.cache.delete(key);
        }
      }
    }

    let feedback = "";
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      // the provider call sits INSIDE the retry loop's error handling — a
      // transient 429/500/timeout burns one attempt, not the whole call
      try {
        const res = await this.opts.provider.chat({
          tier: this.tier,
          json: true,
          temperature: opts.temperature ?? 0.9,
          maxTokens: 900,
          messages: [
            {
              role: "system",
              content:
                "You generate game content as JSON. Reply with ONLY a single JSON object — no prose, no markdown fences.",
            },
            {
              role: "user",
              content: `${task}\n\nRequired JSON shape:\n${shape}${feedback ? `\n\nYour previous attempt was rejected: ${feedback}\nFix it and reply with corrected JSON only.` : ""}`,
            },
          ],
        });
        let parsed = extractJSON(res.text);
        // tolerate single-key envelopes like {"answer": {...}} or {"prefab": {...}}
        const keys = parsed && typeof parsed === "object" ? Object.keys(parsed) : [];
        if (keys.length === 1 && typeof parsed[keys[0]] === "object") {
          try {
            const value = validate(parsed);
            if (key) this.cache.set(key, JSON.stringify(parsed));
            return value;
          } catch {
            parsed = parsed[keys[0]];
          }
        }
        const value = validate(parsed);
        if (key) this.cache.set(key, JSON.stringify(parsed));
        return value;
      } catch (err: any) {
        lastErr = err;
        feedback = String(err?.message ?? err).slice(0, 300);
      }
    }
    throw new Error(`genesis: generation failed after ${this.retries + 1} attempts: ${feedback}`, {
      cause: lastErr,
    });
  }

  /** Generate a prefab and register it (validated against known components). */
  async generatePrefab(description: string, constraints = ""): Promise<Prefab> {
    const known = this.opts.prefabs
      .componentTypes()
      .map((t) => `- ${t.name}: keys ${Object.keys(t.create()).join(", ")}`)
      .join("\n");
    return this.generateJSON<Prefab>(
      `Design a game entity prefab: ${description}${constraints ? `\nConstraints: ${constraints}` : ""}\nUse ONLY these components (any subset) with sensible values:\n${known}`,
      `{"name": "kebab-case-id", "components": {"ComponentName": {"key": value}}}`,
      (raw) => this.opts.prefabs.define(raw),
      // tier + component catalog in the key: a different model or a changed
      // component set must never serve the other's cached prefab
      { cacheKey: ["prefab", this.tier, description, constraints, known] },
    );
  }
}

/** Tolerant JSON extraction — strips fences and finds the outermost object. */
export function extractJSON(text: string): any {
  const cleaned = text.replace(/```(?:json)?/gi, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
    throw new Error(`no JSON object found in reply: ${text.slice(0, 120)}`);
  }
}

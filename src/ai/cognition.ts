import type { Entity, System, World } from "../core/ecs.js";
import type { ActionRegistry } from "../core/actions.js";
import type { SpatialGrid } from "../core/spatial.js";
import type { Renderer } from "../render/renderer.js";
import { Behavior, Named, Transform } from "../components.js";
import { buildPerception, describeEvent, perceptionToText } from "./eyes.js";
import { Mind, MindMemory, remember } from "./mind.js";
import type { ChatContentPart, ChatMessage, ChatProvider } from "./provider.js";
import { InferenceBudget } from "./budget.js";

/**
 * CognitionDriver — the bridge between the deterministic sim and the
 * inference layer. Runs as an ordinary system:
 *
 *  each tick: accumulate relevant journal events per mind → find minds due
 *  to think (cadence elapsed or wake event) → build perception → dispatch
 *  async LLM calls under budget → returned tool calls are SUBMITTED to the
 *  action queue and validated/resolved on a future tick like any input.
 *
 * The sim never awaits a thought. If the provider fails or the budget is
 * spent, the mind's Behavior falls back to its deterministic policy.
 */

export interface CognitionOptions {
  provider: ChatProvider;
  actions: ActionRegistry;
  grid: SpatialGrid;
  budget?: InferenceBudget;
  /** Needed only for perception "pixels"/"both". */
  renderer?: Renderer;
  /** Extra system-prompt rules appended for every mind (game-wide tone/rules). */
  worldRules?: string;
  /** Called after each completed thought (telemetry/debug). */
  onThought?: (info: { entity: Entity; text: string; toolCalls: string[]; error?: string }) => void;
}

interface PendingEvents {
  lines: string[];
}

export class CognitionDriver {
  readonly budget: InferenceBudget;
  private pending = new Map<Entity, PendingEvents>();
  /** In-flight thought promises — awaitable in tests/headless runs. */
  readonly inFlight = new Set<Promise<void>>();
  /**
   * Which entities have a thought in flight. Lives HERE, not in component
   * data: `Mind.thinking` is display state and gets serialized into saves —
   * gating dispatch on it would leave a mind loaded from a mid-thought save
   * silently lobotomized forever.
   */
  private inFlightMinds = new Set<Entity>();
  private wired: World | null = null;
  /**
   * Load epoch — bumped whenever the observed world tick moves BACKWARDS
   * (quickload/restart). A thought dispatched before the rewind must never
   * apply after it: the sim quickly re-passes the dispatch tick (60 ticks/s
   * vs multi-second LLM latency) and World.load rewinds nextEntity, so ids
   * the thought perceived can be REBOUND to different entities post-load.
   */
  private epoch = 0;
  private lastSeenTick = -1;

  constructor(private opts: CognitionOptions) {
    this.budget = opts.budget ?? new InferenceBudget();
  }

  system(): System {
    return {
      name: "cognition",
      order: 60,
      update: ({ world, dt }) => this.update(world, dt),
    };
  }

  private update(world: World, dt: number): void {
    if (this.wired !== world) {
      this.wired = world;
      world.events.on("entity:destroyed", ({ entity }) => {
        this.pending.delete(entity);
        this.inFlightMinds.delete(entity);
      });
    }
    if (world.tick < this.lastSeenTick) {
      this.epoch++;
      this.pending.clear(); // those lines describe the discarded timeline
    }
    this.lastSeenTick = world.tick;
    // 1. route this tick's events to minds that can perceive them
    for (const j of world.events.journal) {
      const line = describeEvent(world, j.type, j.payload);
      for (const [e, mind] of world.each(Mind)) {
        const involved =
          j.payload?.entity === e ||
          j.payload?.target === e ||
          j.payload?.source === e ||
          j.payload?.from === e;
        const inRange = this.eventInRange(world, j.payload, e, mind.sightRange);
        if (!involved && !inRange) continue;
        if (line && j.payload?.entity !== e) {
          let p = this.pending.get(e);
          if (!p) this.pending.set(e, (p = { lines: [] }));
          p.lines.push(line);
          if (p.lines.length > 10) p.lines.shift();
        }
        // never wake on your own actions (self-speech would loop forever);
        // being targeted always wakes
        const authored = j.payload?.entity === e || j.payload?.source === e;
        const targeted = j.payload?.target === e;
        if (mind.wakeOn.includes(j.type) && (targeted || !authored)) {
          // a wake landing mid-thought is queued, not dropped — the mind
          // reacts as soon as the in-flight thought settles
          if (this.inFlightMinds.has(e)) mind.wakeQueued = true;
          else mind.wake = true;
        }
      }
    }

    // 2. tick cadences and dispatch due minds
    for (const [e, mind] of world.each(Mind)) {
      mind.cooldown -= dt;
      if (this.inFlightMinds.has(e)) continue;
      // self-heal display flag from stale saves (nothing in flight here)
      if (mind.thinking) mind.thinking = false;
      const due = mind.cooldown <= 0 || mind.wake;
      if (!due) continue;
      mind.wake = false;
      mind.cooldown = mind.thinkEvery;
      if (!this.budget.tryAcquire()) {
        this.applyFallback(world, e, mind.fallbackMode);
        continue;
      }
      mind.thinking = true;
      this.inFlightMinds.add(e);
      const p = this.think(world, e)
        .catch((err) => {
          // failures BEFORE the provider call (bad perception, missing
          // components) must still degrade to the deterministic fallback
          // and surface in telemetry — never a silent no-op mind
          const m = world.get(e, Mind);
          this.applyFallback(world, e, m?.fallbackMode ?? "wander");
          try {
            this.opts.onThought?.({
              entity: e,
              text: "",
              toolCalls: [],
              error: String((err as any)?.message ?? err),
            });
          } catch {
            // a throwing telemetry callback must not become an unhandled rejection
          }
        })
        .finally(() => {
          this.budget.release();
          this.inFlightMinds.delete(e);
          const m = world.get(e, Mind);
          if (m) {
            m.thinking = false;
            if (m.wakeQueued) {
              m.wakeQueued = false;
              m.wake = true;
            }
          }
          this.inFlight.delete(p);
        });
      this.inFlight.add(p);
    }
  }

  private eventInRange(world: World, payload: any, e: Entity, range: number): boolean {
    const t = world.get(e, Transform);
    if (!t) return false;
    const src: Entity | undefined =
      payload?.entity ?? payload?.target ?? payload?.source ?? payload?.from;
    if (src !== undefined) {
      const st = world.get(src, Transform);
      if (st) return Math.hypot(st.x - t.x, st.y - t.y) <= range;
    }
    // events keyed by position only (loot:dropped, area telegraphs) — the
    // emitting entity may already be destroyed, but the location still matters
    if (typeof payload?.x === "number" && typeof payload?.y === "number") {
      return Math.hypot(payload.x - t.x, payload.y - t.y) <= range;
    }
    return false;
  }

  private applyFallback(world: World, e: Entity, mode: string): void {
    const b = world.get(e, Behavior);
    if (b && b.mode !== mode) b.mode = mode;
  }

  private async think(world: World, e: Entity): Promise<void> {
    const dispatchTick = world.tick;
    const dispatchEpoch = this.epoch;
    const mind = world.require(e, Mind);
    const perception = buildPerception(world, this.opts.grid, e, mind.sightRange);
    // pending already accumulated this tick's journal lines during routing —
    // it is the single source of events (merging perception's view of the
    // same journal would duplicate every line in precious flash-tier context)
    const pend = this.pending.get(e);
    if (pend?.lines.length) {
      perception.events = pend.lines.slice(-10);
      pend.lines = [];
    }

    const mem = world.get(e, MindMemory);
    const memText = mem
      ? [
          ...mem.episodes.map((ep) => `(earlier) ${ep}`),
          ...mem.shortTerm.map((s) => `[t=${s.t}s] ${s.text}`),
        ].join("\n")
      : "";

    const name = world.get(e, Named)?.name ?? `entity#${e}`;
    const system = [
      `You are ${name}, a being inside a live game world. ${mind.persona}`,
      mind.goals.length ? `Your goals, in priority order: ${mind.goals.join("; ")}.` : "",
      this.opts.worldRules ?? "",
      "Act by calling tools. You may call several. Keep any speech under 25 words, in character.",
      "Never narrate or explain — only act.",
    ]
      .filter(Boolean)
      .join("\n");

    const userParts: ChatContentPart[] = [];
    let tier = mind.tier;
    if (
      (mind.perception === "pixels" || mind.perception === "both") &&
      this.opts.renderer &&
      this.opts.provider.supportsVision
    ) {
      const t = world.get(e, Transform);
      const shot = t ? this.opts.renderer.capture(world, t.x, t.y, mind.sightRange) : null;
      if (shot) {
        userParts.push({ type: "image_url", image_url: { url: shot } });
        tier = "vision";
      }
    }
    const textBlock =
      (mind.perception === "pixels" && userParts.length
        ? "This image is your current view of the world."
        : perceptionToText(perception)) + (memText ? `\n\nYou remember:\n${memText}` : "");
    userParts.push({ type: "text", text: textBlock });

    const messages: ChatMessage[] = [
      { role: "system", content: system },
      { role: "user", content: userParts.length === 1 ? textBlock : userParts },
    ];

    const tools = this.opts.actions.toToolSchema(mind.verbs.length ? mind.verbs : undefined);

    try {
      const res = await this.opts.provider.chat({ tier, messages, tools, maxTokens: 300 });
      this.budget.noteUsage(res.usage?.totalTokens ?? 0);
      // stale thought: the world rewound (quickload) while this was in
      // flight — its intents describe a world that no longer exists. The
      // epoch catches rewinds the sim already re-advanced past (entity ids
      // may have been rebound by World.load's nextEntity rewind).
      if (world.tick < dispatchTick || this.epoch !== dispatchEpoch) {
        this.opts.onThought?.({ entity: e, text: "", toolCalls: [], error: "stale thought dropped (world rewound)" });
        return;
      }
      const used: string[] = [];
      const denied: string[] = [];
      // Mind.verbs is a hard allowlist, not a suggestion — models hallucinate
      // verbs outside their offered schema, and ActionRegistry only validates
      // capability (components), not per-mind permission.
      const allow = mind.verbs.length ? new Set(mind.verbs) : null;
      for (const tc of res.toolCalls) {
        if (allow && !allow.has(tc.name)) {
          denied.push(tc.name);
          continue;
        }
        this.opts.actions.submit({ actor: e, verb: tc.name, params: tc.args });
        used.push(tc.name);
      }
      // Flash-tier models often answer in plain text; treat it as speech.
      if (
        res.text.trim() &&
        !used.includes("say") &&
        (!allow || allow.has("say")) &&
        this.opts.actions.get("say")
      ) {
        this.opts.actions.submit({
          actor: e,
          verb: "say",
          params: { text: res.text.trim().slice(0, 140) },
        });
        used.push("say");
      }
      if (mem) {
        remember(
          mem,
          world.time,
          `I ${used.length ? `did: ${used.join(", ")}` : "did nothing"}${res.text ? ` — "${res.text.slice(0, 60)}"` : ""}`,
        );
      }
      this.opts.onThought?.({
        entity: e,
        text: res.text,
        toolCalls: used,
        error: denied.length ? `verbs outside this mind's allowlist dropped: ${denied.join(", ")}` : undefined,
      });
    } catch (err: any) {
      this.applyFallback(world, e, mind.fallbackMode);
      if (mem) remember(mem, world.time, "my mind went quiet; acting on instinct");
      this.opts.onThought?.({ entity: e, text: "", toolCalls: [], error: String(err?.message ?? err) });
    }
  }

  /** Await all in-flight thoughts (tests, headless MCP runs). */
  async settle(): Promise<void> {
    while (this.inFlight.size) await Promise.all([...this.inFlight]);
  }
}

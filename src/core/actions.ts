import type { Entity, World } from "./ecs.js";

/**
 * The intent pipeline — the single gate through which ANYTHING changes an
 * actor's behavior: player input, scripted policies, and LLM Minds all submit
 * Actions here. Verbs are registered with a validator and a resolver, so a
 * Mind can only do what its entity is genuinely capable of. The verb registry
 * doubles as the tool schema handed to LLMs.
 */

export interface Action {
  actor: Entity;
  verb: string;
  params: Record<string, any>;
}

export interface VerbParamSpec {
  type: "number" | "string" | "boolean" | "entity";
  description?: string;
  required?: boolean;
}

export interface VerbDef {
  name: string;
  description: string;
  params: Record<string, VerbParamSpec>;
  /** Can this actor perform this verb right now? Return error string to reject. */
  validate?(world: World, action: Action): string | null;
  /** Apply the action to the sim. Runs inside the tick. */
  resolve(world: World, action: Action): void;
}

export interface ActionResult {
  ok: boolean;
  error?: string;
}

export class ActionRegistry {
  private verbs = new Map<string, VerbDef>();
  private queue: Action[] = [];
  /** Log of accepted actions (for replay/debugging/networking). */
  readonly log: Array<Action & { tick: number }> = [];
  logLimit = 5000;
  /** Rolling log of ALL attempts incl. rejections + why — the debugging
   * surface for "why didn't my verb work" (agents live off this). */
  readonly recent: Array<Action & { tick: number; ok: boolean; error?: string }> = [];
  recentLimit = 200;

  register(def: VerbDef): this {
    this.verbs.set(def.name, def);
    return this;
  }

  get(name: string): VerbDef | undefined {
    return this.verbs.get(name);
  }

  list(): VerbDef[] {
    return [...this.verbs.values()];
  }

  /** Queue an action for the next tick (safe from async contexts like Minds). */
  submit(action: Action): void {
    this.queue.push(action);
  }

  /** Validate + resolve immediately (inside a tick, e.g. from input system).
   * Pass `internal: true` for actions ORIGINATED BY DETERMINISTIC SYSTEMS
   * (directors, ranged-combat policies): they are logged for debugging but
   * excluded from replay sessions — the same systems re-fire them
   * deterministically during a replay, and feeding them back would double. */
  execute(world: World, action: Action, opts?: { internal?: boolean }): ActionResult {
    const result = this.doExecute(world, action);
    this.recent.push({ ...action, tick: world.tick, ok: result.ok, error: result.error });
    if (this.recent.length > this.recentLimit) this.recent.splice(0, this.recent.length - this.recentLimit);
    if (result.ok && opts?.internal) {
      const last = this.log[this.log.length - 1];
      if (last) (last as any).internal = true;
    }
    return result;
  }

  private doExecute(world: World, action: Action): ActionResult {
    const def = this.verbs.get(action.verb);
    if (!def) return { ok: false, error: `unknown verb: ${action.verb}` };
    if (!world.isAlive(action.actor) || world.isDoomed(action.actor)) {
      return { ok: false, error: "actor is dead" };
    }
    // Enforce the declared param schema — presence AND type. LLM tool calls
    // are untrusted input; a string where a number belongs must never reach a
    // resolver (Number("garbage") = NaN corrupts Transform/spatial state).
    // Unknown params are stripped so resolvers only ever see declared keys.
    const params: Record<string, any> = {};
    for (const [key, spec] of Object.entries(def.params)) {
      const v = action.params?.[key];
      if (v === undefined) {
        if (spec.required) return { ok: false, error: `missing param: ${key}` };
        continue;
      }
      switch (spec.type) {
        case "number":
          if (typeof v !== "number" || !Number.isFinite(v)) {
            return { ok: false, error: `param ${key} must be a finite number` };
          }
          break;
        case "entity":
          if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
            return { ok: false, error: `param ${key} must be an entity id` };
          }
          break;
        case "string":
          if (typeof v !== "string") return { ok: false, error: `param ${key} must be a string` };
          break;
        case "boolean":
          if (typeof v !== "boolean") return { ok: false, error: `param ${key} must be a boolean` };
          break;
      }
      params[key] = v;
    }
    const clean: Action = { actor: action.actor, verb: action.verb, params };
    // A throwing validator/resolver must not abort the tick or discard the
    // rest of a drained batch — contain it and report failure to the caller.
    try {
      const err = def.validate?.(world, clean);
      if (err) return { ok: false, error: err };
      def.resolve(world, clean);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      world.events.emit("action:error", { ...clean, error: msg });
      return { ok: false, error: `${action.verb} failed: ${msg}` };
    }
    this.log.push({ ...clean, tick: world.tick });
    if (this.log.length > this.logLimit) this.log.splice(0, this.log.length - this.logLimit);
    world.events.emit("action", { ...clean });
    return { ok: true };
  }

  /** Drain the async queue — call once per tick from the action system. */
  drain(world: World): ActionResult[] {
    const batch = this.queue;
    this.queue = [];
    return batch.map((a) => this.execute(world, a));
  }

  /** OpenAI-style tool definitions for the verbs an actor may use. */
  toToolSchema(names?: string[]): any[] {
    if (names) {
      const missing = names.filter((n) => !this.verbs.has(n));
      if (missing.length) {
        console.warn(`toToolSchema: unknown verbs ignored: ${missing.join(", ")}`);
      }
    }
    const defs = names ? names.map((n) => this.verbs.get(n)).filter(Boolean) as VerbDef[] : this.list();
    return defs.map((d) => ({
      type: "function",
      function: {
        name: d.name,
        description: d.description,
        parameters: {
          type: "object",
          properties: Object.fromEntries(
            Object.entries(d.params).map(([k, s]) => [
              k,
              { type: s.type === "entity" ? "number" : s.type, description: s.description ?? "" },
            ]),
          ),
          required: Object.entries(d.params)
            .filter(([, s]) => s.required)
            .map(([k]) => k),
        },
      },
    }));
  }
}

/** System that drains queued (async-submitted) actions at the start of each tick. */
export function actionSystem(registry: ActionRegistry) {
  return {
    name: "actions",
    order: -100,
    update({ world }: { world: World }) {
      registry.drain(world);
    },
  };
}

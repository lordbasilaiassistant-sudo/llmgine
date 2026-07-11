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

  /** Validate + resolve immediately (inside a tick, e.g. from input system). */
  execute(world: World, action: Action): ActionResult {
    const def = this.verbs.get(action.verb);
    if (!def) return { ok: false, error: `unknown verb: ${action.verb}` };
    if (!world.isAlive(action.actor)) return { ok: false, error: "actor is dead" };
    for (const [key, spec] of Object.entries(def.params)) {
      if (spec.required && action.params[key] === undefined) {
        return { ok: false, error: `missing param: ${key}` };
      }
    }
    const err = def.validate?.(world, action);
    if (err) return { ok: false, error: err };
    def.resolve(world, action);
    this.log.push({ ...action, tick: world.tick });
    if (this.log.length > this.logLimit) this.log.splice(0, this.log.length - this.logLimit);
    world.events.emit("action", { ...action });
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

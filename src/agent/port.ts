import type { Entity, System, World } from "../core/ecs.js";
import type { ActionRegistry, ActionResult } from "../core/actions.js";
import type { GameLoop } from "../core/loop.js";
import type { SpatialGrid } from "../core/spatial.js";
import { Health, Named, Transform } from "../components.js";
import { buildPerception } from "../ai/eyes.js";

/**
 * AgentPort — the first-class surface for LLM agents to PLAY, TEST, and
 * DEBUG any llmgine game. An agent pilots an entity exactly the way a Mind
 * does: observe (the same Eyes perception pipeline) → act (the same
 * validated verb pipeline). Nothing here can do anything a Mind couldn't.
 *
 * Wire it in any game:
 *   const port = new AgentPort({ world, loop, actions, grid, avatar: hero });
 *   world.addSystem(port.system());        // event ring buffer
 *   exposeAgentPort(port);                 // browser: window.llmgine
 *   // dev server bridge: connectAgentBridge(port) — HTTP control, see
 *   // scripts/dev-server.mjs (/agent/call)
 */

export interface AgentPortOptions {
  world: World;
  loop: GameLoop;
  actions: ActionRegistry;
  grid: SpatialGrid;
  /** Default entity the agent pilots (usually the player). */
  avatar?: Entity;
  /** How far observe() sees around the avatar. Default 400. */
  sightRange?: number;
  /** Ring buffer size for events(). Default 400. */
  eventLimit?: number;
}

export class AgentPort {
  private ring: Array<{ type: string; payload: any; tick: number }> = [];
  avatar: Entity;

  constructor(private opts: AgentPortOptions) {
    this.avatar = opts.avatar ?? 0;
  }

  /** System that copies each tick's journal into the ring buffer. Add it last. */
  system(): System {
    return {
      name: "agent-port",
      order: 999,
      update: ({ world }) => {
        for (const j of world.events.journal) this.ring.push(j);
        const limit = this.opts.eventLimit ?? 400;
        if (this.ring.length > limit) this.ring.splice(0, this.ring.length - limit);
      },
    };
  }

  /** Structured observation — the SAME perception a Mind gets, plus a world census. */
  observe(entity?: Entity): any {
    const w = this.opts.world;
    const e = entity ?? this.avatar;
    const perception =
      e && w.isAlive(e) ? buildPerception(w, this.opts.grid, e, this.opts.sightRange ?? 400) : null;
    const census = w.entities().map((id) => {
      const t = w.get(id, Transform);
      const h = w.get(id, Health);
      return {
        id,
        name: w.get(id, Named)?.name,
        ...(t ? { x: Math.round(t.x), y: Math.round(t.y) } : {}),
        ...(h ? { hp: `${Math.max(0, Math.round(h.hp))}/${h.maxHp}` } : {}),
      };
    });
    return { tick: w.tick, time: +w.time.toFixed(2), paused: this.opts.loop.paused, self: perception, census };
  }

  /** Execute a verb through the validated action pipeline. */
  act(verb: string, params: Record<string, any> = {}, actor?: Entity): ActionResult {
    return this.opts.actions.execute(this.opts.world, {
      actor: actor ?? this.avatar,
      verb,
      params,
    });
  }

  /** Available verbs (names + param schema) — same schema Minds receive. */
  verbs(): any[] {
    return this.opts.actions.toToolSchema();
  }

  /** All components on an entity, as plain data. */
  state(entity?: Entity): Record<string, any> {
    return this.opts.world.componentsOf(entity ?? this.avatar);
  }

  /** Recent world events (ring buffer), optionally only after a tick. */
  events(sinceTick = 0): Array<{ type: string; payload: any; tick: number }> {
    return this.ring.filter((j) => j.tick > sinceTick);
  }

  /** Action attempts incl. rejections + why — the "why didn't it work" log. */
  actionLog(): any[] {
    return [...this.opts.actions.recent];
  }

  /** Pause real-time stepping (rAF keeps rendering; sim time stops). */
  pause(): void {
    this.opts.loop.paused = true;
  }

  resume(): void {
    this.opts.loop.paused = false;
  }

  /** Deterministically advance exactly n ticks (auto-pauses real time). */
  step(n = 1): any {
    this.opts.loop.paused = true;
    this.opts.loop.advance(Math.max(0, Math.min(3600, Math.floor(n))));
    return this.observe();
  }

  /** Serialize the world (games can override save/load with their own hooks). */
  save(): any {
    return this.opts.world.save();
  }
}

/** Expose the port as `globalThis.llmgine` for browser-driving agents. */
export function exposeAgentPort(port: AgentPort): void {
  (globalThis as any).llmgine = port;
}

/**
 * Connect to the dev server's agent bridge (scripts/dev-server.mjs). The page
 * listens on /agent/sse for commands and POSTs results back — which lets ANY
 * process on the machine drive the running game:
 *   curl -s localhost:4173/agent/call -d '{"method":"observe"}'
 *   curl -s localhost:4173/agent/call -d '{"method":"act","args":["say",{"text":"hi"}]}'
 */
export function connectAgentBridge(port: AgentPort, base = ""): void {
  if (typeof EventSource === "undefined") return;
  const es = new EventSource(`${base}/agent/sse`);
  es.onmessage = async (ev) => {
    let msg: any;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (!msg?.id || typeof msg.method !== "string") return;
    let result: any;
    let error: string | undefined;
    try {
      const fn = (port as any)[msg.method];
      if (typeof fn !== "function") throw new Error(`unknown method: ${msg.method}`);
      result = await fn.apply(port, Array.isArray(msg.args) ? msg.args : []);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    fetch(`${base}/agent/result`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: msg.id, result, error }),
    }).catch(() => {});
  };
}

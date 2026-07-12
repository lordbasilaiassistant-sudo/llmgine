import type { System, World, WorldSnapshot } from "./ecs.js";
import type { Action, ActionRegistry } from "./actions.js";
import type { ComponentType } from "./ecs.js";

/**
 * Replay — a session really is "seed + intent log" (ARCHITECTURE §3).
 *
 * Everything that mutates the sim flows through the ActionRegistry (player
 * input via the `move`/`jump`/click verbs, Mind tool calls, scripted
 * directors), so re-executing the accepted-action log against the starting
 * snapshot reproduces the run EXACTLY — including every LLM decision,
 * without a single API call. Record once with a live model; replay forever,
 * deterministically, offline.
 *
 * Record:
 *   const rec = startRecording(world, actions);           // at t0
 *   ...play...
 *   const session = rec.stop();                           // serializable
 *
 * Replay (fresh world, SAME deterministic systems, NO input/cognition):
 *   world.load(session.snapshot, types);
 *   world.addSystem(replaySystem(actions, session.log));  // instead of live input
 *   loop.advance(session.ticks);
 */

export interface ReplaySession {
  snapshot: WorldSnapshot;
  log: Array<Action & { tick: number }>;
  /** Ticks from snapshot to end of recording. */
  ticks: number;
}

export function startRecording(world: World, actions: ActionRegistry) {
  const snapshot = world.save();
  const startTick = world.tick;
  const startLen = actions.log.length;
  return {
    stop(): ReplaySession {
      return {
        snapshot,
        // internal (system-originated) actions re-arise deterministically
        // during replay — recording them too would double-fire
        log: actions.log
          .slice(startLen)
          .filter((a) => !(a as any).internal)
          .map((a) => ({ ...a, params: { ...a.params } })),
        ticks: world.tick - startTick,
      };
    },
  };
}

/**
 * Feeds the recorded actions back at their original ticks. Runs at order
 * -100 (the same slot the live action queue drains in), so same-tick
 * ordering relative to every other system is preserved. Use it INSTEAD of
 * live input systems/cognition — never alongside them.
 */
export function replaySystem(actions: ActionRegistry, log: ReplaySession["log"]): System {
  let i = 0;
  return {
    name: "replay",
    order: -100,
    update({ world }) {
      while (i < log.length && log[i].tick < world.tick) i++; // skip pre-snapshot strays
      while (i < log.length && log[i].tick === world.tick) {
        actions.execute(world, log[i]);
        i++;
      }
    },
  };
}

/**
 * One-call verification: replay a session into a fresh world and compare
 * final snapshots. Games use this in tests; agents use it to prove a fix
 * didn't change behavior.
 */
export function verifyReplay(
  session: ReplaySession,
  buildWorld: () => { world: World; actions: ActionRegistry },
  types: ComponentType<any>[],
  expectedFinal: WorldSnapshot,
  /** Component names excluded from the comparison. Cognition-scheduler
   * bookkeeping (Mind cooldowns, MindMemory notes) is written by the LIVE
   * driver only — a replay reproduces world effects, not scheduler state. */
  ignoreComponents: string[] = ["Mind", "MindMemory"],
): boolean {
  const { world, actions } = buildWorld();
  world.load(session.snapshot, types);
  world.addSystem(replaySystem(actions, session.log));
  for (let i = 0; i < session.ticks; i++) world.step(1 / 60);
  const strip = (s: WorldSnapshot) => {
    const c = structuredClone(s);
    for (const name of ignoreComponents) delete c.components[name];
    return JSON.stringify(c);
  };
  return strip(world.save()) === strip(expectedFinal);
}

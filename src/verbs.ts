import type { World } from "./core/ecs.js";
import type { Action, VerbDef } from "./core/actions.js";
import { Attack, Behavior, Faction, Inventory, Named, Pickup, Speech, Transform, Velocity } from "./components.js";

/**
 * Standard verb library — the shared vocabulary of players, scripts, and
 * Minds. Every verb validates capability (component presence) before
 * resolving, so an LLM can only do what its body allows. High-level verbs
 * (move_to / follow / attack) set deterministic Behavior intents that the
 * behavior system executes at 60 Hz — the LLM steers, the sim drives.
 */

export const sayVerb: VerbDef = {
  name: "say",
  description: "Speak aloud. Nearby entities hear it.",
  params: { text: { type: "string", description: "What to say (short, in character)", required: true } },
  validate: (w, a) => (w.has(a.actor, Speech) ? null : "you cannot speak"),
  resolve: (w, a) => {
    const s = w.require(a.actor, Speech);
    s.text = String(a.params.text).slice(0, 200);
    s.ttl = Math.min(6, 1.5 + s.text.length * 0.045);
    w.events.emit("speech", { entity: a.actor, text: s.text, name: w.get(a.actor, Named)?.name });
  },
};

export const emoteVerb: VerbDef = {
  name: "emote",
  description: "Perform a visible gesture, e.g. wave, laugh, kneel.",
  params: { kind: { type: "string", description: "The gesture", required: true } },
  validate: (w, a) => (w.has(a.actor, Speech) ? null : "you cannot emote"),
  resolve: (w, a) => {
    const s = w.require(a.actor, Speech);
    s.text = `*${String(a.params.kind).slice(0, 40)}*`;
    s.ttl = 2;
    w.events.emit("emote", { entity: a.actor, kind: a.params.kind });
  },
};

function requireMobile(w: World, a: Action): string | null {
  if (!w.has(a.actor, Behavior)) return "you cannot move (no Behavior)";
  if (!w.has(a.actor, Velocity)) return "you cannot move (no Velocity)";
  return null;
}

export const moveToVerb: VerbDef = {
  name: "move_to",
  description: "Walk toward a world position.",
  params: {
    x: { type: "number", required: true },
    y: { type: "number", required: true },
  },
  validate: requireMobile,
  resolve: (w, a) => {
    const b = w.require(a.actor, Behavior);
    b.mode = "goto";
    b.dirX = Number(a.params.x);
    b.dirY = Number(a.params.y);
    b.target = 0;
  },
};

export const followVerb: VerbDef = {
  name: "follow",
  description: "Follow another entity, keeping close.",
  params: { target: { type: "entity", description: "Entity id to follow", required: true } },
  validate: (w, a) => {
    const base = requireMobile(w, a);
    if (base) return base;
    if (Number(a.params.target) === a.actor) return "you cannot follow yourself";
    return w.isAlive(Number(a.params.target)) ? null : "no such entity";
  },
  resolve: (w, a) => {
    const b = w.require(a.actor, Behavior);
    b.mode = "chase";
    b.target = Number(a.params.target);
  },
};

export const attackVerb: VerbDef = {
  name: "attack",
  description: "Attack a target entity (chases into range first). Cannot target yourself or your own faction.",
  params: { target: { type: "entity", description: "Entity id to attack", required: true } },
  validate: (w, a) => {
    if (!w.has(a.actor, Attack)) return "you cannot attack (no Attack)";
    const base = requireMobile(w, a);
    if (base) return base;
    const target = Number(a.params.target);
    if (target === a.actor) return "you cannot attack yourself";
    if (!w.isAlive(target) || w.isDoomed(target)) return "no such entity";
    // same faction rule as projectiles — no melee friendly fire
    const af = w.get(a.actor, Faction);
    const tf = w.get(target, Faction);
    if (af && tf && af.id === tf.id) return "cannot attack your own faction";
    return null;
  },
  resolve: (w, a) => {
    const b = w.require(a.actor, Behavior);
    b.mode = "attack";
    b.target = Number(a.params.target);
  },
};

export const fleeVerb: VerbDef = {
  name: "flee",
  description: "Run away from a threat.",
  params: { from: { type: "entity", description: "Entity id to flee from", required: true } },
  validate: requireMobile,
  resolve: (w, a) => {
    const b = w.require(a.actor, Behavior);
    b.mode = "flee";
    b.target = Number(a.params.from);
  },
};

export const stopVerb: VerbDef = {
  name: "stop",
  description: "Stop moving; stand still.",
  params: {},
  validate: requireMobile,
  resolve: (w, a) => {
    const b = w.require(a.actor, Behavior);
    b.mode = "idle";
    b.target = 0;
    const v = w.require(a.actor, Velocity);
    v.vx = 0;
    v.vy = 0;
  },
};

export const jumpVerb: VerbDef = {
  name: "jump",
  description: "Jump — a brief airborne moment; melee swings and projectiles pass beneath you.",
  params: { strength: { type: "number", description: "Launch speed, 60–600 (default 240)" } },
  validate: (w, a) => {
    const v = w.get(a.actor, Velocity);
    if (!v) return "you cannot jump (no Velocity)";
    const t = w.get(a.actor, Transform);
    if (!t) return "you cannot jump (no Transform)";
    if ((t.z ?? 0) > 0) return "already airborne";
    if ((v.jumpReady ?? 0) > 0) return "still landing"; // no bunny-hop immunity
    return null;
  },
  resolve: (w, a) => {
    const v = w.require(a.actor, Velocity);
    v.vz = Math.min(600, Math.max(60, Number(a.params.strength ?? 240)));
    w.events.emit("jump", { entity: a.actor });
  },
};

export const pickupVerb: VerbDef = {
  name: "pickup",
  description: "Pick up a nearby item lying in the world.",
  params: { target: { type: "entity", description: "Pickup entity id", required: true } },
  validate: (w, a) => {
    if (!w.has(a.actor, Inventory)) return "you have no inventory";
    const target = Number(a.params.target);
    // isDoomed: another actor picked this up earlier THIS tick — the destroy
    // is deferred, so isAlive alone would let the item be duplicated
    if (!w.isAlive(target) || w.isDoomed(target) || !w.has(target, Pickup)) {
      return "nothing to pick up there";
    }
    const at = w.get(a.actor, Transform);
    const tt = w.get(target, Transform);
    if (!at || !tt) return "unreachable";
    if (Math.hypot(at.x - tt.x, at.y - tt.y) > 48) return "too far away";
    const inv = w.require(a.actor, Inventory);
    const item = w.require(target, Pickup).item;
    if (!inv.items.find((i) => i.id === item.id) && inv.items.length >= inv.capacity) {
      return "inventory full";
    }
    return null;
  },
  resolve: (w, a) => {
    const target = Number(a.params.target);
    const inv = w.require(a.actor, Inventory);
    const item = w.require(target, Pickup).item;
    const existing = inv.items.find((i) => i.id === item.id);
    if (existing) existing.qty += item.qty;
    else inv.items.push({ ...item }); // capacity checked in validate
    w.destroy(target);
    w.events.emit("item:pickup", { entity: a.actor, item: { ...item } });
  },
};

export const STANDARD_VERBS: VerbDef[] = [
  sayVerb,
  emoteVerb,
  moveToVerb,
  followVerb,
  attackVerb,
  fleeVerb,
  stopVerb,
  jumpVerb,
  pickupVerb,
];

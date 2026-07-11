/**
 * Anima ECS — the deterministic simulation heart of the engine.
 *
 * Entities are integer ids. Components are plain serializable objects stored
 * in per-type maps. Systems are functions run each fixed tick. Minds (LLM
 * intelligence) live *outside* the tick as async processes that inject
 * validated intents back in — the sim never blocks on a thought.
 */

export type Entity = number;

/** A component type: a name plus a factory for default data. */
export interface ComponentType<T> {
  readonly name: string;
  readonly create: (init?: Partial<T>) => T;
}

export function defineComponent<T extends object>(
  name: string,
  defaults: () => T,
): ComponentType<T> {
  return {
    name,
    create: (init?: Partial<T>) => ({ ...defaults(), ...init }),
  };
}

export interface SystemContext {
  world: World;
  /** Fixed timestep in seconds. */
  dt: number;
  /** Current simulation tick (increments by 1 each step). */
  tick: number;
}

export interface System {
  readonly name: string;
  /** Lower runs earlier. Default 0. */
  readonly order?: number;
  update(ctx: SystemContext): void;
}

type Listener = (payload: any) => void;

/**
 * Typed event bus. Events emitted during a tick are also recorded into a
 * per-tick journal so perception/replay/networking can consume "what
 * happened" without subscribing to everything.
 */
export class EventBus {
  private listeners = new Map<string, Set<Listener>>();
  /** Journal of events for the current tick. Cleared at the start of each step. */
  journal: Array<{ type: string; payload: any; tick: number }> = [];
  private tick = 0;
  private inTick = false;
  /** Events emitted between ticks (input handlers, external triggers) land in the NEXT tick's journal. */
  private offTick: Array<{ type: string; payload: any }> = [];

  beginTick(tick: number): void {
    this.tick = tick;
    this.journal.length = 0;
    this.inTick = true;
    for (const ev of this.offTick) this.journal.push({ ...ev, tick });
    this.offTick.length = 0;
  }

  endTick(): void {
    this.inTick = false;
  }

  on(type: string, fn: Listener): () => void {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(fn);
    return () => set!.delete(fn);
  }

  emit(type: string, payload: any = {}): void {
    if (this.inTick) this.journal.push({ type, payload, tick: this.tick });
    else this.offTick.push({ type, payload });
    const set = this.listeners.get(type);
    if (set) for (const fn of set) fn(payload);
  }
}

/** Deterministic seeded RNG (mulberry32) — same seed, same world. */
export class Rng {
  private s: number;
  constructor(seed = 1) {
    this.s = seed >>> 0 || 1;
  }
  next(): number {
    let t = (this.s += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }
  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  /** Serializable state for save/load. */
  getState(): number {
    return this.s;
  }
  setState(s: number): void {
    this.s = s >>> 0;
  }
}

export class World {
  private nextEntity: Entity = 1;
  private alive = new Set<Entity>();
  private stores = new Map<string, Map<Entity, any>>();
  private systems: System[] = [];
  private pendingDestroy: Entity[] = [];

  readonly events = new EventBus();
  readonly rng: Rng;
  tick = 0;
  /** Simulation time in seconds. */
  time = 0;

  constructor(seed = 1) {
    this.rng = new Rng(seed);
  }

  // ---- entities ----

  create(): Entity {
    const e = this.nextEntity++;
    this.alive.add(e);
    return e;
  }

  /** Deferred destroy: applied at end of the current step (safe mid-iteration). */
  destroy(e: Entity): void {
    if (this.alive.has(e)) this.pendingDestroy.push(e);
  }

  destroyNow(e: Entity): void {
    if (!this.alive.delete(e)) return;
    for (const store of this.stores.values()) store.delete(e);
    this.events.emit("entity:destroyed", { entity: e });
  }

  isAlive(e: Entity): boolean {
    return this.alive.has(e);
  }

  entityCount(): number {
    return this.alive.size;
  }

  // ---- components ----

  private store<T>(type: ComponentType<T>): Map<Entity, T> {
    let s = this.stores.get(type.name);
    if (!s) this.stores.set(type.name, (s = new Map()));
    return s;
  }

  add<T>(e: Entity, type: ComponentType<T>, init?: Partial<T>): T {
    const data = type.create(init);
    this.store(type).set(e, data);
    return data;
  }

  get<T>(e: Entity, type: ComponentType<T>): T | undefined {
    return this.store(type).get(e);
  }

  require<T>(e: Entity, type: ComponentType<T>): T {
    const c = this.store(type).get(e);
    if (!c) throw new Error(`entity ${e} missing component ${type.name}`);
    return c;
  }

  has(e: Entity, type: ComponentType<any>): boolean {
    return this.store(type).has(e);
  }

  remove(e: Entity, type: ComponentType<any>): void {
    this.store(type).delete(e);
  }

  /** Iterate entities that have ALL the given component types. */
  *query(...types: ComponentType<any>[]): IterableIterator<Entity> {
    if (types.length === 0) {
      yield* this.alive;
      return;
    }
    // iterate the smallest store for speed
    let smallest = this.store(types[0]);
    for (const t of types) {
      const s = this.store(t);
      if (s.size < smallest.size) smallest = s;
    }
    outer: for (const e of smallest.keys()) {
      if (!this.alive.has(e)) continue;
      for (const t of types) {
        if (!this.store(t).has(e)) continue outer;
      }
      yield e;
    }
  }

  /** All (entity, component) pairs for one type. */
  *each<T>(type: ComponentType<T>): IterableIterator<[Entity, T]> {
    for (const [e, c] of this.store(type)) {
      if (this.alive.has(e)) yield [e, c];
    }
  }

  // ---- systems & stepping ----

  addSystem(sys: System): this {
    this.systems.push(sys);
    this.systems.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    return this;
  }

  /** Advance the simulation exactly one fixed step. */
  step(dt: number): void {
    this.tick++;
    this.time += dt;
    this.events.beginTick(this.tick);
    const ctx: SystemContext = { world: this, dt, tick: this.tick };
    for (const sys of this.systems) sys.update(ctx);
    if (this.pendingDestroy.length) {
      for (const e of this.pendingDestroy) this.destroyNow(e);
      this.pendingDestroy.length = 0;
    }
    this.events.endTick();
  }

  // ---- serialization ----

  /** Snapshot the full component state (components must stay plain data). */
  save(): WorldSnapshot {
    const components: Record<string, Array<[Entity, any]>> = {};
    for (const [name, store] of this.stores) {
      const rows: Array<[Entity, any]> = [];
      for (const [e, c] of store) {
        if (this.alive.has(e)) rows.push([e, structuredClone(c)]);
      }
      if (rows.length) components[name] = rows;
    }
    return {
      nextEntity: this.nextEntity,
      alive: [...this.alive],
      tick: this.tick,
      time: this.time,
      rng: this.rng.getState(),
      components,
    };
  }

  load(snap: WorldSnapshot, types: ComponentType<any>[]): void {
    const byName = new Map(types.map((t) => [t.name, t]));
    this.nextEntity = snap.nextEntity;
    this.alive = new Set(snap.alive);
    this.tick = snap.tick;
    this.time = snap.time;
    this.rng.setState(snap.rng);
    this.stores.clear();
    for (const [name, rows] of Object.entries(snap.components)) {
      if (!byName.has(name)) continue; // unknown component types are dropped
      const store = new Map<Entity, any>();
      for (const [e, c] of rows) store.set(e, structuredClone(c));
      this.stores.set(name, store);
    }
  }
}

export interface WorldSnapshot {
  nextEntity: number;
  alive: Entity[];
  tick: number;
  time: number;
  rng: number;
  components: Record<string, Array<[Entity, any]>>;
}

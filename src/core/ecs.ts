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
    // Only keys present in defaults() are accepted — unknown keys from
    // untrusted init data (LLM-emitted prefabs, drifted saves) are dropped
    // rather than injected into component state.
    create: (init?: Partial<T>) => {
      const data = defaults();
      if (init) {
        for (const k of Object.keys(data) as (keyof T)[]) {
          const v = (init as any)[k as string];
          if (v !== undefined) (data as any)[k as string] = v;
        }
      }
      return data;
    },
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
  /**
   * Journal of events for the current tick. NOTE: while systems run, this
   * only contains events from systems that already ran this tick — a system
   * can never see same-tick events from later-ordered systems. Use
   * `lastJournal`/`recent()` for the complete previous tick.
   */
  journal: Array<{ type: string; payload: any; tick: number }> = [];
  /** The COMPLETE journal of the previous tick (every system had its turn). */
  lastJournal: Array<{ type: string; payload: any; tick: number }> = [];
  private tick = 0;
  private inTick = false;
  /** Events emitted between ticks (input handlers, external triggers) land in the NEXT tick's journal. */
  private offTick: Array<{ type: string; payload: any }> = [];

  beginTick(tick: number): void {
    this.tick = tick;
    this.lastJournal = this.journal;
    this.journal = [];
    this.inTick = true;
    for (const ev of this.offTick) this.journal.push({ ...ev, tick });
    this.offTick.length = 0;
  }

  endTick(): void {
    this.inTick = false;
  }

  /** Previous tick's full journal + what has landed so far this tick. */
  recent(): Array<{ type: string; payload: any; tick: number }> {
    return this.lastJournal.concat(this.journal);
  }

  /** Drop all journal/off-tick state (used by World.load). */
  reset(): void {
    this.journal = [];
    this.lastJournal = [];
    this.offTick.length = 0;
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
    // keep state normalized to uint32 — same output (imul truncates anyway),
    // but getState() stays canonical so identical worlds save identically
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
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
  private pendingDestroy = new Set<Entity>();

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
    if (this.alive.has(e)) this.pendingDestroy.add(e);
  }

  /** True if the entity is alive but scheduled to be destroyed at end of tick.
   * Validators should treat doomed entities as gone (prevents same-tick dupes). */
  isDoomed(e: Entity): boolean {
    return this.pendingDestroy.has(e);
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

  /** All entity ids currently alive (snapshot copy). */
  entities(): Entity[] {
    return [...this.alive];
  }

  /** Every component on an entity, keyed by component name (plain data —
   * safe to serialize; used by debug/agent surfaces). */
  componentsOf(e: Entity): Record<string, any> {
    const out: Record<string, any> = {};
    for (const [name, store] of this.stores) {
      const c = store.get(e);
      if (c !== undefined) out[name] = c;
    }
    return out;
  }

  // ---- components ----

  private store<T>(type: ComponentType<T>): Map<Entity, T> {
    let s = this.stores.get(type.name);
    if (!s) this.stores.set(type.name, (s = new Map()));
    return s;
  }

  add<T>(e: Entity, type: ComponentType<T>, init?: Partial<T>): T {
    if (!this.alive.has(e)) {
      throw new Error(`cannot add ${type.name} to dead entity ${e}`);
    }
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

  /** Component check by NAME — for layers that shouldn't import the type
   * (e.g. core behavior policies probing optional gameplay components). */
  hasNamed(e: Entity, componentName: string): boolean {
    return this.stores.get(componentName)?.has(e) ?? false;
  }

  /** Component data by NAME (undefined if absent). See hasNamed. */
  getNamed(e: Entity, componentName: string): any {
    return this.stores.get(componentName)?.get(e);
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
    if (this.pendingDestroy.size) {
      for (const e of this.pendingDestroy) this.destroyNow(e);
      this.pendingDestroy.clear();
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

  /**
   * Restore a snapshot. Saved component data is passed through each type's
   * `create()` so fields added since the save get their defaults (schema
   * migration) and unknown keys are dropped. Returns the names of component
   * types present in the snapshot but not in `types` — those are NOT restored;
   * a non-empty result almost always means a missing registration (warned).
   */
  load(snap: WorldSnapshot, types: ComponentType<any>[]): { dropped: string[] } {
    const byName = new Map(types.map((t) => [t.name, t]));
    this.nextEntity = snap.nextEntity;
    this.alive = new Set(snap.alive);
    this.tick = snap.tick;
    this.time = snap.time;
    this.rng.setState(snap.rng);
    this.stores.clear();
    this.pendingDestroy.clear();
    this.events.reset();
    const dropped: string[] = [];
    for (const [name, rows] of Object.entries(snap.components)) {
      const type = byName.get(name);
      if (!type) {
        dropped.push(name);
        continue;
      }
      const store = new Map<Entity, any>();
      for (const [e, c] of rows) store.set(e, type.create(structuredClone(c)));
      this.stores.set(name, store);
    }
    if (dropped.length) {
      console.warn(
        `World.load: dropped unregistered component types: ${dropped.join(", ")} — pass them in the types list to restore them`,
      );
    }
    return { dropped };
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

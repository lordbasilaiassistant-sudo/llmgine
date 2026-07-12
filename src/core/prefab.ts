import type { ComponentType, Entity, World } from "./ecs.js";

/**
 * Prefabs: JSON entity templates. The unit of content in this engine —
 * human-authorable, diffable, and LLM-emittable. Genesis (ai/genesis.ts)
 * generates game content by producing prefab JSON, which is validated here
 * before it can ever touch a world. Generation and simulation stay decoupled.
 *
 * Validation is hand-rolled (core imports nothing — the iron rule): structure
 * AND values are checked. Numbers must be finite, strings bounded, nesting
 * shallow — LLM-emitted garbage never reaches component state.
 */

export interface Prefab {
  name: string;
  /** Optional parent prefab to extend (components deep-merged over it). */
  extends?: string;
  components: Record<string, Record<string, any>>;
}

/** Per-component bounds check, registered by games (e.g. hp 1..10000). */
export type ComponentValidator = (data: Record<string, any>) => string | null;

const MAX_STRING = 4096;
const MAX_DEPTH = 4;
const MAX_ENTRIES = 128;

/** Validate a component field value: finite numbers, bounded strings/arrays/objects. */
export function checkValue(v: any, path: string, depth = 0): string | null {
  if (v === null) return null;
  switch (typeof v) {
    case "number":
      return Number.isFinite(v) ? null : `${path} must be a finite number`;
    case "string":
      return v.length <= MAX_STRING ? null : `${path} exceeds ${MAX_STRING} chars`;
    case "boolean":
      return null;
    case "object": {
      if (depth >= MAX_DEPTH) return `${path} nests deeper than ${MAX_DEPTH}`;
      const entries = Array.isArray(v) ? v.entries() : Object.entries(v);
      let n = 0;
      for (const [k, item] of entries) {
        if (++n > MAX_ENTRIES) return `${path} has more than ${MAX_ENTRIES} entries`;
        const err = checkValue(item, `${path}.${k}`, depth + 1);
        if (err) return err;
      }
      return null;
    }
    default:
      return `${path} has unsupported type ${typeof v}`;
  }
}

function isPlainObject(v: unknown): v is Record<string, any> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Parse + validate raw prefab JSON. Throws with a useful message on bad data. */
export function parsePrefab(raw: unknown): Prefab {
  if (!isPlainObject(raw)) throw new Error("prefab must be an object");
  const { name, components } = raw as any;
  if (typeof name !== "string" || name.length < 1) throw new Error("prefab.name must be a non-empty string");
  if (raw.extends !== undefined && typeof raw.extends !== "string") {
    throw new Error(`prefab "${name}".extends must be a string`);
  }
  if (!isPlainObject(components)) throw new Error(`prefab "${name}".components must be an object`);
  for (const [comp, init] of Object.entries(components)) {
    if (!isPlainObject(init)) throw new Error(`prefab "${name}" component "${comp}" must be an object`);
    for (const [field, v] of Object.entries(init)) {
      const err = checkValue(v, `${name}.${comp}.${field}`);
      if (err) throw new Error(`prefab value invalid: ${err}`);
    }
  }
  return { name, extends: (raw as any).extends, components };
}

export class PrefabRegistry {
  private prefabs = new Map<string, Prefab>();
  private types = new Map<string, ComponentType<any>>();
  private validators = new Map<string, ComponentValidator>();

  /** Register the component types prefabs are allowed to reference. */
  registerComponents(types: ComponentType<any>[]): this {
    for (const t of types) this.types.set(t.name, t);
    return this;
  }

  /** Register a bounds check run on every prefab init for that component. */
  registerValidator(componentName: string, fn: ComponentValidator): this {
    this.validators.set(componentName, fn);
    return this;
  }

  componentTypes(): ComponentType<any>[] {
    return [...this.types.values()];
  }

  /** Validate and register a prefab. Throws with a useful message on bad data. */
  define(raw: unknown): Prefab {
    const prefab = parsePrefab(raw);
    if (prefab.extends && !this.prefabs.has(prefab.extends)) {
      throw new Error(`prefab "${prefab.name}" extends unknown prefab "${prefab.extends}"`);
    }
    for (const [compName, init] of Object.entries(prefab.components)) {
      if (!this.types.has(compName)) {
        throw new Error(
          `prefab "${prefab.name}" uses unknown component "${compName}" (known: ${[...this.types.keys()].join(", ")})`,
        );
      }
      const check = this.validators.get(compName);
      const err = check?.(init);
      if (err) throw new Error(`prefab "${prefab.name}" ${compName}: ${err}`);
    }
    this.prefabs.set(prefab.name, prefab);
    return prefab;
  }

  get(name: string): Prefab | undefined {
    return this.prefabs.get(name);
  }

  list(): Prefab[] {
    return [...this.prefabs.values()];
  }

  /** Resolve extends-chain into a flat component init map. */
  private resolve(name: string, seen = new Set<string>()): Record<string, any> {
    if (seen.has(name)) throw new Error(`prefab extends cycle at "${name}"`);
    seen.add(name);
    const p = this.prefabs.get(name);
    if (!p) throw new Error(`unknown prefab "${name}"`);
    const base = p.extends ? this.resolve(p.extends, seen) : {};
    const out: Record<string, any> = { ...base };
    for (const [comp, init] of Object.entries(p.components)) {
      out[comp] = { ...(out[comp] ?? {}), ...init };
    }
    return out;
  }

  /** Instantiate a prefab into a world, with optional per-spawn overrides. */
  spawn(world: World, name: string, overrides?: Record<string, any>): Entity {
    const inits = this.resolve(name);
    if (overrides) {
      for (const [comp, init] of Object.entries(overrides)) {
        inits[comp] = { ...(inits[comp] ?? {}), ...init };
      }
    }
    const e = world.create();
    for (const [compName, init] of Object.entries(inits)) {
      const type = this.types.get(compName);
      if (!type) throw new Error(`unknown component "${compName}"`);
      world.add(e, type, init);
    }
    world.events.emit("entity:spawned", { entity: e, prefab: name });
    return e;
  }
}

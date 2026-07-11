import { z } from "zod";
import type { ComponentType, Entity, World } from "./ecs.js";

/**
 * Prefabs: JSON entity templates. The unit of content in this engine —
 * human-authorable, diffable, and LLM-emittable. Genesis (ai/genesis.ts)
 * generates game content by producing prefab JSON, which is validated here
 * before it can ever touch a world. Generation and simulation stay decoupled.
 */

export const PrefabSchema = z.object({
  name: z.string().min(1),
  /** Optional parent prefab to extend (components deep-merged over it). */
  extends: z.string().optional(),
  components: z.record(z.string(), z.record(z.string(), z.any())),
});

export type Prefab = z.infer<typeof PrefabSchema>;

export class PrefabRegistry {
  private prefabs = new Map<string, Prefab>();
  private types = new Map<string, ComponentType<any>>();

  /** Register the component types prefabs are allowed to reference. */
  registerComponents(types: ComponentType<any>[]): this {
    for (const t of types) this.types.set(t.name, t);
    return this;
  }

  componentTypes(): ComponentType<any>[] {
    return [...this.types.values()];
  }

  /** Validate and register a prefab. Throws with a useful message on bad data. */
  define(raw: unknown): Prefab {
    const prefab = PrefabSchema.parse(raw);
    if (prefab.extends && !this.prefabs.has(prefab.extends)) {
      throw new Error(`prefab "${prefab.name}" extends unknown prefab "${prefab.extends}"`);
    }
    for (const compName of Object.keys(prefab.components)) {
      if (!this.types.has(compName)) {
        throw new Error(
          `prefab "${prefab.name}" uses unknown component "${compName}" (known: ${[...this.types.keys()].join(", ")})`,
        );
      }
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

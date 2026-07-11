import type { ComponentType, World, WorldSnapshot } from "./ecs.js";

/**
 * Save slots — engine basics (issue #7). World.save()/load() already produce
 * plain snapshots; SaveStore adds named slots over a storage adapter:
 * browser localStorage, in-memory (tests/headless), or bring-your-own
 * (files, cloud). Slot metadata is caller-supplied plain data.
 */

export interface StorageAdapter {
  get(key: string): string | null | Promise<string | null>;
  set(key: string, value: string): void | Promise<void>;
  remove(key: string): void | Promise<void>;
  keys(): string[] | Promise<string[]>;
}

export class MemoryStorage implements StorageAdapter {
  private map = new Map<string, string>();
  get(k: string) { return this.map.get(k) ?? null; }
  set(k: string, v: string) { this.map.set(k, v); }
  remove(k: string) { this.map.delete(k); }
  keys() { return [...this.map.keys()]; }
}

export class LocalStorageAdapter implements StorageAdapter {
  constructor(private store: Storage = localStorage) {}
  get(k: string) { return this.store.getItem(k); }
  set(k: string, v: string) { this.store.setItem(k, v); }
  remove(k: string) { this.store.removeItem(k); }
  keys() {
    const out: string[] = [];
    for (let i = 0; i < this.store.length; i++) out.push(this.store.key(i)!);
    return out;
  }
}

export interface SaveSlot {
  slot: string;
  savedAtTick: number;
  meta: Record<string, any>;
}

interface SaveFile {
  version: 1;
  meta: Record<string, any>;
  snapshot: WorldSnapshot;
}

export class SaveStore {
  constructor(
    private storage: StorageAdapter,
    private componentTypes: ComponentType<any>[],
    private prefix = "llmgine.save.",
  ) {}

  async save(slot: string, world: World, meta: Record<string, any> = {}): Promise<void> {
    const file: SaveFile = { version: 1, meta, snapshot: world.save() };
    await this.storage.set(this.prefix + slot, JSON.stringify(file));
  }

  /** Load a slot into an existing world (replaces its state). Returns meta. */
  async load(slot: string, world: World): Promise<Record<string, any>> {
    const raw = await this.storage.get(this.prefix + slot);
    if (!raw) throw new Error(`no save in slot "${slot}"`);
    const file: SaveFile = JSON.parse(raw);
    if (file.version !== 1) throw new Error(`unsupported save version ${(file as any).version}`);
    world.load(file.snapshot, this.componentTypes);
    return file.meta;
  }

  async list(): Promise<SaveSlot[]> {
    const keys = await this.storage.keys();
    const out: SaveSlot[] = [];
    for (const k of keys) {
      if (!k.startsWith(this.prefix)) continue;
      try {
        const file: SaveFile = JSON.parse((await this.storage.get(k))!);
        out.push({ slot: k.slice(this.prefix.length), savedAtTick: file.snapshot.tick, meta: file.meta });
      } catch {
        /* corrupt slot: skip, don't crash the menu */
      }
    }
    return out;
  }

  async remove(slot: string): Promise<void> {
    await this.storage.remove(this.prefix + slot);
  }
}

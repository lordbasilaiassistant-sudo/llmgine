import type { Entity } from "./ecs.js";

/**
 * Spatial hash grid for fast range queries — used by collision, perception
 * (what can this Mind see?), and AoE combat. Rebuilt or updated per tick by
 * whatever system owns positions.
 */
export class SpatialGrid {
  private cells = new Map<string, Set<Entity>>();
  private where = new Map<Entity, string>();

  constructor(readonly cellSize = 64) {}

  private key(x: number, y: number): string {
    return `${Math.floor(x / this.cellSize)},${Math.floor(y / this.cellSize)}`;
  }

  set(e: Entity, x: number, y: number): void {
    const k = this.key(x, y);
    const prev = this.where.get(e);
    if (prev === k) return;
    if (prev !== undefined) this.cells.get(prev)?.delete(e);
    let cell = this.cells.get(k);
    if (!cell) this.cells.set(k, (cell = new Set()));
    cell.add(e);
    this.where.set(e, k);
  }

  delete(e: Entity): void {
    const prev = this.where.get(e);
    if (prev !== undefined) {
      this.cells.get(prev)?.delete(e);
      this.where.delete(e);
    }
  }

  /** Entities within `radius` of (x, y). Caller filters by exact distance if needed. */
  near(x: number, y: number, radius: number): Entity[] {
    const out: Entity[] = [];
    const c = this.cellSize;
    const x0 = Math.floor((x - radius) / c);
    const x1 = Math.floor((x + radius) / c);
    const y0 = Math.floor((y - radius) / c);
    const y1 = Math.floor((y + radius) / c);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const cell = this.cells.get(`${cx},${cy}`);
        if (cell) for (const e of cell) out.push(e);
      }
    }
    return out;
  }

  clear(): void {
    this.cells.clear();
    this.where.clear();
  }
}

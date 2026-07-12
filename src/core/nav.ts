/**
 * Navigation — engine basics (issue #5). A coarse blocked-cell grid + A*.
 * Games stamp static obstacles in (walls, pillars, buildings); behavior
 * "goto"/"chase" route around them instead of face-planting. Deterministic:
 * no randomness, stable tie-breaking.
 */

export interface PathPoint {
  x: number;
  y: number;
}

export class NavGrid {
  private blocked = new Set<string>();

  constructor(readonly cellSize = 32) {}

  private key(cx: number, cy: number): string {
    return `${cx},${cy}`;
  }

  private cellOf(x: number, y: number): [number, number] {
    return [Math.floor(x / this.cellSize), Math.floor(y / this.cellSize)];
  }

  /** Exact circle-vs-cell-rect test shared by block/unblock. */
  private *circleCells(x: number, y: number, radius: number): IterableIterator<string> {
    const c = this.cellSize;
    const x0 = Math.floor((x - radius) / c);
    const x1 = Math.floor((x + radius) / c);
    const y0 = Math.floor((y - radius) / c);
    const y1 = Math.floor((y + radius) / c);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        // clamp circle center to the cell rect — exact overlap test (no
        // center-distance approximation that under-blocks corner cells)
        const nx = Math.max(cx * c, Math.min(x, (cx + 1) * c));
        const ny = Math.max(cy * c, Math.min(y, (cy + 1) * c));
        if (Math.hypot(nx - x, ny - y) <= radius) yield this.key(cx, cy);
      }
    }
  }

  /** Stamp a circular obstacle (world units). */
  blockCircle(x: number, y: number, radius: number): void {
    for (const k of this.circleCells(x, y, radius)) this.blocked.add(k);
  }

  /** Remove a circular obstacle (destroyed pillar, opened door). Unblocks the
   * exact cells blockCircle would have stamped for the same shape. */
  unblockCircle(x: number, y: number, radius: number): void {
    for (const k of this.circleCells(x, y, radius)) this.blocked.delete(k);
  }

  blockRect(x0: number, y0: number, x1: number, y1: number): void {
    const c = this.cellSize;
    for (let cx = Math.floor(x0 / c); cx <= Math.floor(x1 / c); cx++) {
      for (let cy = Math.floor(y0 / c); cy <= Math.floor(y1 / c); cy++) {
        this.blocked.add(this.key(cx, cy));
      }
    }
  }

  clear(): void {
    this.blocked.clear();
  }

  isBlocked(x: number, y: number): boolean {
    const [cx, cy] = this.cellOf(x, y);
    return this.blocked.has(this.key(cx, cy));
  }

  /**
   * Straight line unobstructed? Supercover grid traversal (Amanatides–Woo):
   * visits EVERY cell the segment passes through — sampling-based versions
   * miss clipped cells and let paths cut through walls.
   */
  lineClear(x0: number, y0: number, x1: number, y1: number): boolean {
    const c = this.cellSize;
    let cx = Math.floor(x0 / c);
    let cy = Math.floor(y0 / c);
    const ex = Math.floor(x1 / c);
    const ey = Math.floor(y1 / c);
    if (this.blocked.has(this.key(cx, cy))) return false;
    const dx = x1 - x0;
    const dy = y1 - y0;
    const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
    const stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
    const tDeltaX = stepX !== 0 ? Math.abs(c / dx) : Infinity;
    const tDeltaY = stepY !== 0 ? Math.abs(c / dy) : Infinity;
    let tMaxX = stepX !== 0 ? ((cx + (stepX > 0 ? 1 : 0)) * c - x0) / dx : Infinity;
    let tMaxY = stepY !== 0 ? ((cy + (stepY > 0 ? 1 : 0)) * c - y0) / dy : Infinity;
    let guard = Math.abs(ex - cx) + Math.abs(ey - cy) + 4;
    while ((cx !== ex || cy !== ey) && guard-- > 0) {
      if (tMaxX < tMaxY) {
        cx += stepX;
        tMaxX += tDeltaX;
      } else if (tMaxY < tMaxX) {
        cy += stepY;
        tMaxY += tDeltaY;
      } else {
        // exact corner crossing: treat as supercover — both adjacent cells
        // must be clear or the segment grazes a wall
        if (this.blocked.has(this.key(cx + stepX, cy)) || this.blocked.has(this.key(cx, cy + stepY))) {
          return false;
        }
        cx += stepX;
        cy += stepY;
        tMaxX += tDeltaX;
        tMaxY += tDeltaY;
      }
      if (this.blocked.has(this.key(cx, cy))) return false;
    }
    return true;
  }

  /** Nearest walkable cell center to (x,y), spiraling out up to maxRings cells.
   * Returns null if everything nearby is blocked. */
  nearestWalkable(x: number, y: number, maxRings = 6): PathPoint | null {
    const c = this.cellSize;
    const [cx, cy] = this.cellOf(x, y);
    if (!this.blocked.has(this.key(cx, cy))) return { x, y };
    for (let r = 1; r <= maxRings; r++) {
      let best: PathPoint | null = null;
      let bestD = Infinity;
      for (let dx = -r; dx <= r; dx++) {
        for (let dy = -r; dy <= r; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue; // ring only
          if (this.blocked.has(this.key(cx + dx, cy + dy))) continue;
          const px = (cx + dx + 0.5) * c;
          const py = (cy + dy + 0.5) * c;
          const d = Math.hypot(px - x, py - y);
          if (d < bestD) {
            bestD = d;
            best = { x: px, y: py };
          }
        }
      }
      if (best) return best;
    }
    return null;
  }

  /**
   * A* from (x0,y0) to (x1,y1) in world units. Returns waypoints (cell
   * centers, smoothed) INCLUDING the goal, or null if unreachable within
   * `maxExpand` cell expansions.
   */
  findPath(x0: number, y0: number, x1: number, y1: number, maxExpand = 2000): PathPoint[] | null {
    // blocked goal (target hugging a wall) → route to the nearest walkable
    // cell instead of giving up
    const goal = this.nearestWalkable(x1, y1);
    if (!goal) return null;
    x1 = goal.x;
    y1 = goal.y;
    if (this.lineClear(x0, y0, x1, y1)) return [{ x: x1, y: y1 }];
    const c = this.cellSize;
    const [sx, sy] = this.cellOf(x0, y0);
    const [gx, gy] = this.cellOf(x1, y1);
    if (this.blocked.has(this.key(gx, gy))) return null;

    const open: Array<{ cx: number; cy: number; g: number; f: number }> = [
      { cx: sx, cy: sy, g: 0, f: 0 },
    ];
    const came = new Map<string, string>();
    const gScore = new Map<string, number>([[this.key(sx, sy), 0]]);
    const h = (cx: number, cy: number) => Math.hypot(cx - gx, cy - gy);
    let expanded = 0;

    while (open.length && expanded < maxExpand) {
      // stable min-f pop (small open sets; fine without a heap)
      let bi = 0;
      for (let i = 1; i < open.length; i++) if (open[i].f < open[bi].f) bi = i;
      const cur = open.splice(bi, 1)[0];
      // lazy deletion: skip stale duplicates so they don't burn the budget
      if (cur.g > (gScore.get(this.key(cur.cx, cur.cy)) ?? Infinity)) continue;
      expanded++;
      if (cur.cx === gx && cur.cy === gy) {
        // reconstruct
        const cells: Array<[number, number]> = [[gx, gy]];
        let k = this.key(gx, gy);
        while (came.has(k)) {
          k = came.get(k)!;
          const [a, b] = k.split(",").map(Number);
          cells.push([a, b]);
        }
        cells.reverse();
        // waypoints at cell centers, then smooth with line-of-sight skips
        const pts: PathPoint[] = cells.map(([a, b]) => ({ x: (a + 0.5) * c, y: (b + 0.5) * c }));
        pts[pts.length - 1] = { x: x1, y: y1 };
        const smooth: PathPoint[] = [];
        let anchor: PathPoint = { x: x0, y: y0 };
        let i = 0;
        while (i < pts.length) {
          let j = i;
          while (j + 1 < pts.length && this.lineClear(anchor.x, anchor.y, pts[j + 1].x, pts[j + 1].y)) j++;
          smooth.push(pts[j]);
          anchor = pts[j];
          i = j + 1;
        }
        return smooth;
      }
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
        const nx = cur.cx + dx;
        const ny = cur.cy + dy;
        const nk = this.key(nx, ny);
        if (this.blocked.has(nk)) continue;
        // no diagonal corner-cutting
        if (dx && dy && (this.blocked.has(this.key(cur.cx + dx, cur.cy)) || this.blocked.has(this.key(cur.cx, cur.cy + dy)))) continue;
        const ng = cur.g + (dx && dy ? Math.SQRT2 : 1); // admissible vs Euclidean h
        if (ng < (gScore.get(nk) ?? Infinity)) {
          gScore.set(nk, ng);
          came.set(nk, this.key(cur.cx, cur.cy));
          open.push({ cx: nx, cy: ny, g: ng, f: ng + h(nx, ny) });
        }
      }
    }
    return null;
  }
}

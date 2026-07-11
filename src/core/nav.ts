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

  /** Stamp a circular obstacle (world units). */
  blockCircle(x: number, y: number, radius: number): void {
    const c = this.cellSize;
    const x0 = Math.floor((x - radius) / c);
    const x1 = Math.floor((x + radius) / c);
    const y0 = Math.floor((y - radius) / c);
    const y1 = Math.floor((y + radius) / c);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const px = (cx + 0.5) * c;
        const py = (cy + 0.5) * c;
        if (Math.hypot(px - x, py - y) <= radius + c * 0.5) this.blocked.add(this.key(cx, cy));
      }
    }
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

  /** Straight line unobstructed? (cheap pre-check before A*) */
  lineClear(x0: number, y0: number, x1: number, y1: number): boolean {
    const dist = Math.hypot(x1 - x0, y1 - y0);
    const steps = Math.max(1, Math.ceil(dist / (this.cellSize * 0.5)));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      if (this.isBlocked(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t)) return false;
    }
    return true;
  }

  /**
   * A* from (x0,y0) to (x1,y1) in world units. Returns waypoints (cell
   * centers, smoothed) INCLUDING the goal, or null if unreachable within
   * `maxExpand` cell expansions.
   */
  findPath(x0: number, y0: number, x1: number, y1: number, maxExpand = 2000): PathPoint[] | null {
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
        const ng = cur.g + (dx && dy ? 1.414 : 1);
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

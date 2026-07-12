/**
 * Render-side transform interpolation (ARCHITECTURE.md: "Render interpolates;
 * sim never varies"). Renderers sample each entity's sim transform every draw;
 * when the sampled value changes (a new tick landed) the old value becomes the
 * "previous" endpoint, and `at(entity, alpha)` blends prev → current by the
 * loop's alpha. Pure math — shared by Canvas2DRenderer and ThreeRenderer,
 * unit-tested without a DOM.
 */

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Shortest-path angle lerp (radians) — never spins the long way across ±π. */
export function lerpAngle(a: number, b: number, t: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

interface XformPair {
  px: number;
  py: number;
  prot: number;
  pz: number;
  cx: number;
  cy: number;
  crot: number;
  cz: number;
}

export class TransformLerp {
  private states = new Map<number, XformPair>();

  /** Jumps larger than `snapDistance` world units snap instead of streaking (teleports/respawns). */
  constructor(private snapDistance = 120) {}

  /** Feed the entity's current sim transform. Call once per entity per draw. */
  sample(e: number, x: number, y: number, rot: number, z = 0): void {
    const s = this.states.get(e);
    if (!s) {
      this.states.set(e, { px: x, py: y, prot: rot, pz: z, cx: x, cy: y, crot: rot, cz: z });
      return;
    }
    if (s.cx === x && s.cy === y && s.crot === rot && s.cz === z) return; // same tick — keep the pair
    const snap = Math.hypot(x - s.cx, y - s.cy) > this.snapDistance;
    s.px = snap ? x : s.cx;
    s.py = snap ? y : s.cy;
    s.prot = snap ? rot : s.crot;
    s.pz = snap ? z : s.cz;
    s.cx = x;
    s.cy = y;
    s.crot = rot;
    s.cz = z;
  }

  /** Interpolated transform, or undefined if the entity was never sampled. */
  at(e: number, alpha: number): { x: number; y: number; rot: number; z: number } | undefined {
    const s = this.states.get(e);
    if (!s) return undefined;
    return {
      x: lerp(s.px, s.cx, alpha),
      y: lerp(s.py, s.cy, alpha),
      rot: lerpAngle(s.prot, s.crot, alpha),
      z: lerp(s.pz, s.cz, alpha),
    };
  }

  /** Drop entities not seen this frame (died/despawned). */
  prune(seen: ReadonlySet<number>): void {
    for (const e of this.states.keys()) if (!seen.has(e)) this.states.delete(e);
  }

  clear(): void {
    this.states.clear();
  }
}

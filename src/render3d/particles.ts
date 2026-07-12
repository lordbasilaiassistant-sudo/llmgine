import * as THREE from "three";

/**
 * ParticlePool — pooled render-side VFX (hit sparks, death bursts, pickups).
 *
 * ONE preallocated THREE.Points + ONE shared additive PointsMaterial for the
 * whole game, added to the scene once. burst() only writes into preallocated
 * typed arrays — no object/material/geometry churn per effect (per-entity
 * materials were killed for perf; this must never reintroduce that).
 *
 * Coordinates follow the engine convention: burst(x, y, z) takes SIM coords —
 * x/y = ground plane, z = height — and maps them to world (x, z, y) exactly
 * like ThreeRenderer places entities (sim y = world z).
 *
 * This is presentation-only VFX: it never touches the World, so Math.random
 * here is fine (the sim stays deterministic; replays don't care about spark
 * directions).
 *
 * Not wired into ThreeRenderer — games own the timing:
 *   const pool = new ParticlePool(renderer.scene);
 *   renderer.onFrame = () => pool.update(dtSeconds);
 *   pool.burst(t.x, t.y, 12, { color: 0xffcc55, count: 30 });
 */

/** World-Y where dead slots are parked (far below any playfield, additive black). */
const PARKED_Y = -9999;

export interface ParticlePoolOptions {
  /** Max simultaneous particles. Default 2048. */
  capacity?: number;
  /** Default point size in world units (size-attenuated). Default 5. */
  size?: number;
}

export interface BurstOptions {
  /** Single color, or a palette to pick from per particle. Default 0xffffff. */
  color?: number | number[];
  /** Particles in this burst. Default 24. */
  count?: number;
  /** Radial speed on the sim plane (world units/s). Default 70. */
  speed?: number;
  /** Initial upward (height) speed. Default 55. */
  up?: number;
  /** Downward pull on the height axis (units/s²). Default 160. */
  gravity?: number;
  /** Lifetime seconds (each particle gets 75–125% of this). Default 0.6. */
  life?: number;
  /** Point size for this burst (per-vertex, overrides pool default). */
  size?: number;
  /** Spawn radius around the origin on the sim plane. Default 2. */
  spread?: number;
}

export class ParticlePool {
  /** The single scene object. Exposed for layer/visibility tweaks. */
  readonly points: THREE.Points;

  private readonly geometry: THREE.BufferGeometry;
  private readonly material: THREE.PointsMaterial;
  private readonly posAttr: THREE.BufferAttribute;
  private readonly colAttr: THREE.BufferAttribute;
  private readonly sizeAttr: THREE.BufferAttribute;

  // CPU-side per-slot state (structure-of-arrays; zero allocation after ctor)
  private readonly vel: Float32Array; // 3N world-space velocity
  private readonly life: Float32Array; // N remaining seconds (<=0 = dead)
  private readonly maxLife: Float32Array; // N initial lifetime
  private readonly baseCol: Float32Array; // 3N spawn color (faded copy goes to colAttr)
  private readonly grav: Float32Array; // N per-particle gravity

  private cursor = 0; // rotating allocation cursor (overwrites oldest under pressure)
  private live = 0;

  readonly capacity: number;

  constructor(parent: THREE.Object3D, opts: ParticlePoolOptions = {}) {
    this.capacity = Math.max(1, Math.floor(opts.capacity ?? 2048));
    const n = this.capacity;

    const positions = new Float32Array(n * 3);
    const colors = new Float32Array(n * 3);
    const sizes = new Float32Array(n);
    for (let i = 0; i < n; i++) positions[i * 3 + 1] = PARKED_Y; // park everything

    this.geometry = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage);
    this.colAttr = new THREE.BufferAttribute(colors, 3).setUsage(THREE.DynamicDrawUsage);
    this.sizeAttr = new THREE.BufferAttribute(sizes, 1).setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute("position", this.posAttr);
    this.geometry.setAttribute("color", this.colAttr);
    this.geometry.setAttribute("size", this.sizeAttr);

    this.material = new THREE.PointsMaterial({
      size: opts.size ?? 5,
      vertexColors: true,
      blending: THREE.AdditiveBlending, // black = invisible → fade via color darkening
      transparent: true,
      depthWrite: false,
      sizeAttenuation: true,
    });
    // Per-vertex size on the ONE shared material: swap the size uniform for
    // our attribute at compile time (still a stock PointsMaterial otherwise).
    this.material.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader.replace(
        "uniform float size;",
        "attribute float size;",
      );
    };

    this.vel = new Float32Array(n * 3);
    this.life = new Float32Array(n);
    this.maxLife = new Float32Array(n);
    this.baseCol = new Float32Array(n * 3);
    this.grav = new Float32Array(n);

    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false; // parked slots at y=-9999 wreck any bounding sphere
    parent.add(this.points);
  }

  /** Currently live (unexpired) particles. */
  get liveCount(): number {
    return this.live;
  }

  /**
   * Radial burst at sim point (x, y) at height z. Spawns min(count, capacity)
   * particles; under pool pressure the OLDEST live particles are overwritten
   * (never allocates). Returns how many were spawned.
   */
  burst(x: number, y: number, z: number, opts: BurstOptions = {}): number {
    const count = Math.min(this.capacity, Math.max(0, Math.floor(opts.count ?? 24)));
    const speed = opts.speed ?? 70;
    const up = opts.up ?? 55;
    const gravity = opts.gravity ?? 160;
    const life = opts.life ?? 0.6;
    const size = opts.size ?? this.material.size;
    const spread = opts.spread ?? 2;
    const palette = Array.isArray(opts.color) ? opts.color : [opts.color ?? 0xffffff];

    const pos = this.posAttr.array as Float32Array;
    for (let i = 0; i < count; i++) {
      const s = this.cursor;
      this.cursor = (this.cursor + 1) % this.capacity;
      if (this.life[s] <= 0) this.live++;

      const angle = Math.random() * Math.PI * 2;
      const planar = speed * (0.35 + 0.65 * Math.random());
      const r = spread * Math.random();
      // sim (x, y, height z) → world (x, z, y)
      pos[s * 3] = x + Math.cos(angle) * r;
      pos[s * 3 + 1] = z + Math.random() * spread * 0.5;
      pos[s * 3 + 2] = y + Math.sin(angle) * r;
      this.vel[s * 3] = Math.cos(angle) * planar;
      this.vel[s * 3 + 1] = up * (0.6 + 0.8 * Math.random());
      this.vel[s * 3 + 2] = Math.sin(angle) * planar;

      const c = palette[(Math.random() * palette.length) | 0] ?? 0xffffff;
      const cr = ((c >> 16) & 0xff) / 255;
      const cg = ((c >> 8) & 0xff) / 255;
      const cb = (c & 0xff) / 255;
      this.baseCol[s * 3] = cr;
      this.baseCol[s * 3 + 1] = cg;
      this.baseCol[s * 3 + 2] = cb;
      const col = this.colAttr.array as Float32Array;
      col[s * 3] = cr;
      col[s * 3 + 1] = cg;
      col[s * 3 + 2] = cb;

      this.maxLife[s] = life * (0.75 + 0.5 * Math.random());
      this.life[s] = this.maxLife[s];
      this.grav[s] = gravity;
      (this.sizeAttr.array as Float32Array)[s] = size;
    }
    if (count > 0) {
      this.posAttr.needsUpdate = true;
      this.colAttr.needsUpdate = true;
      this.sizeAttr.needsUpdate = true;
    }
    return count;
  }

  /**
   * Advance all live particles by dt seconds: integrate velocity + gravity,
   * fade color toward black (alpha under additive blending), park expired
   * slots at y = PARKED_Y. Call once per rendered frame (renderer.onFrame).
   */
  update(dt: number): void {
    if (this.live === 0 || dt <= 0) return;
    const pos = this.posAttr.array as Float32Array;
    const col = this.colAttr.array as Float32Array;
    for (let s = 0; s < this.capacity; s++) {
      if (this.life[s] <= 0) continue;
      this.life[s] -= dt;
      if (this.life[s] <= 0) {
        this.life[s] = 0;
        this.live--;
        pos[s * 3] = 0;
        pos[s * 3 + 1] = PARKED_Y;
        pos[s * 3 + 2] = 0;
        col[s * 3] = col[s * 3 + 1] = col[s * 3 + 2] = 0;
        continue;
      }
      this.vel[s * 3 + 1] -= this.grav[s] * dt;
      pos[s * 3] += this.vel[s * 3] * dt;
      pos[s * 3 + 1] += this.vel[s * 3 + 1] * dt;
      pos[s * 3 + 2] += this.vel[s * 3 + 2] * dt;
      // quadratic fade reads better under additive blending than linear
      const t = this.life[s] / this.maxLife[s];
      const f = t * t;
      col[s * 3] = this.baseCol[s * 3] * f;
      col[s * 3 + 1] = this.baseCol[s * 3 + 1] * f;
      col[s * 3 + 2] = this.baseCol[s * 3 + 2] * f;
    }
    this.posAttr.needsUpdate = true;
    this.colAttr.needsUpdate = true;
  }

  /** Remove from the scene and free the single geometry + material. */
  dispose(): void {
    this.points.parent?.remove(this.points);
    this.geometry.dispose();
    this.material.dispose();
    this.live = 0;
    this.life.fill(0);
  }
}

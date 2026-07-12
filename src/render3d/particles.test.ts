import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { ParticlePool } from "./particles.js";

/**
 * ParticlePool slot lifecycle — pure math, no WebGL (THREE.Points/geometry/
 * material are plain objects until a renderer compiles them).
 */

const PARKED_Y = -9999;

function makePool(capacity = 16) {
  const scene = new THREE.Scene();
  const pool = new ParticlePool(scene, { capacity });
  return { scene, pool };
}

function positions(pool: ParticlePool): Float32Array {
  return (pool.points.geometry.getAttribute("position") as THREE.BufferAttribute)
    .array as Float32Array;
}

describe("ParticlePool", () => {
  it("is ONE Points object with ONE material added to the scene once", () => {
    const { scene, pool } = makePool();
    expect(scene.children).toEqual([pool.points]);
    expect(pool.points.material).toBeInstanceOf(THREE.PointsMaterial);
    const matBefore = pool.points.material;
    const geoBefore = pool.points.geometry;
    pool.burst(0, 0, 0, { count: 8 });
    pool.update(0.016);
    pool.burst(5, 5, 0, { count: 8 });
    // no churn: same objects, still exactly one scene child
    expect(pool.points.material).toBe(matBefore);
    expect(pool.points.geometry).toBe(geoBefore);
    expect(scene.children.length).toBe(1);
  });

  it("starts with every slot parked and zero live", () => {
    const { pool } = makePool(8);
    expect(pool.liveCount).toBe(0);
    const pos = positions(pool);
    for (let i = 0; i < 8; i++) expect(pos[i * 3 + 1]).toBe(PARKED_Y);
  });

  it("burst allocates live particles at the sim point (sim y → world z)", () => {
    const { pool } = makePool();
    const spawned = pool.burst(100, 200, 30, { count: 6, spread: 0 });
    expect(spawned).toBe(6);
    expect(pool.liveCount).toBe(6);
    const pos = positions(pool);
    for (let i = 0; i < 6; i++) {
      expect(pos[i * 3]).toBeCloseTo(100); // world x = sim x
      expect(pos[i * 3 + 1]).toBeCloseTo(30); // world y = sim height z
      expect(pos[i * 3 + 2]).toBeCloseTo(200); // world z = sim y
    }
  });

  it("update integrates motion and gravity", () => {
    const { pool } = makePool();
    pool.burst(0, 0, 50, { count: 4, spread: 0, speed: 0, up: 0, gravity: 100, life: 10 });
    pool.update(0.5); // vy = -50 after half a second → y drops
    const pos = positions(pool);
    for (let i = 0; i < 4; i++) {
      expect(pos[i * 3 + 1]).toBeLessThan(50);
      expect(pos[i * 3 + 1]).toBeGreaterThan(PARKED_Y); // still alive, not parked
    }
    expect(pool.liveCount).toBe(4);
  });

  it("colors fade toward black over life (additive alpha)", () => {
    const { pool } = makePool();
    pool.burst(0, 0, 0, { count: 4, color: 0xff8040, life: 1, gravity: 0, up: 0, speed: 0 });
    const col = (pool.points.geometry.getAttribute("color") as THREE.BufferAttribute)
      .array as Float32Array;
    const r0 = col[0];
    expect(r0).toBeCloseTo(1); // spawned at full base color
    pool.update(0.4);
    const r1 = col[0];
    expect(r1).toBeLessThan(r0);
    expect(r1).toBeGreaterThan(0);
    pool.update(0.3);
    expect(col[0]).toBeLessThan(r1);
  });

  it("update expires particles: parked at y=-9999, blacked out, live=0", () => {
    const { pool } = makePool();
    pool.burst(10, 20, 0, { count: 5, life: 0.2 });
    expect(pool.liveCount).toBe(5);
    pool.update(1.0); // > 125% of max jittered life
    expect(pool.liveCount).toBe(0);
    const pos = positions(pool);
    const col = (pool.points.geometry.getAttribute("color") as THREE.BufferAttribute)
      .array as Float32Array;
    for (let i = 0; i < 5; i++) {
      expect(pos[i * 3 + 1]).toBe(PARKED_Y);
      expect(col[i * 3]).toBe(0);
      expect(col[i * 3 + 1]).toBe(0);
      expect(col[i * 3 + 2]).toBe(0);
    }
  });

  it("respects capacity: oversized burst clamps, liveCount never exceeds capacity", () => {
    const { pool } = makePool(8);
    const spawned = pool.burst(0, 0, 0, { count: 100, life: 5 });
    expect(spawned).toBe(8);
    expect(pool.liveCount).toBe(8);
    pool.burst(1, 1, 0, { count: 100, life: 5 }); // overwrites oldest, no growth
    expect(pool.liveCount).toBe(8);
  });

  it("never grows: buffers keep the same identity and length across heavy use", () => {
    const { pool } = makePool(32);
    const posBefore = positions(pool);
    for (let i = 0; i < 50; i++) {
      pool.burst(i, -i, 0, { count: 10, life: 0.05 });
      pool.update(0.016);
    }
    pool.update(10); // expire everything
    expect(positions(pool)).toBe(posBefore); // same Float32Array, not reallocated
    expect(posBefore.length).toBe(32 * 3);
    expect(pool.liveCount).toBe(0);
  });

  it("re-uses expired slots for new bursts", () => {
    const { pool } = makePool(4);
    pool.burst(0, 0, 0, { count: 4, life: 0.1 });
    pool.update(1); // all dead
    expect(pool.liveCount).toBe(0);
    expect(pool.burst(0, 0, 0, { count: 3, life: 1 })).toBe(3);
    expect(pool.liveCount).toBe(3);
  });

  it("dispose removes the points from the scene", () => {
    const { scene, pool } = makePool();
    pool.burst(0, 0, 0, { count: 4 });
    pool.dispose();
    expect(scene.children.length).toBe(0);
    expect(pool.liveCount).toBe(0);
  });
});

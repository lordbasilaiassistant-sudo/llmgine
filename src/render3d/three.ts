import * as THREE from "three";
import type { World } from "../core/ecs.js";
import { Sprite, Transform } from "../components.js";
import type { Renderer } from "../render/renderer.js";

/**
 * ThreeRenderer — the engine's primary 3D presentation layer.
 *
 * The simulation stays planar (Transform x/y = ground plane); this renderer
 * lifts it into a lit, shadowed 3D scene. Games register a MODEL FACTORY per
 * Sprite kind: a function that builds any THREE.Object3D (procedural meshes,
 * loaded glTF, whatever the art direction needs) and can attach a per-frame
 * `animate` callback that reads live sim state — that's how models act
 * (walk cycles from Velocity, attack lunges from cooldowns, glowing eyes
 * while a Mind is thinking).
 *
 * capture() renders the current camera view to a PNG data URL — the pixel
 * feed for vision-tier Minds. In 3D the boss really does see the scene.
 */

export interface ModelContext {
  entity: number;
  world: World;
  sprite: { kind: string; color: string; size: number };
}

export type ModelFactory = (ctx: ModelContext) => THREE.Object3D;

export interface ThreeRendererOptions {
  /** Scene background / fog color. */
  clearColor?: number;
  fog?: { color: number; near: number; far: number };
  /** Camera rig: chase distance + height (a gentle isometric-ish chase cam). */
  cameraDistance?: number;
  cameraHeight?: number;
  shadows?: boolean;
}

export class ThreeRenderer implements Renderer {
  readonly three = THREE;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly gl: THREE.WebGLRenderer;
  /** Entity the camera follows (usually the player). 0 = fixed at origin. */
  followTarget = 0;
  /** Extra camera shake amplitude, decays externally. */
  shake = 0;
  /** Optional hook run every draw with (time). Use for env animation. */
  onFrame?: (time: number) => void;

  private factories = new Map<string, ModelFactory>();
  private objects = new Map<number, { obj: THREE.Object3D; kind: string }>();
  private lookAt = new THREE.Vector3();
  private camGoal = new THREE.Vector3();
  private opts: Required<Pick<ThreeRendererOptions, "cameraDistance" | "cameraHeight">> &
    ThreeRendererOptions;

  constructor(readonly container: HTMLElement, opts: ThreeRendererOptions = {}) {
    this.opts = { cameraDistance: 260, cameraHeight: 210, ...opts };
    this.gl = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.gl.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.gl.setSize(container.clientWidth, container.clientHeight);
    this.gl.shadowMap.enabled = opts.shadows ?? true;
    this.gl.shadowMap.type = THREE.PCFSoftShadowMap;
    this.gl.toneMapping = THREE.ACESFilmicToneMapping;
    this.gl.toneMappingExposure = 1.15;
    container.appendChild(this.gl.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(opts.clearColor ?? 0x0d0a12);
    if (opts.fog) this.scene.fog = new THREE.Fog(opts.fog.color, opts.fog.near, opts.fog.far);

    this.camera = new THREE.PerspectiveCamera(
      46,
      container.clientWidth / container.clientHeight,
      1,
      4000,
    );
    this.camera.position.set(0, this.opts.cameraHeight, this.opts.cameraDistance);
    this.camera.lookAt(0, 0, 0);
  }

  defineModel(kind: string, factory: ModelFactory): this {
    this.factories.set(kind, factory);
    return this;
  }

  resize(width: number, height: number): void {
    this.gl.setSize(width, height);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  private defaultModel(sprite: { color: string; size: number }): THREE.Object3D {
    const g = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({
      color: sprite.color,
      roughness: 0.55,
      metalness: 0.15,
    });
    const body = new THREE.Mesh(
      new THREE.CapsuleGeometry(sprite.size * 0.4, sprite.size * 0.6, 6, 14),
      mat,
    );
    body.position.y = sprite.size * 0.7;
    body.castShadow = true;
    g.add(body);
    return g;
  }

  draw(world: World, _alpha: number): void {
    // sync entity objects
    const seen = new Set<number>();
    for (const e of world.query(Transform, Sprite)) {
      seen.add(e);
      const t = world.require(e, Transform);
      const s = world.require(e, Sprite);
      let rec = this.objects.get(e);
      if (!rec || rec.kind !== s.kind) {
        if (rec) this.scene.remove(rec.obj);
        const factory = this.factories.get(s.kind);
        const obj = factory
          ? factory({ entity: e, world, sprite: s })
          : this.defaultModel(s);
        obj.traverse((o) => {
          if ((o as THREE.Mesh).isMesh) o.castShadow = true;
        });
        this.scene.add(obj);
        rec = { obj, kind: s.kind };
        this.objects.set(e, rec);
      }
      rec.obj.position.set(t.x, 0, t.y);
      const anim = rec.obj.userData.animate as
        | ((time: number, world: World, e: number) => void)
        | undefined;
      anim?.(world.time, world, e);
    }
    // remove dead
    for (const [e, rec] of this.objects) {
      if (!seen.has(e)) {
        this.scene.remove(rec.obj);
        rec.obj.traverse((o) => {
          const m = o as THREE.Mesh;
          if (m.isMesh) {
            m.geometry.dispose();
            (Array.isArray(m.material) ? m.material : [m.material]).forEach((x) => x.dispose());
          }
        });
        this.objects.delete(e);
      }
    }

    // chase camera
    let fx = 0,
      fz = 0;
    if (this.followTarget && world.isAlive(this.followTarget)) {
      const t = world.get(this.followTarget, Transform);
      if (t) {
        fx = t.x;
        fz = t.y;
      }
    }
    this.camGoal.set(fx * 0.6, this.opts.cameraHeight, fz * 0.6 + this.opts.cameraDistance);
    this.camera.position.lerp(this.camGoal, 0.05);
    if (this.shake > 0) {
      this.camera.position.x += (Math.random() - 0.5) * this.shake;
      this.camera.position.y += (Math.random() - 0.5) * this.shake * 0.6;
    }
    this.lookAt.lerp(new THREE.Vector3(fx * 0.75, 18, fz * 0.75), 0.08);
    this.camera.lookAt(this.lookAt);

    this.onFrame?.(world.time);
    this.gl.render(this.scene, this.camera);
  }

  /** World point → screen px (for HTML overlays: bars, bubbles, numbers). */
  project(x: number, y: number, height = 0): { sx: number; sy: number; visible: boolean } {
    const v = new THREE.Vector3(x, height, y).project(this.camera);
    return {
      sx: (v.x * 0.5 + 0.5) * this.container.clientWidth,
      sy: (-v.y * 0.5 + 0.5) * this.container.clientHeight,
      visible: v.z < 1,
    };
  }

  /** Current camera view as PNG — the Eyes pixel feed. */
  capture(): string | null {
    try {
      return this.gl.domElement.toDataURL("image/png");
    } catch {
      return null;
    }
  }

  /** Access a live entity object (attach vfx, read bones, etc.). */
  objectOf(e: number): THREE.Object3D | undefined {
    return this.objects.get(e)?.obj;
  }
}

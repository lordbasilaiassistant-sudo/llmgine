import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import type { World } from "../core/ecs.js";
import { Sprite, Transform, Velocity } from "../components.js";
import type { Renderer } from "../render/renderer.js";
import { TransformLerp } from "../render/interp.js";

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
 * capture(world, x, y, radius) crops the current framebuffer around the
 * projected world point — the pixel feed for vision-tier Minds. In 3D the
 * boss really does see the scene (its own neighborhood of it, not the whole
 * player framebuffer).
 */

/** userData tag marking geometry/materials/textures as shared assets (never per-entity disposed). */
const SHARED_TAG = "llmgineShared";

/**
 * Tag every geometry/material/texture under `root` as a SHARED asset. Clones
 * (`.clone(true)`, SkeletonUtils.clone) reference the same geometry/material
 * objects, so per-entity disposal (death, kind swap, renderer.dispose) skips
 * them — killing one knight no longer deallocates every other knight's GPU
 * buffers. Called automatically by loadGLTF().
 */
export function markSharedAssets(root: THREE.Object3D): void {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.geometry) m.geometry.userData[SHARED_TAG] = true;
    const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : [];
    for (const mat of mats) {
      mat.userData[SHARED_TAG] = true;
      for (const v of Object.values(mat)) {
        if ((v as THREE.Texture)?.isTexture) (v as THREE.Texture).userData[SHARED_TAG] = true;
      }
    }
  });
}

export interface DefaultLightingOptions {
  /** Hemisphere sky/ground colors. */
  sky?: number;
  ground?: number;
  /** Directional (sun) color. */
  sun?: number;
  /** Overall intensity multiplier. Default 1. */
  intensity?: number;
  /** Sun casts shadows (ThreeRenderer enables shadowMap by default). Default true. */
  shadows?: boolean;
}

/**
 * Sane default lighting so a first scene isn't pitch black: hemisphere fill +
 * a shadow-casting directional sun, with three r155+ physical-light-unit
 * intensities. Note the renderer enables `shadowMap` by default — this sun is
 * the default caster. Point lights you add yourself need candela-scale
 * intensity at this world scale (~10³–10⁴), and never use dark light colors
 * (linear-space multiply → black).
 */
export function defaultLighting(
  scene: THREE.Scene,
  opts: DefaultLightingOptions = {},
): { hemi: THREE.HemisphereLight; sun: THREE.DirectionalLight } {
  const k = opts.intensity ?? 1;
  const hemi = new THREE.HemisphereLight(opts.sky ?? 0xbfd4ff, opts.ground ?? 0x3d3450, 1.6 * k);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(opts.sun ?? 0xfff1dc, 2.6 * k);
  sun.position.set(220, 380, 160);
  if (opts.shadows ?? true) {
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const d = 700;
    sun.shadow.camera.left = -d;
    sun.shadow.camera.right = d;
    sun.shadow.camera.top = d;
    sun.shadow.camera.bottom = -d;
    sun.shadow.camera.far = 1600;
    sun.shadow.bias = -0.0004;
  }
  scene.add(sun);
  return { hemi, sun };
}

export interface ModelContext {
  entity: number;
  world: World;
  sprite: { kind: string; color: string; size: number };
}

export type ModelFactory = (ctx: ModelContext) => THREE.Object3D;

export interface BloomOptions {
  /** Bloom intensity. Default 0.55. */
  strength?: number;
  /** Blur spread. Default 0.3. */
  radius?: number;
  /** Luminance above which pixels bloom. Default 0.85. */
  threshold?: number;
}

/**
 * Normalize the `bloom` constructor option: falsy → null (off), `true` →
 * defaults, object → defaults + overrides. Defaults are tuned for our
 * emissive-heavy low-poly scenes — bloom should accent orbs/eyes/flashes,
 * not white out the arena.
 */
export function resolveBloom(
  bloom: boolean | BloomOptions | undefined,
): Required<BloomOptions> | null {
  if (!bloom) return null;
  const o = bloom === true ? {} : bloom;
  return {
    strength: o.strength ?? 0.55,
    radius: o.radius ?? 0.3,
    threshold: o.threshold ?? 0.85,
  };
}

export interface ThreeRendererOptions {
  /** Scene background / fog color. */
  clearColor?: number;
  fog?: { color: number; near: number; far: number };
  /** Camera rig: chase distance + height (a gentle isometric-ish chase cam). */
  cameraDistance?: number;
  cameraHeight?: number;
  shadows?: boolean;
  /**
   * Opt-in bloom post-processing (UnrealBloomPass). `true` = tuned defaults;
   * pass an object to override. Default OFF — plain `gl.render` path.
   */
  bloom?: boolean | BloomOptions;
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
  private xf = new TransformLerp();
  private lookAt = new THREE.Vector3();
  private lookGoal = new THREE.Vector3();
  private camGoal = new THREE.Vector3();
  private aheadX = 0;
  private aheadY = 0;
  private lastDrawMs = 0;
  private opts: Required<Pick<ThreeRendererOptions, "cameraDistance" | "cameraHeight">> &
    ThreeRendererOptions;
  /** Post-processing chain — only exists when opts.bloom is enabled. */
  private composer?: EffectComposer;
  private composerPasses: { dispose(): void }[] = [];

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

    // Opt-in bloom: render through an EffectComposer instead of gl.render.
    // The final OutputPass renders to the SAME canvas (tone mapping + sRGB
    // now happen there instead of in the direct-to-screen path), so
    // capture()/project/groundPoint/entityAt are untouched and the
    // preserveDrawingBuffer readback keeps working.
    const bloom = resolveBloom(opts.bloom);
    if (bloom) {
      this.composer = new EffectComposer(this.gl);
      const renderPass = new RenderPass(this.scene, this.camera);
      const bloomPass = new UnrealBloomPass(
        new THREE.Vector2(container.clientWidth, container.clientHeight),
        bloom.strength,
        bloom.radius,
        bloom.threshold,
      );
      const outputPass = new OutputPass();
      this.composer.addPass(renderPass);
      this.composer.addPass(bloomPass);
      this.composer.addPass(outputPass);
      this.composerPasses = [renderPass, bloomPass, outputPass];
    }
  }

  defineModel(kind: string, factory: ModelFactory): this {
    this.factories.set(kind, factory);
    return this;
  }

  resize(width: number, height: number): void {
    this.gl.setSize(width, height);
    this.composer?.setSize(width, height); // resizes buffers + every pass
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

  draw(world: World, alpha: number): void {
    // sync entity objects (interpolating prev tick → current tick by alpha)
    const seen = new Set<number>();
    for (const e of world.query(Transform, Sprite)) {
      seen.add(e);
      const t = world.require(e, Transform);
      const s = world.require(e, Sprite);
      let rec = this.objects.get(e);
      if (!rec || rec.kind !== s.kind) {
        if (rec) {
          this.scene.remove(rec.obj);
          this.disposeObject(rec.obj); // kind swap frees the old model's GPU resources
        }
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
      this.xf.sample(e, t.x, t.y, t.rot, (t as any).z ?? 0);
      const ip = this.xf.at(e, alpha) ?? { ...t, z: (t as any).z ?? 0 };
      rec.obj.position.set(ip.x, ip.z, ip.y); // Transform.z = height (jump arcs)
      // sim rot (radians, 0 = +x, toward +y) → Y rotation on the ground plane
      // (x→X, y→Z). Models authored facing +X need rotation.y = -rot. A model
      // factory that steers its own rig sets obj.userData.selfRotate = true
      // to opt out (otherwise root+rig would double-rotate).
      if (!rec.obj.userData.selfRotate) rec.obj.rotation.y = -ip.rot;
      const anim = rec.obj.userData.animate as
        | ((time: number, world: World, e: number) => void)
        | undefined;
      anim?.(world.time, world, e);
    }
    // remove dead
    for (const [e, rec] of this.objects) {
      if (!seen.has(e)) {
        this.scene.remove(rec.obj);
        this.disposeObject(rec.obj);
        this.objects.delete(e);
      }
    }
    this.xf.prune(seen);

    // chase camera — lerp factors are dt-scaled so chase speed is identical
    // at 60 and 144 Hz (exponential smoothing normalized to a 60 Hz base).
    const nowMs = typeof performance !== "undefined" ? performance.now() : Date.now();
    const dt = this.lastDrawMs ? Math.min((nowMs - this.lastDrawMs) / 1000, 0.1) : 1 / 60;
    this.lastDrawMs = nowMs;
    const posK = 1 - Math.pow(1 - 0.09, dt * 60); // tighter: ≤15u trail at full sprint
    const lookK = 1 - Math.pow(1 - 0.08, dt * 60);
    let fx = 0,
      fz = 0,
      lvx = 0,
      lvy = 0;
    if (this.followTarget && world.isAlive(this.followTarget)) {
      const t = world.get(this.followTarget, Transform);
      const ip = this.xf.at(this.followTarget, alpha);
      if (ip) {
        fx = ip.x;
        fz = ip.y;
      } else if (t) {
        fx = t.x;
        fz = t.y;
      }
      // velocity lookahead — bias the view TOWARD travel (action-game
      // convention: show the player what they're running into). The
      // lookahead itself is EASED: player velocity is a step function
      // (instant accel), and feeding it raw makes the camera lurch on
      // every key press/release.
      const v = world.get(this.followTarget, Velocity);
      if (v) {
        const clampU = (n: number) => Math.max(-60, Math.min(60, n));
        const aheadK = 1 - Math.pow(1 - 0.035, dt * 60); // ~0.5s ease
        this.aheadX += (clampU(v.vx * 0.35) - this.aheadX) * aheadK;
        this.aheadY += (clampU(v.vy * 0.35) - this.aheadY) * aheadK;
      }
      lvx = this.aheadX;
      lvy = this.aheadY;
    }
    this.camGoal.set(fx * 0.6 + lvx * 0.5, this.opts.cameraHeight, fz * 0.6 + lvy * 0.5 + this.opts.cameraDistance);
    this.camera.position.lerp(this.camGoal, posK);
    if (this.shake > 0) {
      this.camera.position.x += (Math.random() - 0.5) * this.shake;
      this.camera.position.y += (Math.random() - 0.5) * this.shake * 0.6;
    }
    this.lookGoal.set(fx * 0.75 + lvx, 18, fz * 0.75 + lvy);
    this.lookAt.lerp(this.lookGoal, lookK);
    this.camera.lookAt(this.lookAt);

    this.onFrame?.(world.time);
    if (this.composer) this.composer.render();
    else this.gl.render(this.scene, this.camera);
  }

  /**
   * Dispose an object's GPU resources (geometry, materials, textures) —
   * skipping anything tagged by markSharedAssets() (glTF assets shared
   * between clones; freed only when the page unloads).
   */
  private disposeObject(root: THREE.Object3D): void {
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry && !m.geometry.userData[SHARED_TAG]) m.geometry.dispose();
      const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : [];
      for (const mat of mats) {
        if (mat.userData[SHARED_TAG]) continue;
        for (const v of Object.values(mat)) {
          const tex = v as THREE.Texture;
          if (tex?.isTexture && !tex.userData[SHARED_TAG]) tex.dispose();
        }
        mat.dispose();
      }
    });
  }

  /**
   * Release everything: per-entity objects, the scene, and the WebGL context
   * itself (browsers cap live contexts at ~16 — a reload/re-create flow that
   * skips this eventually gets a dead black canvas).
   */
  dispose(): void {
    for (const rec of this.objects.values()) {
      this.scene.remove(rec.obj);
      this.disposeObject(rec.obj);
    }
    this.objects.clear();
    this.xf.clear();
    this.scene.clear();
    for (const pass of this.composerPasses) pass.dispose();
    this.composerPasses = [];
    this.composer?.dispose(); // frees the composer's internal render targets
    this.composer = undefined;
    this.gl.dispose();
    this.gl.forceContextLoss();
    this.gl.domElement.remove();
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

  /**
   * The entity whose MODEL is under the cursor (raycast against the actual
   * meshes — players click the sprite they see, not its ground shadow).
   * Returns 0 when nothing entity-owned is hit.
   */
  entityAt(clientX: number, clientY: number): number {
    this.camera.updateMatrixWorld();
    const rect = this.gl.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const roots: THREE.Object3D[] = [];
    const owner = new Map<THREE.Object3D, number>();
    for (const [e, rec] of this.objects) {
      roots.push(rec.obj);
      owner.set(rec.obj, e);
    }
    const hits = ray.intersectObjects(roots, true);
    for (const hit of hits) {
      let o: THREE.Object3D | null = hit.object;
      while (o) {
        const e = owner.get(o);
        if (e !== undefined) return e;
        o = o.parent;
      }
    }
    return 0;
  }

  /**
   * Screen px → sim-plane world point (the inverse of project, on the
   * ground plane y=0). Powers click/tap-to-move — see input/controller.ts.
   * Returns null when the ray misses the plane (looking at the sky).
   */
  groundPoint(clientX: number, clientY: number): { x: number; y: number } | null {
    // matrixWorld only refreshes during render — unproject against the
    // camera's CURRENT pose (hidden tabs / same-frame camera moves)
    this.camera.updateMatrixWorld();
    const rect = this.gl.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const hit = new THREE.Vector3();
    if (!ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), hit)) return null;
    return { x: hit.x, y: hit.z }; // sim y maps to world z
  }

  /**
   * Region around a world point as PNG — the Eyes pixel feed.
   *
   * Approach: project (x, y) to screen space and CROP the current framebuffer
   * around it (preserveDrawingBuffer is on, so the last rendered frame is
   * readable). Radius in world units is converted to pixels by projecting a
   * point `radius` away and measuring the screen distance — cheap (no second
   * render pass / render target), and each vision Mind sees its own
   * neighborhood instead of the full player framebuffer. Returns null when
   * the point is behind the camera or pixels can't be read.
   */
  capture(_world: World, x: number, y: number, radius: number): string | null {
    try {
      const canvas = this.gl.domElement;
      const c = this.project(x, y);
      if (!c.visible) return null;
      const edge = this.project(x + radius, y);
      const rCss = Math.max(24, Math.hypot(edge.sx - c.sx, edge.sy - c.sy));
      // project() returns CSS px; the drawing buffer is DPR-scaled
      const scale = canvas.width / Math.max(1, this.container.clientWidth);
      const cx = c.sx * scale;
      const cy = c.sy * scale;
      const r = rCss * scale;
      const out = typeof document !== "undefined" ? document.createElement("canvas") : null;
      if (!out) return null;
      out.width = out.height = Math.min(512, Math.max(64, Math.round(r * 2)));
      const octx = out.getContext("2d");
      if (!octx) return null;
      octx.drawImage(canvas, cx - r, cy - r, r * 2, r * 2, 0, 0, out.width, out.height);
      return out.toDataURL("image/png");
    } catch {
      return null;
    }
  }

  /** Access a live entity object (attach vfx, read bones, etc.). */
  objectOf(e: number): THREE.Object3D | undefined {
    return this.objects.get(e)?.obj;
  }
}

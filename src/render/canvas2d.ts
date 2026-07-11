import type { World } from "../core/ecs.js";
import { Health, Named, Speech, Sprite, Transform } from "../components.js";
import type { Renderer } from "./renderer.js";

export interface Camera {
  x: number;
  y: number;
  zoom: number;
}

export interface Canvas2DOptions {
  background?: string;
  /** Draw world-space content under entities (floors, grids, vfx). */
  drawUnder?: (ctx: CanvasRenderingContext2D, world: World) => void;
  /** Draw world-space content over entities. */
  drawOver?: (ctx: CanvasRenderingContext2D, world: World) => void;
  /** Draw screen-space UI after everything. */
  drawUI?: (ctx: CanvasRenderingContext2D, world: World) => void;
}

/** Everything a skin needs to draw one entity at the origin (already translated). */
export interface SkinContext {
  ctx: CanvasRenderingContext2D;
  world: World;
  entity: number;
  sprite: { kind: string; color: string; size: number; glyph: string; layer: number };
  t: { x: number; y: number; rot: number };
  /** World simulation time (seconds) — drive idle/walk cycles from this. */
  time: number;
}

export type Skin = (s: SkinContext) => void;

/**
 * Built-in 2D renderer. Deliberately minimal-but-polished defaults: layered
 * sprites, glyphs, health bars, speech bubbles, camera with zoom. Games are
 * expected to layer real art direction on top via drawUnder/drawOver/drawUI —
 * this class is the floor, not the ceiling.
 */
export class Canvas2DRenderer implements Renderer {
  readonly camera: Camera = { x: 0, y: 0, zoom: 1 };
  private ctx: CanvasRenderingContext2D;
  private skins = new Map<string, Skin>();
  private images = new Map<string, HTMLImageElement>();

  constructor(
    readonly canvas: HTMLCanvasElement,
    private opts: Canvas2DOptions = {},
  ) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2d context unavailable");
    this.ctx = ctx;
  }

  /**
   * Register a custom skin for a Sprite kind. This is how games give
   * entities real bodies — layered vector art, animation driven by world
   * time / velocity, whatever the art direction needs. The built-in
   * circle/rect are placeholders, not the ceiling.
   */
  defineSkin(kind: string, skin: Skin): this {
    this.skins.set(kind, skin);
    return this;
  }

  /** Register an image (sprite/atlas). Sprite kind "image:<name>" draws it centered at `size`. */
  defineImage(name: string, src: string): this {
    const img = new Image();
    img.src = src;
    this.images.set(name, img);
    return this;
  }

  resize(width: number, height: number): void {
    this.canvas.width = width;
    this.canvas.height = height;
  }

  private applyCamera(): void {
    const { width, height } = this.canvas;
    this.ctx.setTransform(
      this.camera.zoom,
      0,
      0,
      this.camera.zoom,
      width / 2 - this.camera.x * this.camera.zoom,
      height / 2 - this.camera.y * this.camera.zoom,
    );
  }

  draw(world: World): void {
    const ctx = this.ctx;
    const { width, height } = this.canvas;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = this.opts.background ?? "#0b0e14";
    ctx.fillRect(0, 0, width, height);

    this.applyCamera();
    this.opts.drawUnder?.(ctx, world);

    // gather + sort by layer then y (painter's order)
    const drawables: Array<{ e: number; t: any; s: any }> = [];
    for (const e of world.query(Transform, Sprite)) {
      drawables.push({ e, t: world.require(e, Transform), s: world.require(e, Sprite) });
    }
    drawables.sort((a, b) => a.s.layer - b.s.layer || a.t.y - b.t.y);

    for (const { e, t, s } of drawables) {
      ctx.save();
      ctx.translate(t.x, t.y);
      const r = s.size / 2;
      // soft shadow
      ctx.fillStyle = "rgba(0,0,0,0.35)";
      ctx.beginPath();
      ctx.ellipse(0, r * 0.85, r * 0.9, r * 0.35, 0, 0, Math.PI * 2);
      ctx.fill();

      // custom skin takes over entirely
      const skin = this.skins.get(s.kind);
      if (skin) {
        skin({ ctx, world, entity: e, sprite: s, t, time: world.time });
        this.drawStatus(ctx, world, e, s, r);
        ctx.restore();
        continue;
      }
      // image sprite
      if (s.kind.startsWith("image:")) {
        const img = this.images.get(s.kind.slice(6));
        if (img?.complete && img.naturalWidth) {
          ctx.drawImage(img, -r, -r, s.size, s.size);
          this.drawStatus(ctx, world, e, s, r);
          ctx.restore();
          continue;
        }
      }
      // body with soft glow
      ctx.save();
      ctx.shadowColor = s.color;
      ctx.shadowBlur = s.size * 0.7;
      ctx.fillStyle = s.color;
      if (s.kind === "rect") {
        ctx.fillRect(-r, -r, s.size, s.size);
      } else {
        ctx.beginPath();
        ctx.arc(0, 0, r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
      // inner shade for depth
      const sh = ctx.createRadialGradient(-r * 0.3, -r * 0.35, r * 0.1, 0, 0, r);
      sh.addColorStop(0, "rgba(255,255,255,0.25)");
      sh.addColorStop(0.55, "rgba(255,255,255,0)");
      sh.addColorStop(1, "rgba(0,0,0,0.28)");
      ctx.fillStyle = sh;
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.fill();
      if (s.glyph) {
        ctx.font = `${Math.round(s.size * 0.72)}px system-ui, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = "rgba(13,10,18,0.82)";
        ctx.fillText(s.glyph, 0, 1);
      }
      this.drawStatus(ctx, world, e, s, r);
      ctx.restore();
    }

    // speech bubbles (world space, above entities)
    for (const [e, sp] of world.each(Speech)) {
      if (!sp.text || sp.ttl <= 0) continue;
      const t = world.get(e, Transform);
      if (!t) continue;
      const s = world.get(e, Sprite);
      const name = world.get(e, Named)?.name ?? "";
      const lift = (s?.size ?? 24) / 2 + 26;
      ctx.save();
      ctx.font = "13px system-ui, sans-serif";
      const text = sp.text.length > 90 ? sp.text.slice(0, 87) + "…" : sp.text;
      const w = Math.min(ctx.measureText(text).width + 16, 260);
      ctx.translate(t.x, t.y - lift);
      ctx.fillStyle = "rgba(12,16,24,0.92)";
      ctx.strokeStyle = "rgba(255,255,255,0.18)";
      ctx.beginPath();
      (ctx as any).roundRect?.(-w / 2, -30, w, 26, 8);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = "#e8ecf4";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(text, 0, -17, w - 12);
      if (name) {
        ctx.font = "10px system-ui, sans-serif";
        ctx.fillStyle = "rgba(255,255,255,0.5)";
        ctx.fillText(name, 0, -36);
      }
      ctx.restore();
    }

    this.opts.drawOver?.(ctx, world);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.opts.drawUI?.(ctx, world);
  }

  /** Health bar (and future status chrome) above an entity, in local space. */
  private drawStatus(
    ctx: CanvasRenderingContext2D,
    world: World,
    e: number,
    s: { size: number },
    r: number,
  ): void {
    const h = world.get(e, Health);
    if (h && h.hp < h.maxHp) {
      const w = s.size * 1.2;
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      ctx.fillRect(-w / 2, -r - 12, w, 5);
      ctx.fillStyle = h.hp / h.maxHp > 0.35 ? "#5dd97c" : "#ff5d5d";
      ctx.fillRect(-w / 2, -r - 12, (w * h.hp) / h.maxHp, 5);
    }
  }

  /** Crop the current frame around a world point — the Eyes "pixels" feed. */
  capture(world: World, x: number, y: number, radius: number): string | null {
    const z = this.camera.zoom;
    const sx = this.canvas.width / 2 + (x - this.camera.x) * z - radius * z;
    const sy = this.canvas.height / 2 + (y - this.camera.y) * z - radius * z;
    const size = radius * 2 * z;
    const out = typeof document !== "undefined" ? document.createElement("canvas") : null;
    if (!out) return null;
    out.width = out.height = Math.min(512, Math.max(64, Math.round(size)));
    const octx = out.getContext("2d");
    if (!octx) return null;
    octx.drawImage(this.canvas, sx, sy, size, size, 0, 0, out.width, out.height);
    return out.toDataURL("image/png");
  }
}

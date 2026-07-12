import type { Entity, World } from "../core/ecs.js";
import type { ActionRegistry } from "../core/actions.js";
import type { GameLoop } from "../core/loop.js";

/**
 * Live in-game inspector — llmgine's answer to an engine editor. A zero-dep
 * DOM overlay (hotkey-toggled, default F2) that reads/writes the RUNNING sim:
 * pause/step the loop, browse entities, edit live component data as JSON,
 * fire verbs through the validated action pipeline, watch the action log.
 * Dev tool only: it mutates live component refs, bypassing the verb gate —
 * never wire it to anything but a human hand.
 */

export interface InspectorRendererHook {
  /** Canvas-space picking: entity id at (x, y), or 0/undefined for none. */
  entityAt?(x: number, y: number): Entity;
}

export interface InspectorOptions {
  world: World;
  actions: ActionRegistry;
  loop: GameLoop;
  renderer?: InspectorRendererHook;
  /** KeyboardEvent.key that toggles the overlay. Default "F2". */
  hotkey?: string;
}

export interface InspectorHandle {
  dispose(): void;
  open(): void;
}

/** Parse component JSON and merge it onto a LIVE component ref. Never throws.
 * Pure logic behind the per-component Apply button (unit-tested headless). */
export function applyComponentJson(
  target: Record<string, any>,
  json: string,
): { ok: boolean; error?: string } {
  let parsed: any;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "component JSON must be a plain object" };
  }
  Object.assign(target, parsed);
  return { ok: true };
}

/** Entity-list label: id + Named.name (or Sprite.kind) + hp. Pure. */
export function entityLabel(id: Entity, comps: Record<string, any>): string {
  const name = comps.Named?.name ?? comps.Sprite?.kind ?? "";
  const h = comps.Health;
  const hp = h ? ` ${Math.max(0, Math.round(h.hp))}/${h.maxHp}hp` : "";
  return `#${id}${name ? ` ${name}` : ""}${hp}`;
}

// ---- theme ----
const BG = "#0d0b12";
const PANEL = "#14101c";
const BORDER = "#2a2338";
const FG = "#c9c4d6";
const DIM = "#79718f";
const ACCENT = "#62d9c4";
const ERR = "#ff7b8a";
const FONT = "12px ui-monospace, Menlo, Consolas, monospace";

export function attachInspector(opts: InspectorOptions): InspectorHandle {
  if (typeof document === "undefined") {
    throw new Error("attachInspector needs a DOM (browser only) — document is undefined");
  }
  const { world, actions, loop } = opts;
  const hotkey = opts.hotkey ?? "F2";

  // ---- tiny DOM helpers ----
  const el = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    css: string,
    text?: string,
  ): HTMLElementTagNameMap[K] => {
    const n = document.createElement(tag);
    n.style.cssText = css;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const btn = (label: string, onClick: () => void): HTMLButtonElement => {
    const b = el(
      "button",
      `font:${FONT};background:${PANEL};color:${ACCENT};border:1px solid ${BORDER};` +
        "border-radius:3px;padding:2px 8px;cursor:pointer;margin:0 4px 4px 0",
      label,
    );
    b.onclick = () => {
      try {
        onClick();
      } catch (e) {
        b.textContent = `${label} !`;
        console.warn("[inspector]", e);
      }
    };
    return b;
  };
  const section = (title: string): HTMLDivElement => {
    const s = el("div", `border-top:1px solid ${BORDER};padding:6px 8px`);
    s.appendChild(el("div", `color:${DIM};margin-bottom:4px;letter-spacing:1px`, title));
    root.appendChild(s);
    return s;
  };

  // ---- root overlay ----
  const root = el(
    "div",
    `position:fixed;top:0;right:0;width:380px;max-width:45vw;height:100vh;overflow-y:auto;` +
      `z-index:99999;background:${BG};color:${FG};font:${FONT};border-left:1px solid ${BORDER};` +
      "display:none;box-sizing:border-box",
  );
  const header = el("div", `padding:6px 8px;color:${ACCENT};display:flex;justify-content:space-between`);
  header.appendChild(el("span", "", `llmgine inspector [${hotkey}]`));
  const closeX = el("span", "cursor:pointer", "×");
  closeX.onclick = () => setOpen(false);
  header.appendChild(closeX);
  root.appendChild(header);

  // ---- 1. world bar ----
  const worldBar = section("WORLD");
  const stats = el("div", "margin-bottom:4px;white-space:pre");
  worldBar.appendChild(stats);
  const pauseBtn = btn("pause", () => {
    loop.paused = !loop.paused;
  });
  worldBar.appendChild(pauseBtn);
  worldBar.appendChild(btn("step 1", () => {
    loop.paused = true;
    loop.advance(1);
  }));
  worldBar.appendChild(btn("step 60", () => {
    loop.paused = true;
    loop.advance(60);
  }));
  const copyBtn = btn("copy save JSON", () => {
    const json = JSON.stringify(world.save());
    const done = (ok: boolean) => {
      copyBtn.textContent = ok ? "copied ✓" : "copy failed";
      setTimeout(() => (copyBtn.textContent = "copy save JSON"), 1200);
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(json).then(() => done(true), () => done(false));
    } else {
      const t = document.createElement("textarea");
      t.value = json;
      document.body.appendChild(t);
      t.select();
      done(document.execCommand("copy"));
      t.remove();
    }
  });
  worldBar.appendChild(copyBtn);

  // ---- 2. entity list ----
  const listBox = section("ENTITIES  (click to select · alt+click canvas)");
  const list = el("div", "max-height:180px;overflow-y:auto");
  listBox.appendChild(list);

  // ---- 3. selected entity ----
  const selBox = section("SELECTED");
  const selHead = el("div", "margin-bottom:4px");
  selBox.appendChild(selHead);
  const selBody = el("div", "");
  selBox.appendChild(selBody);

  // ---- 4. verb console ----
  const verbBox = section("VERBS  (executes as selected entity)");
  const verbSel = el("select", `font:${FONT};background:${PANEL};color:${FG};border:1px solid ${BORDER};width:100%;margin-bottom:4px`);
  const paramsTa = el(
    "textarea",
    `font:${FONT};background:${PANEL};color:${FG};border:1px solid ${BORDER};width:100%;height:48px;box-sizing:border-box`,
  );
  paramsTa.value = "{}";
  paramsTa.spellcheck = false;
  const verbOut = el("div", "white-space:pre-wrap;margin:4px 0");
  const recentBox = el("div", `color:${DIM};white-space:pre-wrap`);
  verbBox.appendChild(verbSel);
  verbBox.appendChild(paramsTa);
  verbBox.appendChild(btn("execute", () => {
    let params: any;
    try {
      params = JSON.parse(paramsTa.value || "{}");
    } catch (e) {
      verbOut.textContent = `params: ${e instanceof Error ? e.message : e}`;
      verbOut.style.color = ERR;
      return;
    }
    const res = actions.execute(world, { actor: selected, verb: verbSel.value, params });
    verbOut.textContent = res.ok ? "ok" : `error: ${res.error}`;
    verbOut.style.color = res.ok ? ACCENT : ERR;
  }));
  verbBox.appendChild(verbOut);
  verbBox.appendChild(el("div", `color:${DIM};margin:4px 0 2px`, "recent attempts"));
  verbBox.appendChild(recentBox);

  // ---- state ----
  let open = false;
  let selected: Entity = 0;
  let rafId = 0;
  let lastDom = 0;
  let lastFrame = 0;
  let frameDelta = 0;
  let disposed = false;
  document.body.appendChild(root);

  const refreshVerbOptions = () => {
    const defs = actions.list();
    if (defs.length === verbSel.options.length) return;
    verbSel.innerHTML = "";
    for (const d of defs) {
      const o = document.createElement("option");
      o.value = d.name;
      o.textContent = `${d.name} — ${d.description}`.slice(0, 60);
      verbSel.appendChild(o);
    }
  };

  const renderWorldBar = () => {
    stats.textContent =
      `tick ${world.tick}   t ${world.time.toFixed(2)}s   entities ${world.entityCount()}\n` +
      `frame ${frameDelta.toFixed(1)}ms   ${loop.paused ? "PAUSED" : "running"}`;
    pauseBtn.textContent = loop.paused ? "resume" : "pause";
  };

  const renderList = () => {
    list.innerHTML = "";
    for (const id of world.entities()) {
      const row = el(
        "div",
        `cursor:pointer;padding:1px 4px;${id === selected ? `color:${BG};background:${ACCENT}` : ""}`,
        entityLabel(id, world.componentsOf(id)),
      );
      row.onclick = () => select(id);
      list.appendChild(row);
    }
  };

  const renderRecent = () => {
    recentBox.textContent = actions.recent
      .slice(-8)
      .map((r) => `${r.ok ? "✓" : "✗"} #${r.actor} ${r.verb}${r.error ? ` — ${r.error}` : ""}`)
      .join("\n") || "(none)";
  };

  /** Rebuild the selected-entity panel (textareas are only rebuilt here —
   * never inside the 5Hz loop, so in-progress edits survive). */
  const renderSelected = () => {
    selBody.innerHTML = "";
    selHead.textContent = selected ? `entity #${selected}` : "nothing selected";
    if (!selected || !world.isAlive(selected)) return;
    selHead.textContent = entityLabel(selected, world.componentsOf(selected));
    const refresh = btn("refresh", renderSelected);
    const destroy = btn("destroy entity", () => {
      world.destroy(selected);
      select(0);
    });
    destroy.style.color = ERR;
    selBody.appendChild(refresh);
    selBody.appendChild(destroy);
    const comps = world.componentsOf(selected);
    for (const [name, comp] of Object.entries(comps)) {
      const det = el("details", "margin:2px 0") as HTMLDetailsElement;
      const sum = el("summary", `cursor:pointer;color:${ACCENT}`, name);
      det.appendChild(sum);
      const ta = el(
        "textarea",
        `font:${FONT};background:${PANEL};color:${FG};border:1px solid ${BORDER};width:100%;height:80px;box-sizing:border-box`,
      );
      ta.value = JSON.stringify(comp, null, 2);
      ta.spellcheck = false;
      const errLine = el("div", `color:${ERR};white-space:pre-wrap`);
      det.appendChild(ta);
      det.appendChild(btn("apply", () => {
        // re-read the LIVE ref at apply time — the sim may have replaced it
        const live = world.componentsOf(selected)[name];
        if (!live) {
          errLine.textContent = "component no longer on entity";
          return;
        }
        const res = applyComponentJson(live, ta.value);
        errLine.textContent = res.ok ? "" : res.error ?? "";
        if (res.ok) ta.value = JSON.stringify(live, null, 2);
      }));
      det.appendChild(errLine);
      selBody.appendChild(det);
    }
  };

  const select = (id: Entity) => {
    selected = id;
    renderSelected();
    renderList();
  };

  // ---- refresh loop: rAF while open, DOM throttled to ~5Hz ----
  const raf = typeof requestAnimationFrame !== "undefined" ? requestAnimationFrame.bind(globalThis) : null;
  const caf = typeof cancelAnimationFrame !== "undefined" ? cancelAnimationFrame.bind(globalThis) : null;
  const tick = (now: number) => {
    if (!open || disposed) return;
    frameDelta = lastFrame ? now - lastFrame : 0;
    lastFrame = now;
    if (now - lastDom > 200) {
      lastDom = now;
      try {
        renderWorldBar();
        renderList();
        renderRecent();
        refreshVerbOptions();
        if (selected && !world.isAlive(selected)) select(0);
      } catch (e) {
        console.warn("[inspector]", e);
      }
    }
    rafId = raf ? raf(tick) : 0;
  };

  const setOpen = (v: boolean) => {
    if (disposed || open === v) return;
    open = v;
    root.style.display = v ? "block" : "none";
    if (v) {
      lastFrame = 0;
      lastDom = 0;
      refreshVerbOptions();
      renderSelected();
      if (raf) rafId = raf(tick);
    } else if (caf && rafId) {
      caf(rafId);
    }
  };

  // ---- global listeners: hotkey + alt+click picking ----
  const onKey = (e: KeyboardEvent) => {
    if (e.key.toLowerCase() === hotkey.toLowerCase()) {
      e.preventDefault();
      setOpen(!open);
    }
  };
  const onClick = (e: MouseEvent) => {
    if (!open || !e.altKey || !opts.renderer?.entityAt) return;
    try {
      const t = e.target;
      if (!(t instanceof HTMLCanvasElement)) return;
      const r = t.getBoundingClientRect();
      const id = opts.renderer.entityAt(e.clientX - r.left, e.clientY - r.top);
      if (id && world.isAlive(id)) select(id);
    } catch (err) {
      console.warn("[inspector]", err);
    }
  };
  window.addEventListener("keydown", onKey);
  window.addEventListener("click", onClick, true);

  return {
    open: () => setOpen(true),
    dispose: () => {
      setOpen(false);
      disposed = true;
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("click", onClick, true);
      root.remove();
    },
  };
}

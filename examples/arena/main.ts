/**
 * THE NEURAL COLOSSEUM — llmgine demo game (3D).
 * One boss with a real LLM Mind (GLM flash), goblin adds, loot, quests,
 * Kokoro neural voice. With no API key the same arena runs on deterministic
 * instinct — that's the engine guarantee, not a downgrade switch.
 */
import {
  World, GameLoop, SpatialGrid, ActionRegistry, actionSystem,
  Transform, Velocity, Collider, Sprite, Named, Health, Faction, Attack,
  Inventory, LootDrop, Pickup, PlayerControlled, Speech, Behavior,
  STANDARD_VERBS, movementSystem, collisionSystem, speechSystem,
  behaviorSystem, aggroSystem, combatSystem, dealDamage,
  LootTables, lootSystem, QuestLog, offerQuest, questSystem,
  Mind, MindMemory, CognitionDriver, OpenAICompatibleProvider, InferenceBudget,
  Voice, WebSpeechVoice, voiceSystem,
} from "../../src/index.js";
import type { Entity, System, VoiceService } from "../../src/index.js";
import { ThreeRenderer } from "../../src/render3d/three.js";
import { registerModels } from "./models3d.js";
import { buildColosseum } from "./environment.js";
import { KokoroVoice } from "./kokoro-voice.js";

// ── world setup ─────────────────────────────────────────────────
const ARENA_R = 380;
const world = new World(20260710);
const grid = new SpatialGrid();
const actions = new ActionRegistry();
for (const v of STANDARD_VERBS) actions.register(v);

// player melee strike: swing at the nearest enemy in reach
actions.register({
  name: "strike",
  description: "Swing your blade at the nearest enemy in reach.",
  params: {},
  validate: (w, a) => {
    const atk = w.get(a.actor, Attack);
    if (!atk) return "you cannot attack";
    if (atk.ready > 0) return "not ready";
    return null;
  },
  resolve: (w, a) => {
    const atk = w.require(a.actor, Attack);
    const t = w.require(a.actor, Transform);
    const f = w.get(a.actor, Faction);
    let best: Entity | 0 = 0;
    let bestD = atk.range * 1.5;
    for (const [e, of] of w.each(Faction)) {
      if (e === a.actor || !f?.hostileTo.includes(of.id)) continue;
      const ot = w.get(e, Transform);
      const oh = w.get(e, Health);
      if (!ot || !oh || oh.hp <= 0) continue;
      const d = Math.hypot(ot.x - t.x, ot.y - t.y);
      if (d < bestD) { bestD = d; best = e; }
    }
    atk.ready = atk.cooldown;
    w.events.emit("combat:swing", { entity: a.actor, target: best });
    if (best) dealDamage(w, a.actor, best, atk.damage);
  },
});

// ── loot ────────────────────────────────────────────────────────
const loot = new LootTables()
  .define({
    name: "goblin-drops",
    rolls: [1, 2],
    chance: 0.9,
    items: [
      { id: "gold", name: "Gold", weight: 6, qty: [2, 6], color: "#d4a24e" },
      { id: "potion", name: "Potion", weight: 2, color: "#e35d6d" },
    ],
  })
  .define({
    name: "boss-drops",
    rolls: [3, 4],
    items: [
      { id: "crown", name: "Crown of the Master", weight: 1, color: "#d4a24e", stats: { power: 20 } },
      { id: "gold", name: "Gold", weight: 3, qty: [20, 40], color: "#d4a24e" },
      { id: "sigil", name: "Neural Sigil", weight: 2, color: "#62d9c4" },
    ],
  });

// ── entities ────────────────────────────────────────────────────
function makeHero(): Entity {
  const e = world.create();
  world.add(e, Transform, { x: 0, y: 240 });
  world.add(e, Velocity, { maxSpeed: 170 });
  world.add(e, Collider, { radius: 12 });
  world.add(e, Sprite, { kind: "gladiator", color: "#62d9c4", size: 24, layer: 1 });
  world.add(e, Named, { name: "Challenger", blurb: "a lone challenger who entered the pit" });
  world.add(e, Health, { hp: 140, maxHp: 140 });
  world.add(e, Faction, { id: "challenger", hostileTo: ["arena"] });
  world.add(e, Attack, { damage: 16, range: 46, cooldown: 0.38 });
  world.add(e, Inventory);
  world.add(e, PlayerControlled);
  world.add(e, Behavior, { mode: "idle" });
  world.add(e, Speech);
  world.add(e, QuestLog);
  return e;
}

function makeBoss(): Entity {
  const e = world.create();
  world.add(e, Transform, { x: 0, y: -180 });
  world.add(e, Velocity, { maxSpeed: 95 });
  world.add(e, Collider, { radius: 24 });
  world.add(e, Sprite, { kind: "arenamaster", color: "#c23b4e", size: 52, layer: 1 });
  world.add(e, Named, { name: "The Arena Master", blurb: "an ancient intelligence that rules the pit" });
  world.add(e, Health, { hp: 420, maxHp: 420 });
  world.add(e, Faction, { id: "arena", hostileTo: ["challenger"] });
  world.add(e, Attack, { damage: 18, range: 64, cooldown: 1.1 });
  world.add(e, Behavior, { mode: "idle", sightRange: 900, homeX: 0, homeY: -180 });
  world.add(e, Speech);
  world.add(e, LootDrop, { table: "boss-drops" });
  world.add(e, Voice, { voiceId: "bm_george", rate: 0.9, pitch: 0.6 });
  world.add(e, Mind, {
    persona:
      "The Arena Master — an ancient, theatrical intelligence that rules this colosseum. Cruel wit, never panic. You taunt the challenger, command the pit, and fight with tactics: press the attack when strong, reposition (move_to) or flee briefly when badly hurt, and always announce your cruelty.",
    goals: ["break the challenger's spirit with taunts", "defeat the challenger", "survive"],
    tier: "fast",
    thinkEvery: 9,
    wakeOn: ["combat:damaged", "speech"],
    verbs: ["say", "attack", "move_to", "emote", "flee"],
    sightRange: 900,
    fallbackMode: "attack",
  });
  world.add(e, MindMemory);
  return e;
}

function makeGoblin(x: number, y: number): Entity {
  const e = world.create();
  world.add(e, Transform, { x, y });
  world.add(e, Velocity, { maxSpeed: 110 });
  world.add(e, Collider, { radius: 9 });
  world.add(e, Sprite, { kind: "goblin", color: "#7aa35a", size: 18, layer: 1 });
  world.add(e, Named, { name: "Pit Goblin" });
  world.add(e, Health, { hp: 34, maxHp: 34 });
  world.add(e, Faction, { id: "arena", hostileTo: ["challenger"] });
  world.add(e, Attack, { damage: 6, range: 30, cooldown: 0.9 });
  world.add(e, Behavior, { mode: "wander", sightRange: 260, homeX: x, homeY: y, leash: 0 });
  world.add(e, LootDrop, { table: "goblin-drops" });
  return e;
}

const hero = makeHero();
const boss = makeBoss();
for (let i = 0; i < 3; i++) {
  const a = (i / 3) * Math.PI * 2 + 0.6;
  makeGoblin(Math.cos(a) * 260, Math.sin(a) * 260);
}

offerQuest(world, hero, {
  id: "silence",
  name: "The Rites",
  objectives: [
    { kind: "kill", match: "Pit Goblin", count: 3, label: "Cull the pack (3)" },
    { kind: "kill", match: "The Arena Master", count: 1, label: "Silence the Arena Master" },
  ],
  rewards: { items: [{ id: "laurel", name: "Bloodstained Laurel", qty: 1 }] },
});

// ── LLM mind wiring (dev key auto-detect → localStorage → none) ─
const KEY_STORE = "llmgine.zai.key";
let apiKey = localStorage.getItem(KEY_STORE) ?? "";
let keySource = apiKey ? "saved" : "";
if (!apiKey && ["localhost", "127.0.0.1"].includes(location.hostname)) {
  try {
    const r = await fetch("/dev/key");
    if (r.ok) {
      const j = await r.json();
      if (j.key) { apiKey = j.key; keySource = "dev"; }
    }
  } catch { /* no dev server key endpoint — fine */ }
}

const ribbon = document.getElementById("ribbon")!;
const ribbonText = document.getElementById("ribbon-text")!;
let typeTimer: number | undefined;
function typeRibbon(text: string) {
  ribbon.classList.remove("thinking");
  clearInterval(typeTimer);
  let i = 0;
  ribbonText.textContent = "";
  typeTimer = window.setInterval(() => {
    ribbonText.textContent = text.slice(0, ++i);
    if (i >= text.length) clearInterval(typeTimer);
  }, 24);
}

let driver: CognitionDriver | null = null;
const badge = document.getElementById("mind-badge")!;
if (apiKey) {
  const provider = new OpenAICompatibleProvider({ apiKey });
  driver = new CognitionDriver({
    provider,
    actions,
    grid,
    budget: new InferenceBudget({ requestsPerMinute: 12, maxConcurrent: 2 }),
    worldRules:
      "This is a gladiatorial arena duel. Entity ids in parentheses (#N) are valid tool targets.",
    onThought: (t) => {
      if (t.error) typeRibbon("…the mind flickers (API error); instinct takes over.");
    },
  });
  world.addSystem(driver.system());
  badge.textContent = keySource === "dev" ? "MIND: GLM LIVE · DEV KEY" : "MIND: GLM LIVE";
  badge.classList.add("live");
} else {
  typeRibbon("No mind bound. The Master fights on instinct — paste a GLM key to wake him.");
}

world.events.on("speech", (p: any) => {
  if (p.entity === boss) typeRibbon(`“${p.text}”`);
});

// ── voice: Kokoro neural TTS (local), Web Speech as plan C ─────
const btnVoice = document.getElementById("btn-voice")! as HTMLButtonElement;
let voiceOn = false;
const kokoro = new KokoroVoice("bm_george", (s) => {
  if (s === "loading") btnVoice.textContent = "VOICE: LOADING…";
  if (s === "ready") btnVoice.textContent = "VOICE: KOKORO";
  if (s === "error") btnVoice.textContent = "VOICE: BASIC";
});
const webVoice = new WebSpeechVoice();
const voiceRouter: VoiceService = {
  speak: (text, opts) => {
    if (!voiceOn) return;
    if (kokoro.state === "ready") kokoro.speak(text, opts);
    else if (kokoro.state === "error") webVoice.speak(text, opts);
  },
};
btnVoice.onclick = () => {
  voiceOn = !voiceOn;
  if (!voiceOn) { btnVoice.textContent = "VOICE: OFF"; return; }
  if (kokoro.state === "idle") kokoro.load().then(() => kokoro.speak("The arena listens.")).catch(() => webVoice.speak("The arena listens."));
  else btnVoice.textContent = kokoro.state === "ready" ? "VOICE: KOKORO" : "VOICE: BASIC";
};

// ── input + custom systems ──────────────────────────────────────
const keys = new Set<string>();
addEventListener("keydown", (e) => {
  keys.add(e.key.toLowerCase());
  if (e.key === " ") { e.preventDefault(); playerStrike(); }
});
addEventListener("keyup", (e) => keys.delete(e.key.toLowerCase()));
addEventListener("pointerdown", (e) => {
  if ((e.target as HTMLElement).tagName === "CANVAS") playerStrike();
});

function playerStrike() {
  if (world.isAlive(hero)) actions.execute(world, { actor: hero, verb: "strike", params: {} });
}

function playerInputSystem(): System {
  return {
    name: "player-input",
    order: -30,
    update({ world }) {
      if (!world.isAlive(hero)) return;
      const v = world.get(hero, Velocity);
      if (!v) return;
      let x = 0, y = 0;
      if (keys.has("w") || keys.has("arrowup")) y -= 1;
      if (keys.has("s") || keys.has("arrowdown")) y += 1;
      if (keys.has("a") || keys.has("arrowleft")) x -= 1;
      if (keys.has("d") || keys.has("arrowright")) x += 1;
      const m = Math.hypot(x, y) || 1;
      v.vx = (x / m) * v.maxSpeed;
      v.vy = (y / m) * v.maxSpeed;
    },
  };
}

function pitBoundsSystem(): System {
  return {
    name: "pit-bounds",
    order: 15,
    update({ world }) {
      for (const [, t] of world.each(Transform)) {
        const d = Math.hypot(t.x, t.y);
        if (d > ARENA_R) { t.x *= ARENA_R / d; t.y *= ARENA_R / d; }
      }
    },
  };
}

function autoPickupSystem(): System {
  return {
    name: "auto-pickup",
    order: 35,
    update({ world }) {
      if (!world.isAlive(hero)) return;
      const ht = world.require(hero, Transform);
      for (const e of world.query(Pickup, Transform)) {
        const t = world.require(e, Transform);
        if (Math.hypot(t.x - ht.x, t.y - ht.y) < 30) {
          actions.execute(world, { actor: hero, verb: "pickup", params: { target: e } });
        }
      }
    },
  };
}

let spawnClock = 10;
function spawnerSystem(): System {
  return {
    name: "spawner",
    order: 45,
    update({ world, dt }) {
      if (!world.isAlive(boss) || !world.isAlive(hero)) return;
      spawnClock -= dt;
      const goblins = [...world.query(Behavior)].filter(
        (e) => world.get(e, Named)?.name === "Pit Goblin",
      ).length;
      if (spawnClock <= 0 && goblins < 3) {
        spawnClock = 14;
        const a = world.rng.next() * Math.PI * 2;
        makeGoblin(Math.cos(a) * (ARENA_R - 30), Math.sin(a) * (ARENA_R - 30));
      }
    },
  };
}

world.events.on("item:pickup", (p: any) => {
  if (p.item?.id === "potion" && p.entity === hero) {
    const h = world.get(hero, Health);
    if (h) h.hp = Math.min(h.maxHp, h.hp + 30);
  }
});

world
  .addSystem(actionSystem(actions))
  .addSystem(playerInputSystem())
  .addSystem(aggroSystem())
  .addSystem(behaviorSystem())
  .addSystem(movementSystem(grid))
  .addSystem(collisionSystem(grid))
  .addSystem(pitBoundsSystem())
  .addSystem(combatSystem())
  .addSystem(lootSystem(loot))
  .addSystem(autoPickupSystem())
  .addSystem(spawnerSystem())
  .addSystem(questSystem())
  .addSystem(speechSystem())
  .addSystem(voiceSystem(voiceRouter));

// ── 3D renderer + colosseum ─────────────────────────────────────
const stage = document.getElementById("stage")!;
const renderer = new ThreeRenderer(stage, {
  clearColor: 0x0d0a12,
  fog: { color: 0x0d0a12, near: 1100, far: 2400 },
  cameraDistance: 470,
  cameraHeight: 420,
});
registerModels(renderer);
const animateEnv = buildColosseum(renderer, ARENA_R);
renderer.followTarget = hero;
renderer.onFrame = animateEnv;
addEventListener("resize", () => renderer.resize(innerWidth, innerHeight));
renderer.resize(innerWidth, innerHeight);

// hit/death flashes: transient point lights
const flashes: Array<{ light: any; t: number; max: number }> = [];
function flashAt(x: number, y: number, color: number, intensity: number, life = 0.4) {
  const L = new renderer.three.PointLight(color, intensity, 160, 2);
  L.position.set(x, 26, y);
  renderer.scene.add(L);
  flashes.push({ light: L, t: 0, max: life });
}

world.events.on("combat:damaged", (p: any) => {
  const t = world.get(p.target, Transform);
  if (t) {
    flashAt(t.x, t.y, p.target === hero ? 0xc23b4e : 0xffe0a0, 30000, 0.25);
    spawnDmgNum(t.x, t.y, `${p.amount}`, p.target === hero ? "#ff6d7d" : "#e8dcc8");
  }
  if (p.target === hero) renderer.shake = Math.min(10, renderer.shake + 5);
});
world.events.on("combat:death", (p: any) => {
  if (p.x !== undefined) flashAt(p.x, p.y, p.entity === boss ? 0xd4a24e : 0x7aa35a, 90000, 0.8);
  if (p.entity === boss) { renderer.shake = 14; showBanner("THE MASTER FALLS", "collect your spoils"); }
  if (p.entity === hero) showBanner("THE ARENA CLAIMS YOU", "refresh to fight again");
});
world.events.on("loot:dropped", (p: any) => flashAt(p.x, p.y, 0xd4a24e, 20000, 0.5));
world.events.on("quest:completed", (p: any) => showBanner("RITES COMPLETE", p.name));

function showBanner(big: string, small: string) {
  const el = document.getElementById("banner")!;
  el.innerHTML = `${big}<small>${small.toUpperCase()}</small>`;
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 4200);
}

// ── HTML overlays: speech bubbles, hp bars, damage numbers ─────
const overlays = document.getElementById("overlays")!;
const bubbles = new Map<number, HTMLDivElement>();
function spawnDmgNum(x: number, y: number, text: string, color: string) {
  const el = document.createElement("div");
  el.className = "dmgnum";
  el.style.color = color;
  el.textContent = text;
  const p = renderer.project(x, y, 40);
  el.style.left = `${p.sx}px`;
  el.style.top = `${p.sy}px`;
  overlays.appendChild(el);
  setTimeout(() => el.remove(), 900);
}
const hpbars = new Map<number, HTMLDivElement>();

function syncOverlays() {
  // speech bubbles
  for (const [e, sp] of world.each(Speech)) {
    let el = bubbles.get(e);
    if (sp.text && sp.ttl > 0) {
      if (!el) {
        el = document.createElement("div");
        el.className = "bubble";
        overlays.appendChild(el);
        bubbles.set(e, el);
      }
      const name = world.get(e, Named)?.name ?? "";
      el.innerHTML = `<span class="who">${name.toUpperCase()}</span>${sp.text}`;
      const t = world.get(e, Transform);
      if (t) {
        const height = e === boss ? 78 : 44;
        const p = renderer.project(t.x, t.y, height);
        el.style.left = `${p.sx}px`;
        el.style.top = `${p.sy}px`;
        el.style.display = p.visible ? "" : "none";
      }
    } else if (el) {
      el.remove();
      bubbles.delete(e);
    }
  }
  for (const [e, el] of bubbles) {
    if (!world.isAlive(e)) { el.remove(); bubbles.delete(e); }
  }
  // hp bars over damaged non-player entities
  for (const [e, h] of world.each(Health)) {
    let el = hpbars.get(e);
    const show = world.isAlive(e) && h.hp < h.maxHp && h.hp > 0 && e !== boss;
    if (show) {
      if (!el) {
        el = document.createElement("div");
        el.className = "hpbar";
        el.innerHTML = "<i></i>";
        overlays.appendChild(el);
        hpbars.set(e, el);
      }
      const t = world.get(e, Transform);
      if (t) {
        const p = renderer.project(t.x, t.y, e === hero ? 46 : 30);
        el.style.left = `${p.sx}px`;
        el.style.top = `${p.sy}px`;
        const bar = el.firstElementChild as HTMLElement;
        bar.style.width = `${(h.hp / h.maxHp) * 100}%`;
        bar.className = h.hp / h.maxHp < 0.35 ? "low" : "";
      }
    } else if (el) {
      el.remove();
      hpbars.delete(e);
    }
  }
}

// ── HUD sync ────────────────────────────────────────────────────
const bossFill = document.querySelector("#boss-hp .fill") as HTMLElement;
const heroFill = document.getElementById("player-hp") as HTMLElement;
const questList = document.getElementById("quest-list")!;
const satchelList = document.getElementById("satchel-list")!;
let lastVfx = performance.now();

function renderFrame(alpha: number) {
  const now = performance.now();
  const dt = Math.min((now - lastVfx) / 1000, 0.1);
  lastVfx = now;

  for (let i = flashes.length - 1; i >= 0; i--) {
    const f = flashes[i];
    f.t += dt;
    f.light.intensity *= Math.max(0, 1 - f.t / f.max);
    if (f.t >= f.max) {
      renderer.scene.remove(f.light);
      flashes.splice(i, 1);
    }
  }
  renderer.shake = Math.max(0, renderer.shake - dt * 22);

  renderer.draw(world, alpha);
  syncOverlays();

  const bh = world.get(boss, Health);
  bossFill.style.transform = `scaleX(${bh ? bh.hp / bh.maxHp : 0})`;
  const hh = world.get(hero, Health);
  heroFill.style.transform = `scaleX(${hh ? hh.hp / hh.maxHp : 0})`;
  ribbon.classList.toggle(
    "thinking",
    !!(driver && (world.get(boss, Mind)?.thinking ?? false)) && !ribbonText.textContent,
  );

  const log = world.get(hero, QuestLog);
  if (log) {
    questList.innerHTML = log.active
      .flatMap((q) =>
        q.quest.objectives.map((o, i) => {
          const done = q.progress[i] >= o.count;
          return `<div class="obj ${done ? "done" : ""}">${done ? "✓" : "·"} ${o.label} ${o.count > 1 ? `(${Math.min(q.progress[i], o.count)}/${o.count})` : ""}</div>`;
        }),
      )
      .join("");
  }
  const inv = world.get(hero, Inventory);
  if (inv) satchelList.innerHTML = inv.items.map((i) => `<div>${i.name} ×${i.qty}</div>`).join("");
}

// ── key modal ───────────────────────────────────────────────────
const modal = document.getElementById("keymodal")!;
document.getElementById("btn-key")!.onclick = () => modal.classList.add("open");
document.getElementById("key-close")!.onclick = () => modal.classList.remove("open");
document.getElementById("key-save")!.onclick = () => {
  const v = (document.getElementById("key-input") as HTMLInputElement).value.trim();
  if (v) { localStorage.setItem(KEY_STORE, v); location.reload(); }
};
document.getElementById("key-clear")!.onclick = () => { localStorage.removeItem(KEY_STORE); location.reload(); };

// ── run ─────────────────────────────────────────────────────────
const loop = new GameLoop(world, { render: renderFrame });
loop.start();

// dev handle for debugging (harmless in production)
(globalThis as any).__game = { world, renderer, actions, hero, boss, driver };

/**
 * THE NEURAL COLOSSEUM — llmgine demo game (3D).
 * One boss with a real LLM Mind (GLM flash), goblin adds, loot, quests,
 * Kokoro neural voice. With no API key the same arena runs on deterministic
 * instinct — same verbs, scripted director — that's the engine guarantee,
 * not a downgrade switch.
 */
import {
  World, GameLoop, SpatialGrid, ActionRegistry, actionSystem,
  Transform, Velocity, Collider, Sprite, Named, Health, Faction, Attack,
  Inventory, LootDrop, Pickup, PlayerControlled, Speech, Behavior,
  STANDARD_VERBS, movementSystem, collisionSystem, speechSystem,
  behaviorSystem, aggroSystem, combatSystem, dealDamage,
  LootTables, lootSystem, QuestLog, offerQuest, questSystem,
  Mind, MindMemory, CognitionDriver, OpenAICompatibleProvider, InferenceBudget,
  Voice, WebSpeechVoice, voiceSystem, TouchControls, WebAudioService, audioSystem,
  NavGrid, Ranged, shootVerb, Projectile, projectileSystem, GamepadInput,
  SaveStore, LocalStorageAdapter, ALL_COMPONENTS, Genesis, PrefabRegistry,
  AgentPort, exposeAgentPort, connectAgentBridge, TopDownControls,
} from "../../src/index.js";
import type { Entity, System, VoiceService } from "../../src/index.js";
import { ThreeRenderer } from "../../src/render3d/three.js";
import { registerModels } from "./models3d.js";
import { buildColosseum } from "./environment.js";
import { KokoroVoice } from "./kokoro-voice.js";

// ── world setup ─────────────────────────────────────────────────
const ARENA_R = 380;
const SPAWN_R = 240; // goblins spawn inside the camera's view, not at the rim
const world = new World(20260710);
const grid = new SpatialGrid();
const nav = new NavGrid(32);
const actions = new ActionRegistry();
for (const v of STANDARD_VERBS) actions.register(v);
actions.register(shootVerb);

// four stone pillars — cover from the boss's fire, routed around via NavGrid
const PILLARS: Array<[number, number]> = [
  [-190, -60], [190, -60], [-150, 170], [150, 170],
];
for (const [px, py] of PILLARS) {
  const e = world.create();
  world.add(e, Transform, { x: px, y: py });
  world.add(e, Collider, { radius: 22, solid: true });
  world.add(e, Sprite, { kind: "pillar", color: "#3a2f4a", size: 44, layer: 0 });
  nav.blockCircle(px, py, 26);
}

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
      if ((ot.z ?? 0) > 14) continue; // airborne targets dodge the swing
      const d = Math.hypot(ot.x - t.x, ot.y - t.y);
      if (d < bestD) { bestD = d; best = e; }
    }
    atk.ready = atk.cooldown;
    if (best) {
      const bt = w.require(best, Transform);
      t.rot = Math.atan2(bt.y - t.y, bt.x - t.x); // face what you strike
    }
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
  world.add(e, Health, { hp: 200, maxHp: 200 });
  world.add(e, Faction, { id: "challenger", hostileTo: ["arena"] });
  world.add(e, Attack, { damage: 18, range: 60, cooldown: 0.38 });
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
  world.add(e, Velocity, { maxSpeed: 80 });
  world.add(e, Collider, { radius: 24 });
  world.add(e, Sprite, { kind: "arenamaster", color: "#c23b4e", size: 52, layer: 1 });
  world.add(e, Named, { name: "The Arena Master", blurb: "an ancient intelligence that rules the pit" });
  world.add(e, Health, { hp: 420, maxHp: 420 });
  world.add(e, Faction, { id: "arena", hostileTo: ["challenger"] });
  world.add(e, Attack, { damage: 16, range: 64, cooldown: 1.3 });
  // waits near the throne (aggro on approach), leashes back — cull the pack first, then duel
  world.add(e, Behavior, { mode: "idle", sightRange: 260, homeX: 0, homeY: -180, leash: 340 });
  // hellfire bolts — the Mind chooses when to shoot (its own tool call)
  world.add(e, Ranged, { damage: 12, speed: 260, range: 420, cooldown: 2.4, color: "#ff5d45" });
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
    verbs: ["say", "attack", "move_to", "emote", "flee", "shoot"],
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
  world.add(e, Health, { hp: 30, maxHp: 30 });
  world.add(e, Faction, { id: "arena", hostileTo: ["challenger"] });
  world.add(e, Attack, { damage: 4, range: 30, cooldown: 0.9 });
  world.add(e, Behavior, { mode: "wander", sightRange: 220, homeX: x, homeY: y, leash: 0 });
  world.add(e, LootDrop, { table: "goblin-drops" });
  return e;
}

const hero = makeHero();
const boss = makeBoss();
for (let i = 0; i < 3; i++) {
  const a = (i / 3) * Math.PI * 2 + 0.6;
  makeGoblin(Math.cos(a) * SPAWN_R, Math.sin(a) * SPAWN_R);
}

offerQuest(world, hero, {
  id: "silence",
  name: "The Rites",
  objectives: [
    { kind: "kill", match: "Pit Goblin", count: 3, label: "Cull the pack" },
    { kind: "kill", match: "The Arena Master", count: 1, label: "Silence the Arena Master" },
  ],
  rewards: { items: [{ id: "laurel", name: "Bloodstained Laurel", qty: 1 }] },
});

// pristine tick-0 arena — restart (R after death) loads this fresh snapshot
const freshWorld = world.save();

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
let ribbonClear: number | undefined;
function typeRibbon(text: string, holdSec = 7) {
  ribbon.classList.remove("thinking");
  clearInterval(typeTimer);
  clearTimeout(ribbonClear);
  let i = 0;
  ribbonText.textContent = "";
  typeTimer = window.setInterval(() => {
    ribbonText.textContent = text.slice(0, ++i);
    if (i >= text.length) clearInterval(typeTimer);
  }, 24);
  // clear after a hold so "the mind stirs" can appear again
  ribbonClear = window.setTimeout(() => { ribbonText.textContent = ""; }, holdSec * 1000 + text.length * 24);
}

let driver: CognitionDriver | null = null;
let mindLive = false; // true only after a REAL chat ping succeeds
let genesis: Genesis | null = null;
const prefabs = new PrefabRegistry().registerComponents([Transform, Collider, Sprite, Named, Pickup]);
const badge = document.getElementById("mind-badge")!;

async function bindMind(key: string, source: string): Promise<void> {
  badge.textContent = "MIND: WAKING…";
  badge.classList.remove("live", "dead");
  const provider = new OpenAICompatibleProvider({ apiKey: key });
  try {
    // one tiny real call — "GLM LIVE" is never asserted from key presence alone
    await provider.chat({ tier: "fast", messages: [{ role: "user", content: "ping" }], maxTokens: 16 });
  } catch {
    badge.textContent = "KEY REJECTED · INSTINCT";
    badge.classList.add("dead");
    typeRibbon("…the offered key is refused. The Master fights on instinct.");
    return;
  }
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
  const cog = driver.system();
  // game-over gate: a tab parked on the death screen must spend nothing
  world.addSystem({
    name: "cognition-gated",
    order: 60,
    update: (ctx) => { if (world.isAlive(hero)) cog.update(ctx); },
  });
  genesis = new Genesis({ provider, prefabs });
  mindLive = true;
  badge.textContent = source === "dev" ? "MIND: GLM LIVE · DEV KEY" : "MIND: GLM LIVE";
  badge.classList.add("live");
}

if (apiKey) void bindMind(apiKey, keySource);
else typeRibbon("No mind bound. The Master fights on instinct — paste a GLM key to wake him.", 10);

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
    else webVoice.speak(text, opts); // interim while Kokoro loads + plan C on error
  },
};
btnVoice.onclick = () => {
  voiceOn = !voiceOn;
  if (!voiceOn) { btnVoice.textContent = "VOICE: OFF"; return; }
  if (kokoro.state === "idle") kokoro.load().then(() => kokoro.speak("The arena listens.")).catch(() => webVoice.speak("The arena listens."));
  else btnVoice.textContent = kokoro.state === "ready" ? "VOICE: KOKORO" : "VOICE: BASIC";
};

// ── input + custom systems ──────────────────────────────────────
// quicksave/quickload — F5/F9, one slot, survives refresh
const SAVE_COMPONENTS = [...ALL_COMPONENTS, Mind, MindMemory, QuestLog, Ranged, Projectile, Voice];
const saver = new SaveStore(new LocalStorageAdapter(), SAVE_COMPONENTS);
async function quickSave() {
  if (!world.isAlive(hero)) {
    typeRibbon("…the dead cannot bind time. (R to rise again · F9 to return)");
    return;
  }
  await saver.save("quick", world, { at: "arena" });
  typeRibbon("…the arena remembers this moment. (F9 to return)");
}
async function quickLoad() {
  try {
    await saver.load("quick", world);
    resetAfterLoad();
    typeRibbon("…time folds back.");
  } catch {
    typeRibbon("…nothing to return to. (F5 saves)");
  }
}

// game-specific keys (F5/F9 save, R restart, Escape) — movement/click/strike
// live in the engine's standard TopDownControls below
addEventListener("keydown", (e) => {
  if (e.key === "Escape") { modal.classList.remove("open"); return; }
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
  const mod = e.ctrlKey || e.metaKey || e.altKey || e.shiftKey;
  if (e.key === "F5" && !mod) { e.preventDefault(); quickSave(); } // Ctrl+F5 stays browser refresh
  if (e.key === "F9" && !mod) { e.preventDefault(); quickLoad(); }
  if (e.key.toLowerCase() === "r" && !mod && !world.isAlive(hero)) restart();
});

function playerStrike() {
  if (world.isAlive(hero)) actions.execute(world, { actor: hero, verb: "strike", params: {} });
}

const touch = new TouchControls(document.body, { onAction: () => playerStrike() });
const gamepad = new GamepadInput({
  buttons: {
    0: () => controls.jump(), // A — jump
    2: () => playerStrike(), // X — strike
    7: () => playerStrike(), // RT — strike
  },
});

// Standard controls: WASD/stick direct, click ground = walk there (NavGrid
// routes around pillars), click an enemy = attack it, SPACE = jump (dodges
// swings and hellfire), F = strike.
const controls = new TopDownControls({
  world,
  actions,
  avatar: () => hero,
  screenToWorld: (x, y) => renderer.groundPoint(x, y),
  grid,
  onAction: () => playerStrike(),
  touch,
  gamepad,
});

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
        spawnClock = 22;
        const a = world.rng.next() * Math.PI * 2;
        makeGoblin(Math.cos(a) * SPAWN_R, Math.sin(a) * SPAWN_R);
      }
    },
  };
}

// hit juice: brief scale-flash + knockback nudge on every hit (reads the
// event journal like any system — the demo's presentation actuator)
const HIT_T = 0.16;
const hitFx = new Map<number, number>();
function impactSystem(): System {
  return {
    name: "impact-fx",
    order: 25, // after melee + projectile damage resolve
    update({ world, dt }) {
      for (const j of world.events.journal) {
        if (j.type !== "combat:damaged") continue;
        const target = j.payload?.target;
        const source = j.payload?.source;
        if (target === undefined) continue;
        hitFx.set(target, HIT_T);
        const tt = world.get(target, Transform);
        const st = source !== undefined ? world.get(source, Transform) : undefined;
        if (tt && st) {
          const d = Math.hypot(tt.x - st.x, tt.y - st.y) || 1;
          const k = target === boss ? 2.5 : target === hero ? 4 : 7;
          tt.x += ((tt.x - st.x) / d) * k;
          tt.y += ((tt.y - st.y) / d) * k;
        }
      }
      for (const [e, t] of hitFx) {
        const left = t - dt;
        if (left <= 0) hitFx.delete(e);
        else hitFx.set(e, left);
      }
    },
  };
}

// ── instinct director — the deterministic fallback SHOWS the engine ─
// Same verbs, same cadence as the GLM mind; a keyless visitor still gets
// taunts, hellfire phases and speech bubbles. Scripted policy, zero API.
const TAUNTS = [
  "Another challenger. The sand drinks them all — you will be no different.",
  "I have broken ten thousand before you. Your name will not be remembered.",
  "Run to the pillars, little one. Stone burns slower than flesh.",
  "The crowd smells your fear. So do I.",
  "Every step you take, I have already counted.",
  "You swing like the last one. He is under your feet now.",
  "Bleed for them. It is the only gift you have left to give.",
  "The pit is patient. I am not.",
  "Your heart drums a retreat. Listen to it.",
  "Goblins first, then me? Order your death however you like.",
  "I was ancient when this stone was quarried. You are an afternoon.",
  "Yield, and I will make it swift. Fight, and I will make it art.",
];
const DIRECTOR = { clock: 3.5, ix: 0, phase: "press" as "press" | "rain", phaseLeft: 12, engaged: false };
function bossDirectorSystem(): System {
  return {
    name: "boss-director",
    order: 58, // where cognition would sit
    update({ world, dt }) {
      if (mindLive || !world.isAlive(boss) || !world.isAlive(hero)) return;
      DIRECTOR.clock -= dt;
      if (DIRECTOR.clock <= 0) {
        DIRECTOR.clock = 9; // the cadence the GLM mind thinks at
        actions.execute(world, {
          actor: boss, verb: "say",
          params: { text: TAUNTS[DIRECTOR.ix++ % TAUNTS.length] },
        });
      }
      const bt = world.require(boss, Transform);
      const ht = world.require(hero, Transform);
      const bh = world.get(boss, Health);
      if (!DIRECTOR.engaged) {
        DIRECTOR.engaged = Math.hypot(ht.x - bt.x, ht.y - bt.y) < 320 || (!!bh && bh.hp < bh.maxHp);
        if (!DIRECTOR.engaged) return;
      }
      DIRECTOR.phaseLeft -= dt;
      if (DIRECTOR.phaseLeft <= 0) {
        if (DIRECTOR.phase === "press") {
          DIRECTOR.phase = "rain";
          DIRECTOR.phaseLeft = 7;
          // fall back toward the throne and rain hellfire — the scripted ranged phase
          actions.execute(world, { actor: boss, verb: "move_to", params: { x: bt.x * 0.3, y: -300 } });
        } else {
          DIRECTOR.phase = "press";
          DIRECTOR.phaseLeft = 12;
          actions.execute(world, { actor: boss, verb: "attack", params: { target: hero } });
        }
      }
      if (DIRECTOR.phase === "rain") {
        const r = world.get(boss, Ranged);
        if (r && r.ready <= 0) actions.execute(world, { actor: boss, verb: "shoot", params: { target: hero } });
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
  .addSystem(controls.system())
  .addSystem(aggroSystem(nav)) // line-of-sight aggro: pillars actually hide you
  .addSystem(behaviorSystem(nav))
  .addSystem(movementSystem(grid))
  .addSystem(collisionSystem(grid))
  .addSystem(pitBoundsSystem())
  .addSystem(projectileSystem(grid, nav)) // hellfire stops on pillars — cover is real
  .addSystem(combatSystem())
  .addSystem(impactSystem())
  .addSystem(lootSystem(loot))
  .addSystem(autoPickupSystem())
  .addSystem(spawnerSystem())
  .addSystem(bossDirectorSystem())
  .addSystem(questSystem())
  .addSystem(speechSystem())
  .addSystem(voiceSystem(voiceRouter));

// SFX: procedural synth, unlocked by first input (autoplay policy)
const sfx = new WebAudioService();
world.addSystem(audioSystem(sfx, () => hero));
let musicStarted = false;
for (const ev of ["pointerdown", "keydown", "touchstart"]) {
  addEventListener(ev, () => {
    sfx.unlock();
    // the service queues until the context resumes — no timing workaround,
    // and the guard stops a later keydown from restarting the bed
    if (!musicStarted) {
      musicStarted = true;
      sfx.music("ambient", 0.2);
    }
  }, { once: true });
}

// ── 3D renderer + colosseum ─────────────────────────────────────
const stage = document.getElementById("stage")!;
const renderer = new ThreeRenderer(stage, {
  clearColor: 0x0d0a12,
  fog: { color: 0x0d0a12, near: 1100, far: 2400 },
  cameraDistance: 320, // closer + lower than the launch cam — actors must read
  cameraHeight: 250,
});
registerModels(renderer);
const animateEnv = buildColosseum(renderer, ARENA_R);
renderer.followTarget = hero;
renderer.onFrame = animateEnv;
addEventListener("resize", () => renderer.resize(innerWidth, innerHeight));
renderer.resize(innerWidth, innerHeight);

// hit/death flashes — POOLED point lights. Adding/removing lights changes
// the scene's light count, and three.js recompiles EVERY shader program when
// that happens: one flash per hit = a recompile stall per hit = combat
// slideshow. A fixed pool keeps the light count constant forever.
const FLASH_POOL = 10;
const flashes: Array<{ light: any; t: number; max: number; base: number }> = [];
for (let i = 0; i < FLASH_POOL; i++) {
  const L = new renderer.three.PointLight(0xffffff, 0, 160, 2);
  L.position.set(0, -9999, 0);
  renderer.scene.add(L);
  flashes.push({ light: L, t: 1, max: 1, base: 0 });
}
let flashIx = 0;
function flashAt(x: number, y: number, color: number, intensity: number, life = 0.4) {
  const f = flashes[flashIx];
  flashIx = (flashIx + 1) % FLASH_POOL;
  f.light.color.setHex(color);
  f.light.position.set(x, 26, y);
  f.light.intensity = intensity;
  f.base = intensity;
  f.t = 0;
  f.max = life;
}

// death bursts: additive ember puffs where something falls
const bursts: Array<{ pts: any; geo: any; mat: any; vel: Float32Array; t: number; max: number }> = [];
function burstAt(x: number, y: number, color: number, n = 16) {
  const T = renderer.three;
  const pos = new Float32Array(n * 3);
  const vel = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + (i % 3) * 0.7;
    const sp = 55 + (i % 4) * 24;
    pos.set([x, 12 + (i % 3) * 7, y], i * 3);
    vel.set([Math.cos(a) * sp, 46 + (i % 5) * 20, Math.sin(a) * sp], i * 3);
  }
  const geo = new T.BufferGeometry();
  geo.setAttribute("position", new T.BufferAttribute(pos, 3));
  const mat = new T.PointsMaterial({
    color, size: 4.2, transparent: true, opacity: 0.95,
    blending: T.AdditiveBlending, depthWrite: false,
  });
  const pts = new T.Points(geo, mat);
  renderer.scene.add(pts);
  bursts.push({ pts, geo, mat, vel, t: 0, max: 0.7 });
}

const btnRestart = document.getElementById("btn-restart")! as HTMLButtonElement;
btnRestart.onclick = () => restart();

world.events.on("combat:damaged", (p: any) => {
  const t = world.get(p.target, Transform);
  if (t) {
    flashAt(t.x, t.y, p.target === hero ? 0xc23b4e : 0xffe0a0, 30000, 0.25);
    spawnDmgNum(t.x, t.y, `${p.amount}`, p.target === hero ? "#ff6d7d" : "#e8dcc8");
  }
  if (p.target === hero) renderer.shake = Math.min(10, renderer.shake + 5);
});
world.events.on("combat:death", (p: any) => {
  if (p.x !== undefined) {
    flashAt(p.x, p.y, p.entity === boss ? 0xd4a24e : 0x7aa35a, 90000, 0.8);
    burstAt(p.x, p.y, p.entity === boss ? 0xd4a24e : p.entity === hero ? 0x62d9c4 : 0x7aa35a, p.entity === boss ? 36 : 16);
  }
  if (p.entity === boss) { renderer.shake = 14; showBanner("THE MASTER FALLS", "collect your spoils"); }
  if (p.entity === hero) {
    showBanner("THE ARENA CLAIMS YOU", "R — rise again · F9 — return to your last save");
    btnRestart.style.display = "";
  }
});
world.events.on("loot:dropped", (p: any) => flashAt(p.x, p.y, 0xd4a24e, 20000, 0.5));
world.events.on("quest:completed", (p: any) => showBanner("RITES COMPLETE", p.name));

// banners queue — two same-tick banners both get their moment
const bannerQ: Array<[string, string]> = [];
let bannerBusy = false;
function showBanner(big: string, small: string) {
  bannerQ.push([big, small]);
  pumpBanner();
}
function pumpBanner() {
  if (bannerBusy || !bannerQ.length) return;
  bannerBusy = true;
  const [big, small] = bannerQ.shift()!;
  const el = document.getElementById("banner")!;
  el.innerHTML = `${big}<small>${small.toUpperCase()}</small>`;
  el.classList.add("show");
  const hold = bannerQ.length ? 2600 : 4200; // shorter when another waits
  setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => { bannerBusy = false; pumpBanner(); }, 350);
  }, hold);
}

// ── Genesis showcase: cull the pack → a relic manifests ────────
let goblinKills = 0;
let relicSpawned = false;
world.events.on("combat:death", (p: any) => {
  if (p.name === "Pit Goblin" && p.killer === hero) {
    goblinKills++;
    if (goblinKills >= 3 && !relicSpawned) { relicSpawned = true; void spawnRelic(); }
  }
});

function dropRelic(name: string, lore: string) {
  if (!world.isAlive(hero)) return;
  const e = world.create();
  world.add(e, Transform, { x: 0, y: 60 });
  world.add(e, Collider, { radius: 8, solid: false });
  world.add(e, Sprite, { kind: "pickup", color: "#b06df0", size: 14, layer: 1 });
  world.add(e, Named, { name, blurb: lore });
  world.add(e, Pickup, { item: { id: "relic", name, qty: 1 } });
  flashAt(0, 60, 0xb06df0, 44000, 0.9);
  typeRibbon(`✦ the pit yields a relic: ${name} — “${lore}”`, 10);
}

async function spawnRelic(): Promise<void> {
  const canned: [string, string] = ["Ember of the First Defeat", "It still remembers the scream of the sand."];
  if (!genesis) { dropRelic(...canned); return; } // deterministic fallback, keyless
  try {
    // Genesis authors the relic as validated prefab JSON; the sim only ever
    // sees data that passed the schema gate.
    const p = await genesis.generatePrefab(
      "a small mysterious relic pickup left in a gladiatorial arena by ten thousand fallen challengers — dark fantasy, evocative name",
      'Sprite: {"kind":"pickup"}. Pickup.item: {"id":"relic","name":<the relic name>,"qty":1}. Named: {"name":<relic name>,"blurb":<one lore sentence under 15 words>}.',
    );
    const nm = String(p.components.Named?.name ?? p.components.Pickup?.item?.name ?? p.name);
    const lore = String(p.components.Named?.blurb ?? "Its origin is not recorded.");
    dropRelic(nm, lore);
  } catch {
    dropRelic(...canned);
  }
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
const BUBBLE_MIN_TOP = 150; // keep bubbles out of the plaque/ribbon band

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
        el.style.left = `${Math.min(Math.max(p.sx, 130), innerWidth - 130)}px`;
        el.style.top = `${Math.max(p.sy, BUBBLE_MIN_TOP)}px`;
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
  // hp bars over damaged minions (hero has the vitals HUD, boss the plaque)
  for (const [e, h] of world.each(Health)) {
    let el = hpbars.get(e);
    const show = world.isAlive(e) && h.hp < h.maxHp && h.hp > 0 && e !== boss && e !== hero;
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
        const p = renderer.project(t.x, t.y, 30);
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
  // destroyed entities never hit the show/else branch above — sweep like bubbles
  for (const [e, el] of hpbars) {
    if (!world.isAlive(e)) { el.remove(); hpbars.delete(e); }
  }
}

// ── HUD sync ────────────────────────────────────────────────────
const bossFill = document.querySelector("#boss-hp .fill") as HTMLElement;
const heroFill = document.getElementById("player-hp") as HTMLElement;
const questList = document.getElementById("quest-list")!;
const satchelList = document.getElementById("satchel-list")!;
let lastVfx = performance.now();
const hitScaled = new Set<number>();
let lastDest: { x: number; y: number; t: number } | null = null;

function renderFrame(alpha: number) {
  const now = performance.now();
  const dt = Math.min((now - lastVfx) / 1000, 0.1);
  lastVfx = now;

  for (const f of flashes) {
    if (f.t >= f.max) continue;
    f.t += dt;
    const k = Math.max(0, 1 - f.t / f.max);
    f.light.intensity = f.base * k * k;
    if (f.t >= f.max) f.light.intensity = 0; // slot free (light stays in scene)
  }
  for (let i = bursts.length - 1; i >= 0; i--) {
    const b = bursts[i];
    b.t += dt;
    const pos = b.geo.attributes.position;
    for (let k = 0; k < b.vel.length / 3; k++) {
      pos.array[k * 3] += b.vel[k * 3] * dt;
      pos.array[k * 3 + 1] += b.vel[k * 3 + 1] * dt;
      pos.array[k * 3 + 2] += b.vel[k * 3 + 2] * dt;
      b.vel[k * 3 + 1] -= 190 * dt; // gravity
    }
    pos.needsUpdate = true;
    b.mat.opacity = 0.95 * Math.max(0, 1 - b.t / b.max);
    if (b.t >= b.max) {
      renderer.scene.remove(b.pts);
      b.geo.dispose();
      b.mat.dispose();
      bursts.splice(i, 1);
    }
  }
  renderer.shake = Math.max(0, renderer.shake - dt * 22);

  // click-to-move destination ping
  const dest = controls.destination;
  if (dest && dest !== lastDest) {
    lastDest = dest;
    flashAt(dest.x, dest.y, 0x62d9c4, 9000, 0.35);
  }

  renderer.draw(world, alpha);

  // hit-flash: struck models pop for a beat, then settle back
  for (const e of hitScaled) {
    if (!hitFx.has(e)) { renderer.objectOf(e)?.scale.setScalar(1); hitScaled.delete(e); }
  }
  for (const [e, tl] of hitFx) {
    const obj = renderer.objectOf(e);
    if (obj) { obj.scale.setScalar(1 + (tl / HIT_T) * 0.14); hitScaled.add(e); }
  }

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

// ── load/restart hygiene: module state must follow the world ───
function resetAfterLoad() {
  spawnClock = 10;
  // pool lights stay in the scene (constant light count = no shader
  // recompiles) — just snuff them
  for (const f of flashes) {
    f.light.intensity = 0;
    f.t = f.max;
  }
  for (const b of bursts) { renderer.scene.remove(b.pts); b.geo.dispose(); b.mat.dispose(); }
  bursts.length = 0;
  for (const e of hitFx.keys()) renderer.objectOf(e)?.scale.setScalar(1);
  hitFx.clear();
  hitScaled.clear();
  renderer.shake = 0;
  for (const [, el] of bubbles) el.remove();
  bubbles.clear();
  for (const [, el] of hpbars) el.remove();
  hpbars.clear();
  for (const [, m] of world.each(Mind)) m.thinking = false; // never resume mid-thought
  bannerQ.length = 0;
  bannerBusy = false;
  document.getElementById("banner")!.classList.remove("show");
  Object.assign(DIRECTOR, { clock: 3.5, ix: 0, phase: "press", phaseLeft: 12, engaged: false });
  const culled = world.get(hero, QuestLog)?.active[0]?.progress[0] ?? 0;
  goblinKills = culled;
  relicSpawned = culled >= 3;
  const inv = world.get(hero, Inventory);
  satchelList.innerHTML = inv ? inv.items.map((i) => `<div>${i.name} ×${i.qty}</div>`).join("") : "";
  btnRestart.style.display = world.isAlive(hero) ? "none" : "";
}

function restart() {
  world.load(freshWorld, SAVE_COMPONENTS);
  resetAfterLoad();
  typeRibbon("The gates grind open once more. Fight.");
}

// ── key modal ───────────────────────────────────────────────────
const modal = document.getElementById("keymodal")!;
document.getElementById("btn-key")!.onclick = () => modal.classList.add("open");
document.getElementById("key-close")!.onclick = () => modal.classList.remove("open");
document.getElementById("key-save")!.onclick = () => {
  const v = (document.getElementById("key-input") as HTMLInputElement).value.trim();
  if (v) { localStorage.setItem(KEY_STORE, v); location.reload(); } // bindMind() validates on boot
};
document.getElementById("key-clear")!.onclick = () => { localStorage.removeItem(KEY_STORE); location.reload(); };

// ── run ─────────────────────────────────────────────────────────
const loop = new GameLoop(world, { render: renderFrame });

// Agent Play Protocol: any LLM agent can observe/act/step this game through
// the same Eyes + verb pipeline a Mind uses. window.llmgine in the console,
// or via the dev server bridge:  curl localhost:4173/agent/call -d '{"method":"observe"}'
const agentPort = new AgentPort({ world, loop, actions, grid, avatar: hero, sightRange: 500 });
world.addSystem(agentPort.system());
exposeAgentPort(agentPort);
if (["localhost", "127.0.0.1"].includes(location.hostname)) {
  connectAgentBridge(agentPort);
}

loop.start();

// dev handle for debugging (harmless in production)
(globalThis as any).__game = {
  world, renderer, actions, hero, boss, loop, keys: controls.keys, controls, touch, sfx,
  restart, quickSave, quickLoad, DIRECTOR, agentPort,
  get driver() { return driver; },
  C: { Transform, Health, Named, Inventory, Speech, Behavior, Pickup },
  QuestLog,
};

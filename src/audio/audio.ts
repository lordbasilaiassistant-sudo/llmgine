/**
 * Audio — engine basics (issue #2). SFX/music as an engine service, driven by
 * the same event journal Minds perceive: one system maps game events → sounds.
 *
 * WebAudioService synthesizes stock SFX procedurally (no asset files needed —
 * hit/swing/coin/chime/hurt/death) and can register sample URLs too. Simple
 * 2D spatialization: pan + falloff relative to a listener entity.
 */
import type { Entity, System, World } from "../core/ecs.js";
import { Transform } from "../components.js";

export interface PlayOptions {
  volume?: number;
  /** World position for spatialization (omit = UI sound). */
  x?: number;
  y?: number;
}

export interface AudioService {
  play(sound: string, opts?: PlayOptions): void;
  setListener(x: number, y: number): void;
  /** Start looping background music (procedural or a loaded sample). Replaces any current track. */
  music?(track: string, volume?: number): void;
  stopMusic?(): void;
}

/** Records plays — headless/tests. */
export class SilentAudio implements AudioService {
  played: Array<{ sound: string; opts?: PlayOptions }> = [];
  play(sound: string, opts?: PlayOptions): void {
    this.played.push({ sound, opts });
  }
  setListener(): void {}
}

type Synth = (ctx: AudioContext, out: GainNode) => void;

export class WebAudioService implements AudioService {
  private ctx: AudioContext | null = null;
  private listener = { x: 0, y: 0 };
  private samples = new Map<string, AudioBuffer>();
  private synths = new Map<string, Synth>();
  private musicNodes: { stop: () => void } | null = null;
  /**
   * Sounds requested before the context is running (autoplay policy) are
   * queued and flushed the moment resume() lands — the unlocking gesture's
   * own sounds are not dropped. Bounded; oldest entries fall off.
   */
  private pending: Array<{ kind: "sfx" | "music"; run: () => void }> = [];
  private static readonly MAX_PENDING = 16;
  /** Distance at which a positioned sound falls silent. */
  falloff = 600;
  masterVolume = 0.6;

  constructor() {
    for (const [k, v] of Object.entries(STOCK_SYNTHS)) this.synths.set(k, v);
  }

  /** Must be called from a user gesture once (browser autoplay policy). */
  unlock(): void {
    if (!this.ctx && typeof AudioContext !== "undefined") {
      this.ctx = new AudioContext();
      // also flush on OS/tab-level resumes, not just our own resume() call
      this.ctx.addEventListener?.("statechange", () => this.flush());
    }
    void this.ctx?.resume().then(() => this.flush()).catch(() => {});
  }

  private enqueue(kind: "sfx" | "music", run: () => void): void {
    this.pending.push({ kind, run });
    if (this.pending.length > WebAudioService.MAX_PENDING) this.pending.shift();
  }

  private flush(): void {
    if (!this.ctx || this.ctx.state !== "running") return;
    const q = this.pending;
    this.pending = [];
    for (const p of q) p.run();
  }

  defineSynth(name: string, synth: Synth): this {
    this.synths.set(name, synth);
    return this;
  }

  async loadSample(name: string, url: string): Promise<void> {
    this.unlock();
    if (!this.ctx) return;
    const res = await fetch(url);
    this.samples.set(name, await this.ctx.decodeAudioData(await res.arrayBuffer()));
  }

  setListener(x: number, y: number): void {
    this.listener = { x, y };
  }

  play(sound: string, opts: PlayOptions = {}): void {
    if (!this.ctx || this.ctx.state !== "running") {
      this.enqueue("sfx", () => this.play(sound, opts));
      return;
    }
    let gain = (opts.volume ?? 1) * this.masterVolume;
    let pan = 0;
    if (opts.x !== undefined && opts.y !== undefined) {
      const dx = opts.x - this.listener.x;
      const dy = opts.y - this.listener.y;
      const d = Math.hypot(dx, dy);
      if (d > this.falloff) return;
      gain *= 1 - d / this.falloff;
      pan = Math.max(-1, Math.min(1, dx / (this.falloff * 0.6)));
    }
    const g = this.ctx.createGain();
    g.gain.value = gain;
    const p = this.ctx.createStereoPanner();
    p.pan.value = pan;
    g.connect(p).connect(this.ctx.destination);

    const sample = this.samples.get(sound);
    if (sample) {
      const src = this.ctx.createBufferSource();
      src.buffer = sample;
      src.connect(g);
      src.start();
      return;
    }
    this.synths.get(sound)?.(this.ctx, g);
  }

  /**
   * Looping music. Loaded samples loop directly; otherwise the built-in
   * procedural "ambient" track plays: a slow minor drone + sparse arpeggio,
   * generated once into a buffer and looped (zero assets).
   */
  music(track = "ambient", volume = 0.25): void {
    if (!this.ctx || this.ctx.state !== "running") {
      // only the latest requested track matters once unlocked
      this.pending = this.pending.filter((p) => p.kind !== "music");
      this.enqueue("music", () => this.music(track, volume));
      return;
    }
    this.stopMusic();
    const ctx = this.ctx;
    const g = ctx.createGain();
    g.gain.value = volume * this.masterVolume;
    g.connect(ctx.destination);
    const sample = this.samples.get(track);
    const src = ctx.createBufferSource();
    src.buffer = sample ?? renderAmbientLoop(ctx);
    src.loop = true;
    src.connect(g);
    src.start();
    this.musicNodes = {
      stop: () => {
        // anchor the ramp at the current value first — without setValueAtTime
        // the "fade" is an instant cut (classic WebAudio pitfall)
        const now = ctx.currentTime;
        g.gain.cancelScheduledValues(now);
        g.gain.setValueAtTime(g.gain.value, now);
        g.gain.linearRampToValueAtTime(0, now + 0.6);
        setTimeout(() => src.stop(), 700);
      },
    };
  }

  stopMusic(): void {
    this.pending = this.pending.filter((p) => p.kind !== "music");
    this.musicNodes?.stop();
    this.musicNodes = null;
  }
}

/** 8-bar looping ambient bed rendered offline: D-minor drone + pentatonic pings. */
function renderAmbientLoop(ctx: AudioContext): AudioBuffer {
  const sr = ctx.sampleRate;
  const beat = 60 / 68; // 68 bpm
  const len = Math.floor(sr * beat * 16);
  const dur = len / sr; // exact loop duration in seconds
  // Quantize every continuous component to a whole number of cycles per loop,
  // otherwise the loop point lands mid-phase and clicks audibly every ~14 s.
  // (Pings decay within their own beat, so they don't need alignment.)
  const q = (f: number) => Math.max(1, Math.round(f * dur)) / dur;
  const drone1 = q(73.42);
  const drone2 = q(146.83 * 1.003);
  const lfo = q(0.11);
  const buf = ctx.createBuffer(2, len, sr);
  const notes = [146.83, 174.61, 220, 293.66, 349.23]; // D F A d f
  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      // drone: two slow detuned sines an octave apart
      let v =
        0.16 * Math.sin(2 * Math.PI * drone1 * t + ch) * (0.8 + 0.2 * Math.sin(2 * Math.PI * lfo * t)) +
        0.1 * Math.sin(2 * Math.PI * drone2 * t);
      // sparse pings on a deterministic pattern
      const step = Math.floor(t / beat);
      const local = t - step * beat;
      if (step % 2 === ch % 2 && local < 1.2) {
        const note = notes[(step * 7 + ch * 3) % notes.length];
        v += 0.12 * Math.sin(2 * Math.PI * note * 2 * local) * Math.exp(-local * 3.2);
      }
      data[i] = v;
    }
  }
  return buf;
}

// ── procedural stock SFX ────────────────────────────────────────
const osc = (
  ctx: AudioContext, out: GainNode, type: OscillatorType,
  f0: number, f1: number, t: number, vol = 1, delay = 0,
) => {
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  const now = ctx.currentTime + delay;
  o.type = type;
  o.frequency.setValueAtTime(f0, now);
  o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), now + t);
  g.gain.setValueAtTime(vol, now);
  g.gain.exponentialRampToValueAtTime(0.001, now + t);
  o.connect(g).connect(out);
  o.start(now);
  o.stop(now + t);
};

const noise = (ctx: AudioContext, out: GainNode, t: number, cutoff: number, vol = 1) => {
  const len = Math.ceil(ctx.sampleRate * t);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const f = ctx.createBiquadFilter();
  f.type = "lowpass";
  f.frequency.value = cutoff;
  const g = ctx.createGain();
  g.gain.value = vol;
  src.connect(f).connect(g).connect(out);
  src.start();
};

export const STOCK_SYNTHS: Record<string, Synth> = {
  hit: (ctx, out) => {
    noise(ctx, out, 0.12, 900, 0.9);
    osc(ctx, out, "sine", 160, 50, 0.12, 0.8);
  },
  swing: (ctx, out) => noise(ctx, out, 0.16, 2400, 0.35),
  hurt: (ctx, out) => osc(ctx, out, "square", 300, 110, 0.18, 0.5),
  coin: (ctx, out) => {
    osc(ctx, out, "sine", 990, 990, 0.07, 0.5);
    osc(ctx, out, "sine", 1320, 1320, 0.18, 0.5, 0.07);
  },
  chime: (ctx, out) => {
    osc(ctx, out, "sine", 660, 660, 0.3, 0.4);
    osc(ctx, out, "sine", 830, 830, 0.3, 0.35, 0.09);
    osc(ctx, out, "sine", 990, 990, 0.42, 0.3, 0.18);
  },
  death: (ctx, out) => {
    osc(ctx, out, "sawtooth", 220, 40, 0.6, 0.6);
    noise(ctx, out, 0.4, 500, 0.5);
  },
  boom: (ctx, out) => {
    osc(ctx, out, "sine", 120, 30, 0.7, 1);
    noise(ctx, out, 0.5, 300, 0.8);
  },
  whoosh: (ctx, out) => {
    noise(ctx, out, 0.22, 1600, 0.16);
    osc(ctx, out, "sine", 320, 90, 0.12, 0.18);
  },
};

/** Default event → sound routing; games can pass their own map. */
export const DEFAULT_SOUND_MAP: Record<string, string> = {
  "combat:swing": "swing",
  "combat:damaged": "hit",
  "combat:death": "death",
  "combat:whiff": "whoosh", // a dodged swing is audible — the dodge reads
  jump: "whoosh",
  "loot:dropped": "chime",
  "item:pickup": "coin",
  "quest:completed": "chime",
};

/** Plays sounds for journal events, spatialized around a listener entity. */
export function audioSystem(
  service: AudioService,
  listener?: () => Entity,
  soundMap: Record<string, string> = DEFAULT_SOUND_MAP,
): System {
  return {
    name: "audio",
    order: 97,
    update({ world }: { world: World }) {
      const lis = listener?.();
      if (lis !== undefined && world.isAlive(lis)) {
        const t = world.get(lis, Transform);
        if (t) service.setListener(t.x, t.y);
      }
      for (const j of world.events.journal) {
        const sound = soundMap[j.type];
        if (!sound) continue;
        const src: Entity | undefined = j.payload?.entity ?? j.payload?.target;
        const st = src !== undefined ? world.get(src, Transform) : undefined;
        const x = j.payload?.x ?? st?.x;
        const y = j.payload?.y ?? st?.y;
        service.play(sound, x !== undefined ? { x, y } : {});
      }
    },
  };
}

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { World } from "../core/ecs.js";
import { Transform } from "../components.js";
import { SilentAudio, WebAudioService, audioSystem } from "./audio.js";

describe("audio", () => {
  it("routes journal events to spatialized sounds around the listener", () => {
    const world = new World();
    const audio = new SilentAudio();
    const hero = world.create();
    world.add(hero, Transform, { x: 10, y: 20 });
    world.addSystem(audioSystem(audio, () => hero));
    world.addSystem({
      name: "emitter",
      order: 0,
      update: ({ world, tick }) => {
        if (tick === 1) {
          world.events.emit("combat:damaged", { target: hero, amount: 5 });
          world.events.emit("loot:dropped", { x: 100, y: 200, items: [] });
          world.events.emit("unmapped:event", {});
        }
      },
    });
    world.step(1 / 60);
    expect(audio.played.map((p) => p.sound)).toEqual(["hit", "chime"]);
    expect(audio.played[0].opts).toMatchObject({ x: 10, y: 20 }); // from target's Transform
    expect(audio.played[1].opts).toMatchObject({ x: 100, y: 200 }); // from payload
  });

  it("custom sound maps override defaults", () => {
    const world = new World();
    const audio = new SilentAudio();
    world.addSystem(audioSystem(audio, undefined, { "my:event": "boom" }));
    world.addSystem({
      name: "emitter",
      update: ({ world, tick }) => {
        if (tick === 1) world.events.emit("my:event", {});
      },
    });
    world.step(1 / 60);
    expect(audio.played).toEqual([{ sound: "boom", opts: {} }]);
  });
});

// ── WebAudioService against a mock AudioContext ─────────────────

class FakeAudioParam {
  value = 1;
  calls: Array<[op: string, v: number, t: number]> = [];
  setValueAtTime(v: number, t: number) {
    this.calls.push(["set", v, t]);
  }
  linearRampToValueAtTime(v: number, t: number) {
    this.calls.push(["ramp", v, t]);
  }
  exponentialRampToValueAtTime(v: number, t: number) {
    this.calls.push(["expramp", v, t]);
  }
  cancelScheduledValues(t: number) {
    this.calls.push(["cancel", 0, t]);
  }
}

class FakeNode {
  connect(n: unknown) {
    return n;
  }
}

class FakeGain extends FakeNode {
  gain = new FakeAudioParam();
}

class FakeCtx {
  static instances: FakeCtx[] = [];
  state = "suspended";
  currentTime = 2;
  sampleRate = 250; // tiny → renderAmbientLoop stays cheap in tests
  destination = new FakeNode();
  gains: FakeGain[] = [];
  sources: Array<{ loop: boolean; started: boolean; stopped: boolean }> = [];
  private listeners: Array<() => void> = [];
  constructor() {
    FakeCtx.instances.push(this);
  }
  addEventListener(_type: string, fn: () => void) {
    this.listeners.push(fn);
  }
  /** Async like the real thing — state is NOT running when unlock() returns. */
  resume(): Promise<void> {
    return Promise.resolve().then(() => {
      this.state = "running";
      for (const fn of this.listeners) fn();
    });
  }
  createGain() {
    const g = new FakeGain();
    this.gains.push(g);
    return g;
  }
  createStereoPanner() {
    return Object.assign(new FakeNode(), { pan: new FakeAudioParam() });
  }
  createBuffer(ch: number, len: number, sr: number) {
    const chans = Array.from({ length: ch }, () => new Float32Array(len));
    return { numberOfChannels: ch, length: len, sampleRate: sr, getChannelData: (i: number) => chans[i] };
  }
  createBufferSource() {
    const s = {
      buffer: null as unknown,
      loop: false,
      started: false,
      stopped: false,
      connect: (n: unknown) => n,
      start: () => {
        s.started = true;
      },
      stop: () => {
        s.stopped = true;
      },
    };
    this.sources.push(s);
    return s;
  }
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("WebAudioService unlock queue", () => {
  beforeEach(() => {
    FakeCtx.instances = [];
    vi.stubGlobal("AudioContext", FakeCtx);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("queues plays issued before any unlock and flushes them on resume", async () => {
    const svc = new WebAudioService();
    const fired: string[] = [];
    svc.defineSynth("ping", () => fired.push("ping"));
    svc.play("ping"); // no ctx yet — would previously be dropped forever
    expect(fired).toEqual([]);
    svc.unlock();
    await settle();
    expect(fired).toEqual(["ping"]);
  });

  it("does not drop sounds triggered in the unlocking gesture's own frame", async () => {
    const svc = new WebAudioService();
    const fired: string[] = [];
    svc.defineSynth("swing", () => fired.push("swing"));
    svc.unlock(); // resume() is async — ctx still suspended this frame
    svc.play("swing");
    expect(fired).toEqual([]);
    await settle();
    expect(fired).toEqual(["swing"]);
  });

  it("bounds the queue, dropping the oldest", async () => {
    const svc = new WebAudioService();
    const fired: number[] = [];
    for (let i = 0; i < 20; i++) svc.defineSynth(`s${i}`, () => fired.push(i));
    for (let i = 0; i < 20; i++) svc.play(`s${i}`);
    svc.unlock();
    await settle();
    expect(fired).toEqual(Array.from({ length: 16 }, (_, i) => i + 4));
  });

  it("keeps only the latest queued music track and starts it looping on unlock", async () => {
    const svc = new WebAudioService();
    svc.music("ambient", 0.3);
    svc.music("ambient", 0.5); // replaces the queued one
    svc.unlock();
    await settle();
    const ctx = FakeCtx.instances[0];
    const started = ctx.sources.filter((s) => s.started);
    expect(started.length).toBe(1);
    expect(started[0].loop).toBe(true);
  });

  it("stopMusic clears queued music", async () => {
    const svc = new WebAudioService();
    svc.music("ambient");
    svc.stopMusic();
    svc.unlock();
    await settle();
    expect(FakeCtx.instances[0].sources.some((s) => s.started)).toBe(false);
  });

  it("stopMusic anchors the fade at the current gain before ramping (no instant cut)", async () => {
    const svc = new WebAudioService();
    svc.unlock();
    await settle();
    svc.music();
    const ctx = FakeCtx.instances[0];
    const g = ctx.gains[ctx.gains.length - 1];
    svc.stopMusic();
    const ops = g.gain.calls.map((c) => c[0]);
    expect(ops.indexOf("set")).toBeGreaterThanOrEqual(0);
    expect(ops.indexOf("set")).toBeLessThan(ops.indexOf("ramp"));
    const anchor = g.gain.calls.find((c) => c[0] === "set")!;
    expect(anchor[1]).toBe(g.gain.value); // anchored at the value it was playing at
    const ramp = g.gain.calls.find((c) => c[0] === "ramp")!;
    expect(ramp[1]).toBe(0);
    expect(ramp[2]).toBeCloseTo(ctx.currentTime + 0.6);
  });
});

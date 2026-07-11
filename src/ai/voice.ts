import { defineComponent } from "../core/ecs.js";
import type { System } from "../core/ecs.js";

/**
 * Voice — TTS/STT as an engine service, voice as a component. Any entity
 * with Voice + Speech gets heard. Adapters: Web Speech API (browser,
 * zero-setup), a callback adapter for local TTS rigs (pipe to your own
 * synthesizer), and silence for headless.
 */

export const Voice = defineComponent("Voice", () => ({
  enabled: true,
  /** Adapter-interpreted voice id (Web Speech voice name, local model id, …). */
  voiceId: "",
  rate: 1,
  pitch: 1,
}));

export interface SpeakOptions {
  voiceId?: string;
  rate?: number;
  pitch?: number;
}

export interface VoiceService {
  speak(text: string, opts?: SpeakOptions): void;
  /** Start listening; transcripts arrive via the callback. Returns stop fn. */
  listen?(onTranscript: (text: string) => void): () => void;
}

export class SilentVoice implements VoiceService {
  spoken: Array<{ text: string; opts?: SpeakOptions }> = [];
  speak(text: string, opts?: SpeakOptions): void {
    this.spoken.push({ text, opts });
  }
}

/** Browser Web Speech API adapter — free, local, works today. */
export class WebSpeechVoice implements VoiceService {
  speak(text: string, opts?: SpeakOptions): void {
    if (typeof speechSynthesis === "undefined") return;
    const u = new SpeechSynthesisUtterance(text);
    if (opts?.voiceId) {
      const v = speechSynthesis.getVoices().find((v) => v.name === opts.voiceId);
      if (v) u.voice = v;
    }
    u.rate = opts?.rate ?? 1;
    u.pitch = opts?.pitch ?? 1;
    speechSynthesis.speak(u);
  }

  listen(onTranscript: (text: string) => void): () => void {
    const SR: any =
      (globalThis as any).SpeechRecognition ?? (globalThis as any).webkitSpeechRecognition;
    if (!SR) return () => {};
    const rec = new SR();
    rec.continuous = true;
    rec.onresult = (ev: any) => {
      const last = ev.results[ev.results.length - 1];
      if (last.isFinal) onTranscript(last[0].transcript);
    };
    rec.start();
    return () => rec.stop();
  }
}

/** Bring-your-own-TTS: wire a local voice rig with one function. */
export class CallbackVoice implements VoiceService {
  constructor(private fn: (text: string, opts?: SpeakOptions) => void) {}
  speak(text: string, opts?: SpeakOptions): void {
    this.fn(text, opts);
  }
}

/**
 * System that voices "speech" events for entities with a Voice component.
 * Runs after the action drain, so words spoken this tick are heard this tick.
 */
export function voiceSystem(service: VoiceService): System {
  return {
    name: "voice",
    order: 95,
    update({ world }) {
      for (const j of world.events.journal) {
        if (j.type !== "speech") continue;
        const e = j.payload?.entity;
        if (e === undefined) continue;
        const v = world.get(e, Voice);
        if (!v?.enabled) continue;
        service.speak(String(j.payload.text ?? ""), {
          voiceId: v.voiceId || undefined,
          rate: v.rate,
          pitch: v.pitch,
        });
      }
    },
  };
}

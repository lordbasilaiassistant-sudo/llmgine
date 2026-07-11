/**
 * Kokoro neural TTS adapter — fully local, in-browser (ONNX via kokoro-js).
 * ~80 MB model download on first use, cached by the browser after that.
 * Falls back to nothing gracefully; the demo offers Web Speech as plan C.
 */
import type { SpeakOptions, VoiceService } from "../../src/index.js";

const KOKORO_CDN = "https://cdn.jsdelivr.net/npm/kokoro-js@1/+esm";

export type KokoroState = "idle" | "loading" | "ready" | "error";

export class KokoroVoice implements VoiceService {
  private tts: any = null;
  private loading: Promise<void> | null = null;
  private queue: Promise<void> = Promise.resolve();
  state: KokoroState = "idle";

  constructor(
    private voice = "bm_george",
    private onState?: (s: KokoroState) => void,
  ) {}

  private setState(s: KokoroState) {
    this.state = s;
    this.onState?.(s);
  }

  load(): Promise<void> {
    if (this.loading) return this.loading;
    this.setState("loading");
    this.loading = (async () => {
      const url = KOKORO_CDN; // variable keeps esbuild from trying to bundle it
      const mod: any = await import(/* @vite-ignore */ url);
      this.tts = await mod.KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", {
        dtype: "q8",
        device: "wasm",
      });
      this.setState("ready");
    })().catch((err) => {
      console.warn("[kokoro] load failed:", err);
      this.setState("error");
      throw err;
    });
    return this.loading;
  }

  speak(text: string, _opts?: SpeakOptions): void {
    if (!this.tts || !text.trim()) return;
    this.queue = this.queue
      .then(async () => {
        const audio = await this.tts.generate(text, { voice: this.voice });
        const blob: Blob = await audio.toBlob();
        const url = URL.createObjectURL(blob);
        const el = new Audio(url);
        await el.play();
        await new Promise((res) => (el.onended = res));
        URL.revokeObjectURL(url);
      })
      .catch(() => {});
  }
}

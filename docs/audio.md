# Audio — procedural SFX + music, zero asset files

Source: `src/audio/audio.ts`. Import: `llmgine` root or `llmgine/audio`.

The audio layer is an engine **service** (`AudioService`) plus one **system**
(`audioSystem`) that turns the same per-tick event journal Minds perceive into
sounds. No files needed: stock SFX are synthesized, and the default music
track is an 8-bar ambient loop rendered offline into a buffer.

## Quick start

```ts
import { WebAudioService, audioSystem, DEFAULT_SOUND_MAP } from "llmgine/audio";

const audio = new WebAudioService();
// browsers require a user gesture before audio can start:
addEventListener("pointerdown", () => { audio.unlock(); audio.music(); }, { once: true });

world.addSystem(audioSystem(audio, () => playerEntity));
// combat:damaged → "hit", combat:death → "death", item:pickup → "coin", … (DEFAULT_SOUND_MAP)
```

- `audioSystem(service, listener?, soundMap?)` — plays a sound for every
  journal event with a mapping; positions come from the event payload's
  `entity`/`target` Transform, spatialized (stereo pan + linear falloff,
  silent beyond `falloff` = 600 units) around the listener entity.
- Pass your own `soundMap` to remap or extend: `{ "myevent": "boom" }`.

## Stock synths

`hit, swing, hurt, coin, chime, death, boom` — see `STOCK_SYNTHS`. Add your
own procedural sound:

```ts
audio.defineSynth("zap", (ctx, out) => { /* build WebAudio nodes into `out` */ });
audio.play("zap", { x, y, volume: 0.8 });   // omit x/y for a UI (non-spatial) sound
```

## Samples

```ts
await audio.loadSample("roar", "/sfx/roar.ogg"); // decoded via fetch + decodeAudioData
audio.play("roar", { x, y });                    // samples take precedence over synths
await audio.loadSample("theme", "/music/theme.ogg");
audio.music("theme", 0.3);                        // loaded samples loop as music too
```

## Music

`audio.music(track?, volume?)` — starts a loop, replacing any current track.
With no arguments you get the built-in procedural ambient bed (68 bpm D-minor
drone + sparse pentatonic pings). `audio.stopMusic()` fades out over ~0.6 s.

## Headless / tests

`SilentAudio` implements the same interface and records calls:

```ts
import { SilentAudio } from "llmgine/audio";
const audio = new SilentAudio();
// ... run sim ...
expect(audio.played.map(p => p.sound)).toContain("death");
```

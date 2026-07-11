import { describe, expect, it } from "vitest";
import { World } from "../core/ecs.js";
import { Transform } from "../components.js";
import { SilentAudio, audioSystem } from "./audio.js";

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

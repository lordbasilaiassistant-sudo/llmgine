# glTF models — real art in the 3D renderer

Source: `src/render3d/gltf.ts`. Import: `llmgine/render3d`.

The `ThreeRenderer` builds entity visuals from **model factories** registered
per `Sprite.kind`. `gltfModel()` wraps a loaded `.glb/.gltf` as such a
factory, with movement-driven animation for free.

## Load + register

```ts
import { ThreeRenderer, loadGLTF, gltfModel } from "llmgine/render3d";

const renderer = new ThreeRenderer(stageEl, {});
const knight = await loadGLTF("/models/knight.glb");   // { scene, animations }

renderer.defineModel("knight", gltfModel(knight, {
  scale: 20,          // uniform scale (default 1)
  yOffset: 0,         // lift models authored above/below origin
  walkClip: "Walk",   // AnimationClip names inside the glTF
  idleClip: "Idle",
}));

// any entity with Sprite{kind:"knight"} now renders this model:
world.add(e, Sprite, { kind: "knight" });
```

## What the wrapper does per entity

- Clones the glTF scene per entity (shallow `scene.clone(true)`).
- Rotates the instance to face its `Velocity` heading (updates only while
  speed > 8, so it doesn't jitter at rest).
- Crossfades walk/idle by weight: moving (speed > 8) → `walkClip`, otherwise
  `idleClip`, via a per-entity `AnimationMixer`.

## Skinned meshes gotcha

The default shallow clone **shares skeletons** between instances — fine for
one instance per model, wrong for crowds of the same animated character (they
will all pose identically). Pass a proper clone:

```ts
import { clone as skeletonClone } from "three/examples/jsm/utils/SkeletonUtils.js";
renderer.defineModel("goblin", gltfModel(goblinAsset, {
  walkClip: "Run", idleClip: "Idle",
  clone: (scene) => skeletonClone(scene),
}));
```

## Custom animation

A factory returns a `THREE.Object3D`; `root.userData.animate(time, world,
entity)` is called every frame with live sim access — read cooldowns, Health,
Mind state and drive any extra motion (lunges, glowing eyes) exactly like the
procedural models in the arena example do.

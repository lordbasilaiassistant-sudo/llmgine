import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { ModelFactory } from "./three.js";
import { Velocity } from "../components.js";

/**
 * glTF helpers — load real art into the model-factory system (issue #6).
 *
 *   const knight = await loadGLTF("/models/knight.glb");
 *   renderer.defineModel("knight", gltfModel(knight, {
 *     scale: 20, walkClip: "Walk", idleClip: "Idle",
 *   }));
 *
 * Each entity gets its own clone (SkeletonUtils-free shallow clone is enough
 * for separate transforms; animated skinned meshes share skeletons — for
 * per-entity skinned animation import SkeletonUtils and pass `clone`).
 */

export interface LoadedGLTF {
  scene: THREE.Group;
  animations: THREE.AnimationClip[];
}

export async function loadGLTF(url: string): Promise<LoadedGLTF> {
  const loader = new GLTFLoader();
  const gltf = await loader.loadAsync(url);
  return { scene: gltf.scene, animations: gltf.animations };
}

export interface GltfModelOptions {
  /** Uniform scale applied to the cloned scene. Default 1. */
  scale?: number;
  /** Y offset (models authored at origin may need lifting). Default 0. */
  yOffset?: number;
  /** Animation clip names to crossfade between based on movement. */
  walkClip?: string;
  idleClip?: string;
  /** Custom clone fn (e.g. SkeletonUtils.clone for skinned meshes). */
  clone?: (scene: THREE.Group) => THREE.Object3D;
}

/** Wrap a loaded glTF as a ModelFactory with movement-driven animation. */
export function gltfModel(asset: LoadedGLTF, opts: GltfModelOptions = {}): ModelFactory {
  return () => {
    const root = new THREE.Group();
    const inst = (opts.clone ?? ((s: THREE.Group) => s.clone(true)))(asset.scene);
    inst.scale.setScalar(opts.scale ?? 1);
    inst.position.y = opts.yOffset ?? 0;
    root.add(inst);

    let mixer: THREE.AnimationMixer | null = null;
    let walk: THREE.AnimationAction | null = null;
    let idle: THREE.AnimationAction | null = null;
    if (asset.animations.length && (opts.walkClip || opts.idleClip)) {
      mixer = new THREE.AnimationMixer(inst);
      const clip = (name?: string) =>
        name ? THREE.AnimationClip.findByName(asset.animations, name) : null;
      const w = clip(opts.walkClip);
      const i = clip(opts.idleClip);
      if (w) walk = mixer.clipAction(w);
      if (i) {
        idle = mixer.clipAction(i);
        idle.play();
      }
    }

    let last = 0;
    let heading = 0;
    root.userData.animate = (time: number, world: any, e: number) => {
      const dt = last ? Math.max(0, time - last) : 0;
      last = time;
      const v = world.get(e, Velocity);
      const speed = v ? Math.hypot(v.vx, v.vy) : 0;
      if (v && speed > 8) heading = Math.atan2(v.vx, v.vy);
      inst.rotation.y = heading;
      if (mixer) {
        if (walk && idle) {
          const moving = speed > 8;
          walk.enabled = true;
          idle.enabled = true;
          walk.setEffectiveWeight(moving ? 1 : 0);
          idle.setEffectiveWeight(moving ? 0 : 1);
          if (moving && !walk.isRunning()) walk.play();
        }
        mixer.update(dt);
      }
    };
    return root;
  };
}

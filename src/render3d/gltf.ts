import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as skeletonClone } from "three/examples/jsm/utils/SkeletonUtils.js";
import type { ModelFactory } from "./three.js";
import { markSharedAssets } from "./three.js";
import { Velocity } from "../components.js";

/**
 * glTF helpers — load real art into the model-factory system (issue #6).
 *
 *   const knight = await loadGLTF("/models/knight.glb");
 *   renderer.defineModel("knight", gltfModel(knight, {
 *     scale: 20, walkClip: "Walk", idleClip: "Idle",
 *   }));
 *
 * Each entity gets its own SkeletonUtils clone (correct for skinned meshes;
 * plain hierarchies clone identically). Clones share the loaded asset's
 * geometry/materials/textures — loadGLTF tags those as shared so per-entity
 * disposal in ThreeRenderer (death, kind swap) never frees a sibling's GPU
 * buffers.
 */

export interface LoadedGLTF {
  scene: THREE.Group;
  animations: THREE.AnimationClip[];
}

export async function loadGLTF(url: string): Promise<LoadedGLTF> {
  const loader = new GLTFLoader();
  const gltf = await loader.loadAsync(url);
  markSharedAssets(gltf.scene);
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
    const inst = (opts.clone ?? ((s: THREE.Group) => skeletonClone(s)))(asset.scene);
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
        const moving = speed > 8;
        if (walk) {
          walk.enabled = true;
          if (idle) {
            walk.setEffectiveWeight(moving ? 1 : 0);
          } else {
            // walk-only asset: keep the clip posed, freeze it when standing
            walk.setEffectiveWeight(1);
            walk.paused = !moving;
          }
          if (moving && !walk.isRunning()) walk.play();
        }
        if (idle) {
          idle.enabled = true;
          idle.setEffectiveWeight(moving && walk ? 0 : 1);
        }
        mixer.update(dt);
      }
    };
    return root;
  };
}

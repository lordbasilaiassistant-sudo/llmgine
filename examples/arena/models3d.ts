/**
 * 3D art for the Neural Colosseum. Procedural mesh characters with live
 * animation — every model reads real sim state (velocity, attack cooldowns,
 * a thinking Mind) through the engine's model-factory system.
 */
import * as THREE from "three";
import type { ModelContext, ThreeRenderer } from "../../src/render3d/three.js";
import { Attack, Mind, Pickup, Velocity, type World } from "../../src/index.js";

const swingOf = (world: World, e: number) => {
  const atk = world.get(e, Attack);
  return !atk || atk.ready <= 0 ? 0 : Math.max(0, atk.ready / atk.cooldown);
};
const speedOf = (world: World, e: number) => {
  const v = world.get(e, Velocity);
  return v ? Math.hypot(v.vx, v.vy) : 0;
};
const headingOf = (world: World, e: number, prev: number) => {
  const v = world.get(e, Velocity);
  if (v && Math.hypot(v.vx, v.vy) > 8) return Math.atan2(v.vx, v.vy);
  return prev;
};

const std = (color: number | string, opts: Partial<THREE.MeshStandardMaterialParameters> = {}) =>
  new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.1, ...opts });

// ── THE CHALLENGER — bronze gladiator ──────────────────────────
export function gladiator({ world, entity }: ModelContext): THREE.Object3D {
  const g = new THREE.Group();
  const rig = new THREE.Group();
  g.add(rig);

  const bronze = std(0xc08a3e, { metalness: 0.65, roughness: 0.35 });
  const skin = std(0xd9b48c);
  const teal = std(0x2fbfa6, { emissive: 0x0d4f44, emissiveIntensity: 0.5 });

  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(6.5, 8, 6, 14), bronze);
  torso.position.y = 16;
  rig.add(torso);

  const belt = new THREE.Mesh(new THREE.CylinderGeometry(7, 7, 2.4, 14), std(0x3d3227));
  belt.position.y = 11;
  rig.add(belt);

  const head = new THREE.Mesh(new THREE.SphereGeometry(4.4, 14, 12), skin);
  head.position.y = 27;
  rig.add(head);
  const helm = new THREE.Mesh(
    new THREE.SphereGeometry(4.9, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.62),
    bronze,
  );
  helm.position.y = 27.6;
  rig.add(helm);
  const plume = new THREE.Mesh(new THREE.BoxGeometry(1.6, 4.5, 9), teal);
  plume.position.set(0, 33, 0);
  rig.add(plume);

  const mkLeg = (x: number) => {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(1.9, 1.6, 10, 8), skin);
    leg.position.set(x, 5, 0);
    rig.add(leg);
    return leg;
  };
  const legL = mkLeg(-3.2);
  const legR = mkLeg(3.2);

  // shield arm
  const shield = new THREE.Mesh(new THREE.CylinderGeometry(5.6, 5.6, 1.4, 16), bronze);
  shield.rotation.z = Math.PI / 2;
  shield.position.set(-8.5, 16, 0);
  rig.add(shield);

  // sword arm
  const arm = new THREE.Group();
  arm.position.set(8, 20, 0);
  const swordArm = new THREE.Mesh(new THREE.CylinderGeometry(1.7, 1.5, 8, 8), skin);
  swordArm.rotation.z = Math.PI / 2;
  swordArm.position.x = 3;
  arm.add(swordArm);
  const blade = new THREE.Mesh(
    new THREE.BoxGeometry(1.1, 16, 2.6),
    std(0xd9dee6, { metalness: 0.9, roughness: 0.2 }),
  );
  blade.position.set(7.5, 6, 0);
  arm.add(blade);
  const guard = new THREE.Mesh(new THREE.BoxGeometry(3.4, 1.2, 4.2), bronze);
  guard.position.set(7.5, -1, 0);
  arm.add(guard);
  rig.add(arm);

  let heading = 0;
  g.userData.animate = (time: number, world: World, e: number) => {
    heading = headingOf(world, e, heading);
    rig.rotation.y = heading;
    const sp = speedOf(world, e);
    const walk = sp > 8 ? Math.sin(time * 12) : 0;
    legL.rotation.x = walk * 0.7;
    legR.rotation.x = -walk * 0.7;
    rig.position.y = Math.abs(walk) * 1.2 + Math.sin(time * 2.1) * 0.4;
    const s = swingOf(world, e);
    arm.rotation.x = -0.3 - s * s * 2.2;
  };
  return g;
}

// ── THE ARENA MASTER — horned obsidian colossus ────────────────
export function arenaMaster({ world, entity }: ModelContext): THREE.Object3D {
  const g = new THREE.Group();
  const rig = new THREE.Group();
  g.add(rig);

  const obsidian = std(0x241a2c, { roughness: 0.4, metalness: 0.3 });
  const emberMat = new THREE.MeshStandardMaterial({
    color: 0x1c1220,
    emissive: 0xff4a2e,
    emissiveIntensity: 0.9,
    roughness: 0.5,
  });
  const gold = std(0xd4a24e, { metalness: 0.85, roughness: 0.25 });

  const body = new THREE.Mesh(new THREE.CapsuleGeometry(15, 16, 8, 18), obsidian);
  body.position.y = 30;
  body.scale.set(1.15, 1, 0.95);
  rig.add(body);

  // ember crack plates
  for (const [x, y, z, r] of [
    [-6, 26, 12, 0.4],
    [7, 34, 11, -0.5],
    [0, 20, 13, 0.1],
  ] as const) {
    const crack = new THREE.Mesh(new THREE.BoxGeometry(2.2, 9, 1.2), emberMat);
    crack.position.set(x, y, z);
    crack.rotation.z = r;
    rig.add(crack);
  }

  // shoulders + spikes
  for (const side of [-1, 1]) {
    const pad = new THREE.Mesh(new THREE.SphereGeometry(8, 12, 10), obsidian);
    pad.position.set(side * 15, 40, 0);
    rig.add(pad);
    const spike = new THREE.Mesh(new THREE.ConeGeometry(3, 12, 8), obsidian);
    spike.position.set(side * 19, 48, 0);
    spike.rotation.z = -side * 0.5;
    rig.add(spike);
  }

  // skull head
  const skull = new THREE.Mesh(new THREE.SphereGeometry(7, 14, 12), std(0xd8cfc0, { roughness: 0.7 }));
  skull.position.y = 52;
  skull.scale.set(0.95, 1.05, 0.9);
  rig.add(skull);
  const eyeMat = new THREE.MeshStandardMaterial({
    color: 0x000000,
    emissive: 0xff5d45,
    emissiveIntensity: 2.2,
  });
  const eyes: THREE.Mesh[] = [];
  for (const side of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(1.3, 8, 8), eyeMat);
    eye.position.set(side * 2.6, 53, 5.6);
    rig.add(eye);
    eyes.push(eye);
  }

  // gilt horns + crown
  for (const side of [-1, 1]) {
    const horn = new THREE.Mesh(new THREE.ConeGeometry(2.2, 16, 10), gold);
    horn.position.set(side * 7.5, 60, 0);
    horn.rotation.z = -side * 0.65;
    rig.add(horn);
  }
  const crown = new THREE.Mesh(new THREE.TorusGeometry(6.4, 1.1, 8, 18), gold);
  crown.position.y = 57.5;
  crown.rotation.x = Math.PI / 2;
  rig.add(crown);

  // claw arm
  const arm = new THREE.Group();
  arm.position.set(17, 38, 0);
  const forearm = new THREE.Mesh(new THREE.CylinderGeometry(3.4, 4.2, 16, 10), obsidian);
  forearm.rotation.z = Math.PI / 2.4;
  forearm.position.set(7, -3, 0);
  arm.add(forearm);
  for (let i = 0; i < 3; i++) {
    const claw = new THREE.Mesh(new THREE.ConeGeometry(1.1, 6.5, 6), std(0xd8cfc0));
    claw.position.set(14, -7 + i * 0, (i - 1) * 2.6);
    claw.rotation.z = -Math.PI / 2;
    arm.add(claw);
  }
  rig.add(arm);

  // under-glow
  const glow = new THREE.PointLight(0xc23b4e, 7000, 140, 2);
  glow.position.y = 12;
  g.add(glow);

  let heading = Math.PI;
  g.userData.animate = (time: number, world: World, e: number) => {
    heading = headingOf(world, e, heading);
    rig.rotation.y = heading;
    const breathe = Math.sin(time * 1.7);
    rig.position.y = breathe * 1.2;
    body.scale.y = 1 + breathe * 0.015;
    const thinking = world.get(e, Mind)?.thinking ?? false;
    const pulse = thinking ? 2.2 + Math.sin(time * 8) * 1.2 : 0.9 + Math.sin(time * 4) * 0.25;
    emberMat.emissiveIntensity = pulse;
    eyeMat.emissiveIntensity = thinking ? 4 : 2.2;
    eyeMat.emissive.setHex(thinking ? 0xffd166 : 0xff5d45);
    glow.intensity = 5500 + pulse * 2200;
    const s = swingOf(world, e);
    arm.rotation.z = 0.2 - s * s * 1.9;
  };
  return g;
}

// ── PIT GOBLIN ─────────────────────────────────────────────────
export function goblinModel({ world, entity }: ModelContext): THREE.Object3D {
  const g = new THREE.Group();
  const rig = new THREE.Group();
  g.add(rig);
  const green = std(0x6f8a3f);
  const dark = std(0x46592a);

  const body = new THREE.Mesh(new THREE.CapsuleGeometry(4.2, 4, 6, 12), green);
  body.position.y = 8.5;
  body.rotation.x = 0.25;
  rig.add(body);
  const head = new THREE.Mesh(new THREE.SphereGeometry(3.6, 12, 10), green);
  head.position.set(0, 14.5, 2);
  rig.add(head);
  for (const side of [-1, 1]) {
    const ear = new THREE.Mesh(new THREE.ConeGeometry(1.4, 6.5, 6), dark);
    ear.position.set(side * 4.4, 16.5, 1.4);
    ear.rotation.z = -side * 1.25;
    rig.add(ear);
  }
  const eyeMat = new THREE.MeshStandardMaterial({ emissive: 0xffd166, emissiveIntensity: 1.6, color: 0x000000 });
  for (const side of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.8, 6, 6), eyeMat);
    eye.position.set(side * 1.5, 14.8, 5);
    rig.add(eye);
  }
  const dagger = new THREE.Mesh(new THREE.ConeGeometry(0.9, 7, 6), std(0x9c8b78, { metalness: 0.7 }));
  dagger.rotation.z = -Math.PI / 2;
  const armG = new THREE.Group();
  armG.position.set(4.5, 9, 2);
  dagger.position.x = 4;
  armG.add(dagger);
  rig.add(armG);

  let heading = 0;
  g.userData.animate = (time: number, world: World, e: number) => {
    heading = headingOf(world, e, heading);
    rig.rotation.y = heading;
    const sp = speedOf(world, e);
    rig.position.y = sp > 8 ? Math.abs(Math.sin(time * 15 + e)) * 2 : Math.sin(time * 3 + e) * 0.5;
    const s = swingOf(world, e);
    armG.rotation.z = 0.2 - s * s * 1.8;
  };
  return g;
}

// ── LOOT ───────────────────────────────────────────────────────
export function pickupModel({ world, entity, sprite }: ModelContext): THREE.Object3D {
  const g = new THREE.Group();
  const id = world.get(entity, Pickup)?.item.id ?? "";
  let core: THREE.Object3D;
  if (id === "gold") {
    core = new THREE.Group();
    for (let i = 0; i < 3; i++) {
      const coin = new THREE.Mesh(
        new THREE.CylinderGeometry(3.4 - i * 0.3, 3.4 - i * 0.3, 1, 14),
        std(0xd4a24e, { metalness: 0.9, roughness: 0.25, emissive: 0x5a3d10, emissiveIntensity: 0.6 }),
      );
      coin.position.y = 1 + i * 1.2;
      (core as THREE.Group).add(coin);
    }
  } else if (id === "potion") {
    core = new THREE.Mesh(
      new THREE.SphereGeometry(3.2, 12, 10),
      new THREE.MeshStandardMaterial({ color: 0xe35d6d, emissive: 0x8a1f2c, emissiveIntensity: 0.9, roughness: 0.2 }),
    );
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 2.6, 8), std(0xc9d4dc));
    neck.position.y = 3.6;
    (core as THREE.Mesh).add(neck);
  } else {
    core = new THREE.Mesh(
      new THREE.IcosahedronGeometry(3.6, 0),
      new THREE.MeshStandardMaterial({
        color: new THREE.Color(sprite.color),
        emissive: new THREE.Color(sprite.color),
        emissiveIntensity: 0.8,
        roughness: 0.25,
        metalness: 0.4,
      }),
    );
  }
  core.position.y = 6;
  g.add(core);
  const light = new THREE.PointLight(new THREE.Color(sprite.color), 1800, 70, 2);
  light.position.y = 8;
  g.add(light);
  g.userData.animate = (time: number, _w: World, e: number) => {
    core.position.y = 7 + Math.sin(time * 3 + e * 1.7) * 1.6;
    core.rotation.y = time * 1.6 + e;
  };
  return g;
}

// ── STONE PILLAR — cover, routed around by NavGrid ─────────────
export function pillarModel(): THREE.Object3D {
  const g = new THREE.Group();
  const stone = std(0x453a56, { roughness: 0.85 });
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(16, 19, 78, 10), stone);
  shaft.position.y = 39;
  g.add(shaft);
  for (const [y, r] of [[4, 24], [78, 22]] as const) {
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 8, 10), std(0x352b44, { roughness: 0.9 }));
    cap.position.y = y;
    g.add(cap);
  }
  const trim = new THREE.Mesh(
    new THREE.TorusGeometry(17.5, 1.2, 6, 14),
    std(0xd4a24e, { metalness: 0.8, roughness: 0.3, emissive: 0x4a3410, emissiveIntensity: 0.35 }),
  );
  trim.rotation.x = Math.PI / 2;
  trim.position.y = 62;
  g.add(trim);
  return g;
}

// ── HELLFIRE BOLT — the boss's ranged projectile ───────────────
export function projectileModel({ sprite }: ModelContext): THREE.Object3D {
  const g = new THREE.Group();
  const color = new THREE.Color(sprite.color);
  const core = new THREE.Mesh(
    new THREE.SphereGeometry(4.5, 10, 8),
    new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 3, roughness: 0.2 }),
  );
  core.position.y = 18;
  g.add(core);
  const light = new THREE.PointLight(color, 2600, 90, 2);
  light.position.y = 18;
  g.add(light);
  g.userData.animate = (time: number, _w: World, e: number) => {
    core.scale.setScalar(1 + Math.sin(time * 22 + e) * 0.25);
  };
  return g;
}

export function registerModels(r: ThreeRenderer): void {
  r.defineModel("gladiator", gladiator)
    .defineModel("arenamaster", arenaMaster)
    .defineModel("goblin", goblinModel)
    .defineModel("pickup", pickupModel)
    .defineModel("pillar", pillarModel)
    .defineModel("projectile", projectileModel);
}

/**
 * 3D art for the Neural Colosseum. Procedural mesh characters with live
 * animation — every model reads real sim state (velocity, attack cooldowns,
 * a thinking Mind) through the engine's model-factory system.
 */
import * as THREE from "three";
import type { ModelContext, ThreeRenderer } from "../../src/render3d/three.js";
import { Attack, Mind, Pickup, Transform, Velocity, type World } from "../../src/index.js";

/**
 * Swing envelope: 0 at rest → whips to 1 right after the hit lands → settles.
 * (`ready` DECAYS from cooldown to 0 — using it raw plays the swing in
 * reverse, which is exactly the "sword swings backwards" bug.)
 */
const swingOf = (world: World, e: number) => {
  const atk = world.get(e, Attack);
  if (!atk || atk.ready <= 0 || atk.cooldown <= 0) return 0;
  const p = 1 - atk.ready / atk.cooldown; // 0 → 1 across the cooldown
  return Math.sin(Math.min(1, p * 3) * Math.PI); // fast forward whip, smooth recovery
};
const speedOf = (world: World, e: number) => {
  const v = world.get(e, Velocity);
  return v ? Math.hypot(v.vx, v.vy) : 0;
};
/** Windup anticipation progress: 0 = idle, →1 as the telegraphed hit nears. */
const windupOf = (world: World, e: number) => {
  const atk = world.get(e, Attack);
  return atk && atk.winding > 0 && atk.windup > 0 ? 1 - atk.winding / atk.windup : 0;
};
/** Same, for ranged chant telegraphs (Ranged.winding). */
const rangedWindupOf = (world: World, e: number) => {
  const r = world.getNamed(e, "Ranged");
  return r && r.winding > 0 && r.windup > 0 ? 1 - r.winding / r.windup : 0;
};
/**
 * Rig Y-rotation from the ENGINE's facing (Transform.rot — set by movement,
 * combat and behavior, so standing strikes face their target too). Models
 * are authored facing +Z; shortest-path smoothing so turns never spin the
 * long way. Factories that use this set `selfRotate` so the renderer's
 * root rotation doesn't double up.
 */
const headingOf = (world: World, e: number, prev: number) => {
  const t = world.get(e, Transform);
  if (!t) return prev;
  const target = Math.atan2(Math.cos(t.rot), Math.sin(t.rot));
  let d = (target - prev) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return prev + d * 0.28;
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
  g.userData.selfRotate = true; // the rig steers itself from Transform.rot
  g.userData.animate = (time: number, world: World, e: number) => {
    heading = headingOf(world, e, heading);
    rig.rotation.y = heading;
    const sp = speedOf(world, e);
    // stride amplitude follows actual speed — no full-sprint legs at a walk
    const walk = sp > 8 ? Math.sin(time * 12) * Math.min(1, sp / 170) : 0;
    legL.rotation.x = walk * 0.7;
    legR.rotation.x = -walk * 0.7;
    const air = (world.get(e, Transform)?.z ?? 0) > 1;
    rig.position.y = air ? 0 : Math.abs(walk) * 1.2 + Math.sin(time * 2.1) * 0.4;
    if (air) { legL.rotation.x = 0.6; legR.rotation.x = -0.4; } // tucked jump pose
    // forward slash: +X arm rotation drives the blade toward the rig's +Z
    // facing — never away from it
    const whip = swingOf(world, e);
    arm.rotation.x = -0.3 + whip * 2.0;
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

  // under-glow: additive disc, not a PointLight — the boss's death would
  // change the scene light count and stall every shader at the climax
  const glowMat = new THREE.MeshBasicMaterial({
    color: 0xc23b4e,
    transparent: true,
    opacity: 0.4,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const glow = new THREE.Mesh(new THREE.CircleGeometry(34, 20), glowMat);
  glow.rotation.x = -Math.PI / 2;
  glow.position.y = 0.5;
  g.add(glow);

  let heading = Math.PI;
  g.userData.selfRotate = true;
  g.userData.animate = (time: number, world: World, e: number) => {
    heading = headingOf(world, e, heading);
    rig.rotation.y = heading;
    const breathe = Math.sin(time * 1.7);
    rig.position.y = breathe * 1.2;
    body.scale.y = 1 + breathe * 0.015;
    const thinking = world.get(e, Mind)?.thinking ?? false;
    const wind = windupOf(world, e);
    const pulse = thinking ? 2.2 + Math.sin(time * 8) * 1.2 : 0.9 + Math.sin(time * 4) * 0.25;
    emberMat.emissiveIntensity = pulse + wind * 2.5; // embers flare on windup
    eyeMat.emissiveIntensity = (thinking ? 4 : 2.2) + wind * 4;
    eyeMat.emissive.setHex(wind > 0 ? 0xffe08a : thinking ? 0xffd166 : 0xff5d45);
    glowMat.opacity = 0.3 + pulse * 0.08 + wind * 0.3;
    // ANTICIPATION: claw raises high during the telegraph, then sweeps
    // INTO the facing direction (+Z) — the hit is readable before it lands
    const whip = swingOf(world, e);
    arm.rotation.y = -whip * 1.5;
    arm.rotation.z = 0.2 + wind * 1.35 + whip * 0.4;
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
  g.userData.selfRotate = true;
  g.userData.animate = (time: number, world: World, e: number) => {
    heading = headingOf(world, e, heading);
    rig.rotation.y = heading;
    const sp = speedOf(world, e);
    rig.position.y = sp > 8 ? Math.abs(Math.sin(time * 15 + e)) * 2 : Math.sin(time * 3 + e) * 0.5;
    // ANTICIPATION: dagger pulls back during the telegraph, then thrusts
    // toward facing (+Z) — never a sideways flail after the damage
    const wind = windupOf(world, e);
    const whip = swingOf(world, e);
    armG.rotation.y = wind * 0.9 - whip * 1.2;
    armG.position.z = 2 - wind * 2.5 + whip * 3.5;
    eyeMat.emissiveIntensity = 1.6 + wind * 3; // eyes flare = incoming hit
  };
  return g;
}

// ── VERDIGRIS SENTINEL — the jump-bait statue ──────────────────
// Squat, WIDE, flat-topped bronze golem with a stone maul. The tell is a
// sudden VERTICAL silhouette spike: maul raised fully overhead + core flare.
export function sentinelModel({ world, entity }: ModelContext): THREE.Object3D {
  const g = new THREE.Group();
  const rig = new THREE.Group();
  g.add(rig);
  const verdigris = std(0x4f9a7e, { roughness: 0.55, metalness: 0.5 });
  const gilt = std(0xd4a24e, { metalness: 0.85, roughness: 0.3 });

  // broad low body — width ≈ height
  const body = new THREE.Mesh(new THREE.CylinderGeometry(13, 15, 14, 8), verdigris);
  body.position.y = 9;
  rig.add(body);
  const top = new THREE.Mesh(new THREE.CylinderGeometry(14.5, 13, 3, 8), gilt);
  top.position.y = 17.5;
  rig.add(top);
  // core crack — emissive only (no light: light-count stays constant)
  const coreMat = new THREE.MeshStandardMaterial({
    color: 0x143528,
    emissive: 0x6fe8b8,
    emissiveIntensity: 0.8,
    roughness: 0.4,
  });
  const core = new THREE.Mesh(new THREE.BoxGeometry(16, 2.2, 2.2), coreMat);
  core.position.y = 11;
  core.position.z = 6.5;
  rig.add(core);
  for (const side of [-1, 1]) {
    const foot = new THREE.Mesh(new THREE.BoxGeometry(7, 4, 9), verdigris);
    foot.position.set(side * 8, 2, 0);
    rig.add(foot);
  }
  // maul arm — held low at rest, raised OVERHEAD during the windup
  const arm = new THREE.Group();
  arm.position.set(14, 14, 0);
  const haft = new THREE.Mesh(new THREE.CylinderGeometry(1.4, 1.4, 26, 8), std(0x5a4a38));
  haft.position.y = 8;
  arm.add(haft);
  const maulHead = new THREE.Mesh(new THREE.BoxGeometry(9, 7, 7), std(0x6b6577, { roughness: 0.8 }));
  maulHead.position.y = 21;
  arm.add(maulHead);
  const band = new THREE.Mesh(new THREE.TorusGeometry(2.1, 0.5, 6, 10), gilt);
  band.rotation.x = Math.PI / 2;
  band.position.y = 16;
  arm.add(band);
  rig.add(arm);

  let heading = 0;
  arm.rotation.z = 1.15; // maul resting near the ground
  g.userData.selfRotate = true;
  g.userData.animate = (time: number, world2: World, e: number) => {
    heading = headingOf(world2, e, heading);
    rig.rotation.y = heading;
    const wind = windupOf(world2, e); // 0→1 raise
    const whip = swingOf(world2, e); // slam follow-through
    // rest 1.15 → overhead -1.35 during windup; whip slams forward past it
    arm.rotation.z = 1.15 - wind * 2.5 + whip * 2.9;
    coreMat.emissiveIntensity = 0.8 + wind * 4.5; // core flare = incoming slam
    rig.position.y = Math.sin(time * 1.1 + e) * 0.35 + whip * -1.2;
  };
  return g;
}

// ── ASH CHANTER — the crossfire acolyte ────────────────────────
// TALL and THIN — a vertical needle in bone-white robes. Chant tell: the
// violet staff orb swells and flares before every bolt.
export function chanterModel({ world, entity }: ModelContext): THREE.Object3D {
  const g = new THREE.Group();
  const rig = new THREE.Group();
  g.add(rig);
  const bone = std(0xd8cfc0, { roughness: 0.75 });

  const robe = new THREE.Mesh(new THREE.ConeGeometry(6.5, 34, 8), bone);
  robe.position.y = 17;
  rig.add(robe);
  const hood = new THREE.Mesh(new THREE.SphereGeometry(3.4, 10, 8), bone);
  hood.position.y = 35;
  rig.add(hood);
  const face = new THREE.Mesh(
    new THREE.SphereGeometry(2.2, 8, 8),
    new THREE.MeshStandardMaterial({ color: 0x1a1424, roughness: 0.9 }),
  );
  face.position.set(0, 34.6, 2);
  rig.add(face);
  // staff + violet orb (emissive only)
  const staff = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.7, 30, 6), std(0x3d3227));
  staff.position.set(6.5, 20, 2);
  rig.add(staff);
  const orbMat = new THREE.MeshStandardMaterial({
    color: 0x2a1740,
    emissive: 0xb06df0,
    emissiveIntensity: 2,
    roughness: 0.2,
  });
  const orb = new THREE.Mesh(new THREE.SphereGeometry(2.6, 12, 10), orbMat);
  orb.position.set(6.5, 36.5, 2);
  rig.add(orb);

  let heading = 0;
  g.userData.selfRotate = true;
  g.userData.animate = (time: number, world2: World, e: number) => {
    heading = headingOf(world2, e, heading);
    rig.rotation.y = heading;
    rig.position.y = Math.sin(time * 2.2 + e) * 0.8; // unsettling hover-sway
    const chant = rangedWindupOf(world2, e); // 0→1 before each bolt
    const s = 1 + chant * 0.8;
    orb.scale.setScalar(s);
    orbMat.emissiveIntensity = 2 + chant * 3 + Math.sin(time * 6 + e) * 0.3;
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
  // NO per-entity PointLight: every add/remove changes the scene light count
  // and three.js recompiles ALL shaders (a stall on every drop and pickup).
  // A glow disc + strong emissive reads just as bright, costs nothing.
  const glowDisc = new THREE.Mesh(
    new THREE.CircleGeometry(9, 16),
    new THREE.MeshBasicMaterial({
      color: new THREE.Color(sprite.color),
      transparent: true,
      opacity: 0.35,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
  glowDisc.rotation.x = -Math.PI / 2;
  glowDisc.position.y = 0.4;
  g.add(glowDisc);
  g.userData.animate = (time: number, _w: World, e: number) => {
    core.position.y = 7 + Math.sin(time * 3 + e * 1.7) * 1.6;
    core.rotation.y = time * 1.6 + e;
    (glowDisc.material as THREE.MeshBasicMaterial).opacity = 0.25 + Math.sin(time * 3 + e) * 0.12;
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
  // no PointLight (light-count change = full shader recompile per bolt) —
  // an additive halo shell sells the glow instead
  const halo = new THREE.Mesh(
    new THREE.SphereGeometry(7.5, 10, 8),
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.3,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
  halo.position.y = 18;
  g.add(halo);
  g.userData.animate = (time: number, _w: World, e: number) => {
    core.scale.setScalar(1 + Math.sin(time * 22 + e) * 0.25);
    halo.scale.setScalar(1 + Math.sin(time * 17 + e) * 0.35);
  };
  return g;
}

export function registerModels(r: ThreeRenderer): void {
  r.defineModel("gladiator", gladiator)
    .defineModel("arenamaster", arenaMaster)
    .defineModel("goblin", goblinModel)
    .defineModel("sentinel", sentinelModel)
    .defineModel("chanter", chanterModel)
    .defineModel("pickup", pickupModel)
    .defineModel("pillar", pillarModel)
    .defineModel("projectile", projectileModel);
}

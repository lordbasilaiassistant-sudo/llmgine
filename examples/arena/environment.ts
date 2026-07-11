/** The colosseum itself — floor, walls, stands, crowd, torches, embers. */
import * as THREE from "three";
import type { ThreeRenderer } from "../../src/render3d/three.js";

export function buildColosseum(r: ThreeRenderer, R: number): (time: number) => void {
  const { scene } = r;

  // lighting base
  // NOTE: light colors multiply with albedo in linear space — moody palettes
  // need HIGH intensities or everything lands at zero.
  scene.add(new THREE.AmbientLight(0x554a6a, 6));
  scene.add(new THREE.HemisphereLight(0x8a7aa8, 0x2a1f30, 5));
  const moon = new THREE.DirectionalLight(0x9db0d8, 6);
  moon.position.set(-220, 420, 160);
  moon.castShadow = true;
  moon.shadow.mapSize.set(2048, 2048);
  const S = 520;
  Object.assign(moon.shadow.camera, { left: -S, right: S, top: S, bottom: -S, far: 1200 });
  moon.shadow.camera.updateProjectionMatrix();
  moon.shadow.bias = -0.0004;
  scene.add(moon);

  // sand floor (canvas texture: rings, cracks, old blood, neural sigil)
  const floorTex = new THREE.CanvasTexture(makeFloorTexture(R));
  floorTex.colorSpace = THREE.SRGBColorSpace;
  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(R + 40, 72),
    new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.95 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  // outer dark ground
  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(2200, 32),
    new THREE.MeshStandardMaterial({ color: 0x0a070e, roughness: 1 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.5;
  scene.add(ground);

  // arena wall
  const wall = new THREE.Mesh(
    new THREE.CylinderGeometry(R + 42, R + 46, 46, 72, 1, true),
    new THREE.MeshStandardMaterial({ color: 0x241a2b, roughness: 0.85, side: THREE.DoubleSide }),
  );
  wall.position.y = 23;
  scene.add(wall);
  const trim = new THREE.Mesh(
    new THREE.TorusGeometry(R + 42, 2.2, 8, 72),
    new THREE.MeshStandardMaterial({ color: 0xd4a24e, metalness: 0.8, roughness: 0.3, emissive: 0x4a3410, emissiveIntensity: 0.4 }),
  );
  trim.rotation.x = Math.PI / 2;
  trim.position.y = 46;
  scene.add(trim);

  // stands (two stepped ring platforms — open, so they never block the camera)
  for (let row = 0; row < 2; row++) {
    const rIn = R + 100 + row * 90;
    const mat = new THREE.MeshStandardMaterial({ color: row ? 0x161020 : 0x1c1426, roughness: 0.9, side: THREE.DoubleSide });
    const side = new THREE.Mesh(new THREE.CylinderGeometry(rIn, rIn, 34, 48, 1, true), mat);
    side.position.y = 40 + row * 34;
    scene.add(side);
    const top = new THREE.Mesh(new THREE.RingGeometry(rIn, rIn + 92, 48), mat);
    top.rotation.x = -Math.PI / 2;
    top.position.y = 57 + row * 34;
    scene.add(top);
  }

  // crowd — instanced swaying heads
  const crowdN = 160;
  const crowd = new THREE.InstancedMesh(
    new THREE.SphereGeometry(6, 8, 7),
    new THREE.MeshStandardMaterial({ color: 0x241c30, roughness: 1 }),
    crowdN,
  );
  const crowdBase: Array<{ x: number; y: number; z: number; ph: number }> = [];
  const m = new THREE.Matrix4();
  for (let i = 0; i < crowdN; i++) {
    const row = i % 2;
    const a = (i / crowdN) * Math.PI * 4 + row * 0.13;
    const rr = R + 118 + row * 88 + (i % 5) * 4;
    const p = { x: Math.cos(a) * rr, y: 62 + row * 34, z: Math.sin(a) * rr, ph: (i * 2654435761) % 100 };
    crowdBase.push(p);
    m.setPosition(p.x, p.y, p.z);
    crowd.setMatrixAt(i, m);
  }
  scene.add(crowd);

  // torches
  const torches: THREE.PointLight[] = [];
  const flameMat = new THREE.SpriteMaterial({
    map: new THREE.CanvasTexture(makeFlameSprite()),
    color: 0xffb060,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const flames: THREE.Sprite[] = [];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
    const x = Math.cos(a) * (R + 30);
    const z = Math.sin(a) * (R + 30);
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(1.6, 2, 40, 8),
      new THREE.MeshStandardMaterial({ color: 0x181019, roughness: 0.9 }),
    );
    pole.position.set(x, 20, z);
    scene.add(pole);
    // physical units: intensity/d² — world units are big, so candela must be too
    const light = new THREE.PointLight(0xff9040, 26000, 300, 2);
    light.position.set(x, 46, z);
    scene.add(light);
    torches.push(light);
    const flame = new THREE.Sprite(flameMat);
    flame.scale.set(16, 22, 1);
    flame.position.set(x, 48, z);
    scene.add(flame);
    flames.push(flame);
  }

  // center sigil glow
  const sigil = new THREE.Mesh(
    new THREE.TorusGeometry(64, 1.2, 6, 48),
    new THREE.MeshStandardMaterial({ color: 0x0d3f38, emissive: 0x62d9c4, emissiveIntensity: 0.7, roughness: 0.4 }),
  );
  sigil.rotation.x = Math.PI / 2;
  sigil.position.y = 0.6;
  scene.add(sigil);

  // rising embers
  const emberN = 140;
  const emberPos = new Float32Array(emberN * 3);
  const emberSeed: number[] = [];
  for (let i = 0; i < emberN; i++) {
    emberPos[i * 3] = (Math.random() - 0.5) * R * 2;
    emberPos[i * 3 + 1] = Math.random() * 90;
    emberPos[i * 3 + 2] = (Math.random() - 0.5) * R * 2;
    emberSeed.push(Math.random());
  }
  const emberGeo = new THREE.BufferGeometry();
  emberGeo.setAttribute("position", new THREE.BufferAttribute(emberPos, 3));
  const embers = new THREE.Points(
    emberGeo,
    new THREE.PointsMaterial({ color: 0xffa050, size: 2.4, transparent: true, opacity: 0.75, blending: THREE.AdditiveBlending, depthWrite: false }),
  );
  scene.add(embers);

  // per-frame environment animation
  return (time: number) => {
    for (let i = 0; i < torches.length; i++) {
      const fl = 0.78 + Math.sin(time * 9 + i * 2.4) * 0.16 + Math.sin(time * 23 + i) * 0.06;
      torches[i].intensity = 26000 * fl;
      flames[i].scale.set(14 + fl * 5, 19 + fl * 7, 1);
    }
    (sigil.material as THREE.MeshStandardMaterial).emissiveIntensity = 0.55 + Math.sin(time * 2.2) * 0.25;
    for (let i = 0; i < emberN; i++) {
      let y = emberPos[i * 3 + 1] + (10 + emberSeed[i] * 16) * 0.016;
      if (y > 110) y = 0;
      emberPos[i * 3 + 1] = y;
      emberPos[i * 3] += Math.sin(time * 1.5 + i) * 0.08;
    }
    emberGeo.attributes.position.needsUpdate = true;
    for (let i = 0; i < crowdN; i++) {
      const p = crowdBase[i];
      m.setPosition(p.x, p.y + Math.sin(time * (1 + (p.ph % 10) / 14) + p.ph) * 2.2, p.z);
      crowd.setMatrixAt(i, m);
    }
    crowd.instanceMatrix.needsUpdate = true;
  };
}

function makeFloorTexture(R: number): HTMLCanvasElement {
  const size = 1024;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d")!;
  const k = size / ((R + 40) * 2);
  ctx.translate(size / 2, size / 2);
  let s = 97;
  const rand = () => {
    let t = (s += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const base = ctx.createRadialGradient(0, 0, 30, 0, 0, size / 2);
  base.addColorStop(0, "#4a3c50");
  base.addColorStop(0.7, "#372b40");
  base.addColorStop(1, "#241a2b");
  ctx.fillStyle = base;
  ctx.fillRect(-size / 2, -size / 2, size, size);

  // ring-segment tiles
  for (let ring = 0; ring < 7; ring++) {
    const r0 = (70 + ring * 46) * k;
    const segs = 14 + ring * 4;
    for (let seg = 0; seg < segs; seg++) {
      const a0 = (seg / segs) * Math.PI * 2 + ring * 0.21;
      const a1 = a0 + (Math.PI * 2) / segs - 0.014;
      const tone = 58 + rand() * 22;
      ctx.fillStyle = `rgb(${tone + 12},${tone - 2},${tone + 20})`;
      ctx.beginPath();
      ctx.arc(0, 0, r0 + 44 * k, a0, a1);
      ctx.arc(0, 0, r0, a1, a0, true);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = "rgba(14,10,20,0.9)";
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }
  // sand dust
  for (let i = 0; i < 900; i++) {
    ctx.fillStyle = `rgba(${180 + rand() * 40},${150 + rand() * 30},${120 + rand() * 30},${rand() * 0.05})`;
    ctx.beginPath();
    ctx.arc((rand() - 0.5) * size, (rand() - 0.5) * size, 1 + rand() * 3, 0, Math.PI * 2);
    ctx.fill();
  }
  // cracks + old blood
  ctx.strokeStyle = "rgba(10,7,14,0.8)";
  for (let i = 0; i < 16; i++) {
    let x = (rand() - 0.5) * size * 0.8;
    let y = (rand() - 0.5) * size * 0.8;
    ctx.lineWidth = 1 + rand() * 1.5;
    ctx.beginPath();
    ctx.moveTo(x, y);
    for (let kk = 0; kk < 5; kk++) {
      x += (rand() - 0.5) * 60;
      y += (rand() - 0.5) * 60;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  for (let i = 0; i < 10; i++) {
    ctx.fillStyle = `rgba(90,18,28,${0.1 + rand() * 0.14})`;
    ctx.beginPath();
    ctx.ellipse((rand() - 0.5) * size * 0.7, (rand() - 0.5) * size * 0.7, 10 + rand() * 30, 6 + rand() * 16, rand() * 3, 0, Math.PI * 2);
    ctx.fill();
  }
  // neural sigil
  ctx.strokeStyle = "rgba(98,217,196,0.5)";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(0, 0, 66 * k * 2.2, 0, Math.PI * 2);
  ctx.stroke();
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(Math.cos(a) * 20 * k * 2.2, Math.sin(a) * 20 * k * 2.2);
    ctx.lineTo(Math.cos(a) * 62 * k * 2.2, Math.sin(a) * 62 * k * 2.2);
    ctx.stroke();
  }
  return c;
}

function makeFlameSprite(): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const ctx = c.getContext("2d")!;
  const g = ctx.createRadialGradient(32, 36, 2, 32, 32, 30);
  g.addColorStop(0, "rgba(255,240,190,1)");
  g.addColorStop(0.35, "rgba(255,160,60,0.85)");
  g.addColorStop(1, "rgba(255,80,30,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  return c;
}

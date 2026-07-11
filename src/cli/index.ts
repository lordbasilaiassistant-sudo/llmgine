#!/usr/bin/env node
/**
 * llmgine CLI — `create` a new game project, `export` platform wrappers.
 *
 *   npx llmgine create my-game            # scaffold a playable starter game
 *   npx llmgine export web|windows|android|ios|pwa|store
 *
 * Export generates CONFIG + docs around your existing web build; heavy
 * toolchains (Electron, Capacitor) become devDependencies of YOUR game
 * project, never of the engine.
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const [, , cmd, ...args] = process.argv;

function write(path: string, content: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
  console.log("  + " + path);
}

function gameName(): string {
  try {
    return JSON.parse(readFileSync("package.json", "utf8")).name ?? "my-game";
  } catch {
    return "my-game";
  }
}

// ── create ──────────────────────────────────────────────────────
export function create(name: string, dir = resolve(name)): void {
  if (existsSync(join(dir, "package.json"))) throw new Error(`${dir} already has a project`);
  mkdirSync(dir, { recursive: true });
  write(join(dir, "package.json"), JSON.stringify({
    name,
    version: "0.1.0",
    private: true,
    type: "module",
    scripts: {
      build: "esbuild src/main.ts --bundle --format=esm --outfile=public/main.js",
      dev: "npm run build && npx llmgine-dev-server public",
    },
    dependencies: { llmgine: "latest" },
    devDependencies: { esbuild: "^0.28.0", typescript: "^5.6.0" },
  }, null, 2));
  write(join(dir, "tsconfig.json"), JSON.stringify({
    compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "bundler", strict: true, lib: ["ES2022", "DOM"] },
    include: ["src"],
  }, null, 2));
  write(join(dir, "public", "index.html"), `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${name}</title><style>html,body{margin:0;height:100%;background:#0d0a12;overflow:hidden}</style></head>
<body><div id="stage" style="position:fixed;inset:0"></div><script type="module" src="./main.js"></script></body></html>
`);
  write(join(dir, "src", "main.ts"), `import {
  World, GameLoop, SpatialGrid, ActionRegistry, actionSystem,
  Transform, Velocity, Named, Health, Speech, Behavior, Sprite, Collider,
  STANDARD_VERBS, behaviorSystem, movementSystem, collisionSystem, speechSystem,
  Mind, MindMemory, CognitionDriver, OpenAICompatibleProvider,
} from "llmgine";
import { ThreeRenderer } from "llmgine/render3d";

const world = new World(42);
const grid = new SpatialGrid();
const actions = new ActionRegistry();
for (const v of STANDARD_VERBS) actions.register(v);

const npc = world.create();
world.add(npc, Transform, { x: 0, y: 0 });
world.add(npc, Velocity);
world.add(npc, Collider);
world.add(npc, Sprite, { kind: "npc", color: "#62d9c4", size: 24 });
world.add(npc, Named, { name: "Wanderer" });
world.add(npc, Health);
world.add(npc, Speech);
world.add(npc, Behavior, { mode: "wander" });
world.add(npc, Mind, { persona: "A curious wanderer.", thinkEvery: 10, fallbackMode: "wander" });
world.add(npc, MindMemory);

world
  .addSystem(actionSystem(actions))
  .addSystem(behaviorSystem())
  .addSystem(movementSystem(grid, { minX: -400, minY: -400, maxX: 400, maxY: 400 }))
  .addSystem(collisionSystem(grid))
  .addSystem(speechSystem());

// give minds a brain if a key is present (see llmgine README for /dev/key)
fetch("/dev/key").then(r => r.ok ? r.json() : null).then(j => {
  if (!j?.key) return;
  const driver = new CognitionDriver({ provider: new OpenAICompatibleProvider({ apiKey: j.key }), actions, grid });
  world.addSystem(driver.system());
}).catch(() => {});

const renderer = new ThreeRenderer(document.getElementById("stage")!, {});
renderer.scene.add(new renderer.three.AmbientLight(0xffffff, 3));
renderer.scene.add(new renderer.three.HemisphereLight(0xbfd0ff, 0x202030, 3));
const ground = new renderer.three.Mesh(
  new renderer.three.CircleGeometry(500, 48),
  new renderer.three.MeshStandardMaterial({ color: 0x2a2438 }),
);
ground.rotation.x = -Math.PI / 2;
renderer.scene.add(ground);
renderer.followTarget = npc;

new GameLoop(world, { render: (a) => renderer.draw(world, a) }).start();
`);
  write(join(dir, "README.md"), `# ${name}\n\nBuilt on [llmgine](https://github.com/lordbasilaiassistant-sudo/llmgine).\n\n\`\`\`bash\nnpm install\nnpm run dev   # http://localhost:4173\nnpx llmgine export windows|android|ios|pwa|store\n\`\`\`\n`);
  console.log(`\ncreated ${name}. next: cd ${name} && npm install && npm run dev`);
}

// ── export targets ──────────────────────────────────────────────
type Exporter = (out: string, name: string) => string;

const exporters: Record<string, Exporter> = {
  web(out) {
    write(join(out, "README.md"), "# Web export\n\nYour game is already a static site: deploy the folder containing index.html + main.js to GitHub Pages, itch.io (zip it), or any static host.\n");
    return "static site — deploy your build folder anywhere (GitHub Pages / itch.io).";
  },

  windows(out, name) {
    write(join(out, "electron-main.cjs"), `const { app, BrowserWindow } = require("electron");
const path = require("path");
app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 1280, height: 720, autoHideMenuBar: true, backgroundColor: "#0d0a12" });
  win.loadFile(path.join(__dirname, "..", "public", "index.html"));
});
app.on("window-all-closed", () => app.quit());
`);
    write(join(out, "electron-builder.yml"), `appId: com.example.${name.replace(/[^a-z0-9]/gi, "")}
productName: ${name}
directories: { output: dist-desktop }
files: ["public/**/*", "export/windows/electron-main.cjs"]
extraMetadata: { main: export/windows/electron-main.cjs }
win: { target: [nsis, portable] }
linux: { target: [AppImage] }
mac: { target: [dmg] }
`);
    write(join(out, "README.md"), `# Windows / desktop export (.exe)

\`\`\`bash
npm i -D electron electron-builder
npm run build
npx electron-builder --config export/windows/electron-builder.yml --win
\`\`\`
Output: dist-desktop/ — NSIS installer + portable .exe. Add --linux / --mac for AppImage / dmg (mac build+signing needs a Mac).
`);
    return ".exe via Electron — see export/windows/README.md (2 commands).";
  },

  android(out, name) {
    return exporters.capacitor(out, name);
  },
  ios(out, name) {
    return exporters.capacitor(out, name);
  },
  capacitor(out, name) {
    const id = "com.example." + name.replace(/[^a-z0-9]/gi, "");
    write(join(out, "capacitor.config.json"), JSON.stringify({ appId: id, appName: name, webDir: "public", backgroundColor: "#0d0a12" }, null, 2));
    write(join(out, "README.md"), `# Mobile export (Android / iOS via Capacitor)

\`\`\`bash
npm i -D @capacitor/cli @capacitor/core @capacitor/android @capacitor/ios
cp export/mobile/capacitor.config.json .
npm run build
npx cap add android && npx cap sync && npx cap open android   # → .apk/.aab in Android Studio
npx cap add ios && npx cap sync && npx cap open ios           # → Xcode project
\`\`\`
Honest caveats: iOS store builds require a Mac + Apple Developer ($99/yr) — no free path (Apple's rule).
Android debug .apk is free and sideloadable today. For store-free mobile, use the PWA export instead.
`);
    return "Android .apk/.aab + iOS Xcode project via Capacitor — see export/mobile/README.md.";
  },

  pwa(out, name) {
    write(join(out, "manifest.webmanifest"), JSON.stringify({
      name, short_name: name, start_url: ".", display: "fullscreen", orientation: "landscape",
      background_color: "#0d0a12", theme_color: "#0d0a12",
      icons: [{ src: "icon-512.png", sizes: "512x512", type: "image/png" }],
    }, null, 2));
    write(join(out, "sw.js"), `const CACHE = "${name}-v1";
const ASSETS = ["./", "./index.html", "./main.js", "./manifest.webmanifest"];
self.addEventListener("install", (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS))));
self.addEventListener("activate", (e) => e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))));
self.addEventListener("fetch", (e) => e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request))));
`);
    write(join(out, "README.md"), `# PWA export — installable on iPhone/Android today, no store, free

1. Copy manifest.webmanifest + sw.js next to your index.html; add a 512px icon-512.png.
2. In index.html <head>: \`<link rel="manifest" href="manifest.webmanifest">\`
3. Before </body>: \`<script>navigator.serviceWorker?.register("sw.js")</script>\`
4. Deploy over HTTPS (GitHub Pages works). Players: Share → Add to Home Screen.
`);
    return "installable PWA (offline-capable) — copy 2 files + 2 tags, see export/pwa/README.md.";
  },

  store(out, name) {
    write(join(out, "listing.md"), `# ${name} — store listing kit

## Title (30 chars max for most stores)
${name}

## Short description (80–132 chars)
<one-sentence hook — what the player DOES and why it's alive>

## Long description
<2–4 paragraphs. Lead with the living-world hook: characters that think, see and speak.
llmgine's Genesis can draft this from your game's actual prefabs/quests.>

## Tags / genre
action, ai, <genre>, singleplayer

## Assets checklist
- [ ] icon 512x512 + 1024x1024
- [ ] 3–6 screenshots 1920x1080 (capture with renderer.capture())
- [ ] 30s trailer (optional but doubles conversion)
- [ ] content rating questionnaire answers (violence? chat? AI-generated content: YES — disclose)

## Pricing worksheet
| Storefront | Fee | Min price | Notes |
|---|---|---|---|
| itch.io | 0–10% (you choose) | $0 | fastest launch, pay-what-you-want, web builds playable in-browser |
| Steam | 30% + $100/app | $0.99 | needs Steamworks account; desktop export required |
| Google Play | 15–30% + $25 once | $0 | .aab from Capacitor export |
| Apple App Store | 15–30% + $99/yr | $0 | Mac required to build |

## AI disclosure (required on Steam & stores, 2024+)
"This game uses large language models at runtime to drive character dialogue and behavior. Content is constrained by a validated action system."
`);
    write(join(out, "store.json"), JSON.stringify({
      name, tagline: "", description: "", tags: [], price_usd: 0,
      platforms: ["web", "windows", "android", "ios"],
      ai_disclosure: "Runtime LLM-driven characters; validated action system.",
      screenshots: [], icon: "icon-512.png",
    }, null, 2));
    return "store listing kit (copy, assets checklist, pricing worksheet, AI disclosure) — export/store/.";
  },
};

// ── main ────────────────────────────────────────────────────────
export function main(): void {
  if (cmd === "create") {
    const name = args[0];
    if (!name) throw new Error("usage: llmgine create <name>");
    create(name);
  } else if (cmd === "export") {
    const target = args[0];
    if (!target || !exporters[target]) {
      throw new Error(`usage: llmgine export <${Object.keys(exporters).join("|")}>`);
    }
    const dirName = target === "android" || target === "ios" || target === "capacitor" ? "mobile" : target;
    const summary = exporters[target](join(resolve("export"), dirName), gameName());
    console.log("\n" + summary);
  } else {
    console.log(`llmgine CLI
  create <name>                     scaffold a new game project
  export web|windows|android|ios|pwa|store   generate platform wrappers + store kit`);
  }
}

// run when invoked directly (not imported by tests)
if (process.argv[1] && /cli[\\/](index|cli)\.(ts|js)$/.test(process.argv[1])) {
  try {
    main();
  } catch (err: any) {
    console.error(String(err?.message ?? err));
    process.exit(1);
  }
}

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

/** CLI is exercised as a real process against dist/ (built by the `pretest` npm script). */
const CLI = join(process.cwd(), "dist", "cli", "index.js");
if (!existsSync(CLI)) {
  // fail LOUDLY instead of silently skipping the whole suite
  throw new Error(
    "dist/cli/index.js is missing — run `npm run build` (or `npm test`, whose pretest script builds automatically)",
  );
}

describe("llmgine CLI", () => {
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "llmgine-cli-"))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("create scaffolds a runnable game project", () => {
    execFileSync("node", [CLI, "create", "testgame"], { cwd: dir });
    const root = join(dir, "testgame");
    for (const f of ["package.json", "src/main.ts", "public/index.html", "README.md"]) {
      expect(existsSync(join(root, f)), f).toBe(true);
    }
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    // running from this clone's dist → the scaffold must link back to it, not
    // to the unpublished npm name ("latest" 404s until we publish)
    expect(pkg.dependencies.llmgine).toMatch(/^file:/);
    expect(readFileSync(join(root, "src", "main.ts"), "utf8")).toContain("CognitionDriver");
  });

  it("export generates windows/pwa/store kits", () => {
    execFileSync("node", [CLI, "export", "windows"], { cwd: dir });
    execFileSync("node", [CLI, "export", "pwa"], { cwd: dir });
    execFileSync("node", [CLI, "export", "store"], { cwd: dir });
    expect(existsSync(join(dir, "export/windows/electron-builder.yml"))).toBe(true);
    expect(existsSync(join(dir, "export/windows/electron-main.cjs"))).toBe(true);
    expect(existsSync(join(dir, "export/pwa/manifest.webmanifest"))).toBe(true);
    expect(existsSync(join(dir, "export/pwa/sw.js"))).toBe(true);
    const listing = readFileSync(join(dir, "export/store/listing.md"), "utf8");
    expect(listing).toContain("AI disclosure");
    expect(listing).toContain("Pricing worksheet");
  });

  it("export mobile emits capacitor config with honest iOS caveat", () => {
    execFileSync("node", [CLI, "export", "android"], { cwd: dir });
    const cfg = JSON.parse(readFileSync(join(dir, "export/mobile/capacitor.config.json"), "utf8"));
    expect(cfg.webDir).toBe("public");
    expect(readFileSync(join(dir, "export/mobile/README.md"), "utf8")).toContain("$99/yr");
  });

  it("rejects unknown targets", () => {
    expect(() => execFileSync("node", [CLI, "export", "gamecube"], { cwd: dir })).toThrow();
  });
});

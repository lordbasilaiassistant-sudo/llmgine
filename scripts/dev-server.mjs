/**
 * Demo dev server — static files + /dev/key.
 *
 * /dev/key auto-detects a GLM key for LOCAL play only (localhost bind):
 *   1. env ZAI_API_KEY / LLM_API_KEY
 *   2. ~/.claude/secrets/zai.env (ZAI_API_KEY=...)
 *   3. .env in the repo root
 * The key never leaves your machine; production hosting has no such endpoint.
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join, extname, resolve } from "node:path";
import { homedir } from "node:os";

const root = resolve(process.argv[2] ?? "examples/arena");
const port = Number(process.env.PORT ?? 4173);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
};

function findDevKey() {
  if (process.env.ZAI_API_KEY) return process.env.ZAI_API_KEY;
  if (process.env.LLM_API_KEY) return process.env.LLM_API_KEY;
  for (const p of [
    join(homedir(), ".claude", "secrets", "zai.env"),
    resolve(".env"),
  ]) {
    if (!existsSync(p)) continue;
    const m = readFileSync(p, "utf8").match(/^\s*(?:ZAI|LLM)_API_KEY\s*=\s*(.+)\s*$/m);
    if (m) return m[1].trim();
  }
  return null;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

  if (url.pathname === "/dev/key") {
    const key = findDevKey();
    res.writeHead(key ? 200 : 404, { "content-type": "application/json" });
    res.end(JSON.stringify(key ? { key, source: "dev" } : { error: "no local key found" }));
    return;
  }

  let file = url.pathname === "/" ? "/index.html" : url.pathname;
  try {
    const data = await readFile(join(root, file));
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`demo → http://localhost:${port}  (dev key: ${findDevKey() ? "detected" : "none"})`);
});

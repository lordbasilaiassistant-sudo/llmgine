#!/usr/bin/env node
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

// ---- agent bridge -----------------------------------------------------
// Lets any local process drive a running game through its AgentPort:
//   curl -s localhost:4173/agent/call -d '{"method":"observe"}'
//   curl -s localhost:4173/agent/call -d '{"method":"act","args":["say",{"text":"hi"}]}'
// The page (connectAgentBridge in llmgine/agent) listens on /agent/sse and
// POSTs results to /agent/result. Localhost bind only — never exposed.
const sseClients = new Set();
const pendingCalls = new Map(); // id -> { resolve, timer }
let callSeq = 0;

function readBody(req) {
  return new Promise((res2) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => res2(body));
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

  if (url.pathname === "/dev/key") {
    const key = findDevKey();
    res.writeHead(key ? 200 : 404, { "content-type": "application/json" });
    res.end(JSON.stringify(key ? { key, source: "dev" } : { error: "no local key found" }));
    return;
  }

  if (url.pathname === "/agent/sse") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write(": agent bridge connected\n\n");
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
    return;
  }

  if (url.pathname === "/agent/call" && req.method === "POST") {
    let cmd;
    try {
      cmd = JSON.parse(await readBody(req));
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "invalid JSON" }));
      return;
    }
    if (!sseClients.size) {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "no game connected (open the demo in a browser first)" }));
      return;
    }
    const id = `c${++callSeq}`;
    const payload = `data: ${JSON.stringify({ id, method: cmd.method, args: cmd.args ?? [] })}\n\n`;
    const reply = await new Promise((resolveCall) => {
      const timer = setTimeout(() => {
        pendingCalls.delete(id);
        resolveCall({ error: "timeout waiting for the game (10s)" });
      }, 10_000);
      pendingCalls.set(id, { resolve: resolveCall, timer });
      for (const client of sseClients) client.write(payload);
    });
    res.writeHead(reply.error ? 502 : 200, { "content-type": "application/json" });
    res.end(JSON.stringify(reply));
    return;
  }

  if (url.pathname === "/agent/result" && req.method === "POST") {
    try {
      const { id, result, error } = JSON.parse(await readBody(req));
      const pending = pendingCalls.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        pendingCalls.delete(id);
        pending.resolve(error ? { error } : { result });
      }
    } catch {
      /* ignore malformed results */
    }
    res.writeHead(204);
    res.end();
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

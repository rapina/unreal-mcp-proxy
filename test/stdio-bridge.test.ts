import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cliPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/cli.js");

test("stdio mode auto-starts the daemon, bridges JSON-RPC, and the daemon records + outlives the shim", async (t) => {
  // Fake "editor": an upstream MCP endpoint answering JSON (GET notification channel unsupported, like a 405)
  const upstream = http.createServer(async (request, response) => {
    if (request.method !== "POST") { response.writeHead(405).end(); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const message = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { id?: number; method: string };
    if (message.id === undefined) { response.writeHead(202).end(); return; }
    response.writeHead(200, { "content-type": "application/json", "mcp-session-id": "editor-session" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { echoed: message.method } }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
  const upstreamPort = (upstream.address() as { port: number }).port;
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });

  const dataDir = await mkdtemp(path.join(os.tmpdir(), "ump-stdio-"));
  const daemonPort = 35300 + Math.floor(Math.random() * 200);
  const env = {
    ...process.env,
    UNREAL_MCP_PROXY_PORT: String(daemonPort),
    UNREAL_MCP_PROXY_DATA_DIR: dataDir,
    UNREAL_MCP_UPSTREAM_URL: `http://127.0.0.1:${upstreamPort}/mcp`,
    UNREAL_MCP_PROXY_CONFIG: ""
  };

  const shim = spawn(process.execPath, [cliPath, "--stdio"], { env, stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => shim.kill());
  const outLines: string[] = [];
  let outBuffer = "";
  shim.stdout.on("data", (chunk: Buffer) => {
    outBuffer += chunk.toString();
    const parts = outBuffer.split("\n");
    outBuffer = parts.pop() ?? "";
    outLines.push(...parts.filter(Boolean));
  });
  const waitForLine = async (count: number): Promise<void> => {
    for (let attempt = 0; attempt < 100 && outLines.length < count; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(outLines.length >= count, `expected ${count} stdout lines, got ${outLines.length}`);
  };

  // initialize round-trip (this also forces the shim to boot the daemon)
  shim.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
  await waitForLine(1);
  const initReply = JSON.parse(outLines[0]!) as { id: number; result: { echoed: string } };
  assert.equal(initReply.id, 1);
  assert.equal(initReply.result.echoed, "initialize");

  // a follow-up request reuses the same daemon
  shim.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
  await waitForLine(2);
  assert.equal((JSON.parse(outLines[1]!) as { id: number }).id, 2);

  // the daemon recorded both calls
  const health = await (await fetch(`http://127.0.0.1:${daemonPort}/health`)).json() as { session: { id: string } };
  const events = await (await fetch(`http://127.0.0.1:${daemonPort}/api/sessions/${health.session.id}/events`)).json() as {
    events: Array<{ type: string; processId?: number }>;
  };
  const started = events.events.filter((event) => event.type === "mcp_request_started");
  assert.equal(started.length, 2);

  // the daemon outlives the shim
  shim.kill();
  await new Promise((resolve) => setTimeout(resolve, 300));
  const stillUp = await (await fetch(`http://127.0.0.1:${daemonPort}/health`)).json() as { ok: boolean };
  assert.equal(stillUp.ok, true);

  // cleanup: stop the detached daemon via its recorded pid
  const daemonPid = events.events.find((event) => event.type === "proxy_started")?.processId;
  assert.ok(daemonPid);
  process.kill(daemonPid!);
});

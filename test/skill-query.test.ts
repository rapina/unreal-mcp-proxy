import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createProxyServer } from "../dist/proxy-server.js";
import { SessionStore } from "../dist/session-store.js";

const run = promisify(execFile);
const scriptPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), "../skills/unreal-mcp-observer/scripts/query.mjs"
);

async function query(dataDir: string, args: string[], proxyUrl?: string): Promise<unknown> {
  const { stdout } = await run(process.execPath, [scriptPath, ...args], {
    env: { ...process.env, UNREAL_MCP_PROXY_DATA_DIR: dataDir, ...(proxyUrl ? { UNREAL_MCP_PROXY_URL: proxyUrl } : {}) }
  });
  return JSON.parse(stdout);
}

/** Writes a fixture session with one success, one failure, and one annotation. */
async function writeFixture(dataDir: string): Promise<void> {
  const sessionsDir = path.join(dataDir, "sessions");
  await mkdir(sessionsDir, { recursive: true });
  let seq = 0;
  const event = (type: string, payload: Record<string, unknown>) => JSON.stringify({
    schemaVersion: 2, source: "unreal-mcp-proxy", sessionId: "11111111-1111-1111-1111-111111111111",
    sequence: ++seq, timestamp: new Date(1700000000000 + seq * 1000).toISOString(), type, identity: null, ...payload
  });
  const call = (callId: string, tool: string, error?: string) => [
    event("mcp_request_started", {
      callId, body: { method: "tools/call", params: { name: "call_tool", arguments: {
        toolset_name: "T.AssetTools", tool_name: tool, arguments: { assets: ["/Game/A"] }
      } } }
    }),
    event("mcp_request_completed", {
      callId, status: 200, durationMs: 100,
      body: error
        ? { result: { isError: true, content: [{ text: error }] } }
        : { result: { content: [{ text: "ok" }] } }
    })
  ];
  const lines = [
    event("session_started", { reason: "initial_start" }),
    ...call("aaaaaaaa-0000-0000-0000-000000000001", "find_assets"),
    ...call("aaaaaaaa-0000-0000-0000-000000000002", "save_assets",
      "Error: Cannot remove 'D:/Proj/Content/B_Zombie.uasset' as it is read only!"),
    event("ai_annotation", {
      callId: "aaaaaaaa-0000-0000-0000-000000000002", severity: "error",
      title: "LFS lock required", summary: "Assets are checked out read-only under Git LFS locking.",
      suggestion: "run git lfs lock before saving", author: "claude"
    })
  ];
  await writeFile(path.join(sessionsDir, "11111111-1111-1111-1111-111111111111.jsonl"), lines.join("\n") + "\n", "utf8");
}

test("recent-failures lists failed calls with error text", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "ump-skill-"));
  await writeFixture(dataDir);
  const failures = await query(dataDir, ["recent-failures"]) as Array<Record<string, unknown>>;
  assert.equal(failures.length, 1);
  assert.equal(failures[0]!.tool, "save_assets");
  assert.match(failures[0]!.error as string, /read only/);
});

test("similar-failures matches a differently-worded error and returns its annotations", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "ump-skill-"));
  await writeFixture(dataDir);
  const matches = await query(dataDir, [
    "similar-failures", "Cannot remove 'C:/Other/Path_99/X.uasset' as it is read only!"
  ]) as Array<{ similarity: number; annotations: Array<{ title: string }> }>;
  assert.ok(matches.length >= 1);
  assert.ok(matches[0]!.similarity > 0.3);
  assert.equal(matches[0]!.annotations[0]!.title, "LFS lock required");
});

test("tool-stats aggregates per tool with failure rate and percentiles", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "ump-skill-"));
  await writeFixture(dataDir);
  const stats = await query(dataDir, ["tool-stats"]) as Array<Record<string, unknown>>;
  const save = stats.find((row) => row.tool === "save_assets")!;
  assert.equal(save.calls, 1);
  assert.equal(save.failureRate, 1);
  assert.equal(save.p50, 100);
  const find = stats.find((row) => row.tool === "find_assets")!;
  assert.equal(find.failureRate, 0);
});

test("call-detail resolves a callId prefix to the full call with bodies", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "ump-skill-"));
  await writeFixture(dataDir);
  const detail = await query(dataDir, ["call-detail", "aaaaaaaa-0000-0000-0000-000000000002"]) as Record<string, unknown>;
  assert.equal(detail.tool, "save_assets");
  assert.ok(detail.request);
  assert.ok(detail.response);
});

test("sessions lists recordings with counts, link resolves a call to a deep link", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "ump-skill-"));
  await writeFixture(dataDir);
  const sessions = await query(dataDir, ["sessions"]) as Array<Record<string, unknown>>;
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]!.calls, 2);
  assert.equal(sessions[0]!.failures, 1);
  assert.match(sessions[0]!.url as string, /\/sessions\/11111111/);

  const link = await query(dataDir, ["link", "aaaaaaaa-0000-0000-0000-000000000002"]) as { url: string; tool: string };
  assert.equal(link.tool, "save_assets");
  assert.match(link.url, /\/sessions\/11111111-1111-1111-1111-111111111111\?call=aaaaaaaa-0000-0000-0000-000000000002$/);
});

test("status reports recorder reachability and recorded history, clear rolls the session", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "ump-skill-live2-"));
  const store = new SessionStore(dataDir, "http://observer.test");
  await store.initialize();
  const proxy = createProxyServer({
    listenHost: "127.0.0.1", listenPort: 0, upstreamUrl: "http://127.0.0.1:1/mcp",
    dataDir, webBaseUrl: "http://observer.test",
    redaction: { headers: [], jsonKeys: [], maxBodyBytes: 65536 },
    sinks: [], baseDir: process.cwd()
  }, store);
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", () => resolve()));
  const port = (proxy.address() as { port: number }).port;
  t.after(() => proxy.close());
  const proxyUrl = `http://127.0.0.1:${port}`;

  const status = await query(dataDir, ["status"], proxyUrl) as {
    proxy: { ok: boolean; session: { id: string } }; recorded: { sessions: number };
  };
  assert.equal(status.proxy.ok, true);
  assert.equal(status.proxy.session.id, store.session!.id);

  const before = store.session!.id;
  const cleared = await query(dataDir, ["clear"], proxyUrl) as { previous: { id: string }; current: { id: string } };
  assert.equal(cleared.previous.id, before);
  assert.notEqual(cleared.current.id, before);

  const down = await query(dataDir, ["status"], "http://127.0.0.1:1") as { proxy: { ok: boolean } };
  assert.equal(down.proxy.ok, false); // degrades gracefully when the proxy is not running
});

test("annotate posts to the running proxy and the annotation is recalled by similar-failures", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "ump-skill-live-"));
  const store = new SessionStore(dataDir, "http://observer.test");
  await store.initialize();
  await store.append("mcp_request_started", {
    callId: "bbbbbbbb-0000-0000-0000-000000000001",
    body: { method: "tools/call", params: { name: "call_tool", arguments: { toolset_name: "T.SceneTools", tool_name: "spawn_actor", arguments: {} } } }
  });
  await store.append("mcp_request_completed", {
    callId: "bbbbbbbb-0000-0000-0000-000000000001", status: 200, durationMs: 5,
    body: { result: { isError: true, content: [{ text: "Unknown class BP_Missing_7" }] } }
  });
  const proxy = createProxyServer({
    listenHost: "127.0.0.1", listenPort: 0, upstreamUrl: "http://127.0.0.1:1/mcp",
    dataDir, webBaseUrl: "http://observer.test",
    redaction: { headers: [], jsonKeys: [], maxBodyBytes: 65536 },
    sinks: [], baseDir: process.cwd()
  }, store);
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", () => resolve()));
  const port = (proxy.address() as { port: number }).port;
  t.after(() => proxy.close());

  const result = await query(dataDir, [
    "annotate", "bbbbbbbb-0000-0000-0000-000000000001",
    "--title", "Class path typo", "--summary", "The blueprint class path was misspelled.",
    "--severity", "error"
  ], `http://127.0.0.1:${port}`) as { status: number };
  assert.equal(result.status, 201);

  const matches = await query(dataDir, ["similar-failures", "Unknown class BP_Other_3"]) as Array<{ annotations: Array<{ title: string }> }>;
  assert.equal(matches[0]!.annotations[0]!.title, "Class path typo");
});

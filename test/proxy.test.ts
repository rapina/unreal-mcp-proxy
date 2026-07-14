import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
// Tests exercise the built output - `npm test` runs the build first.
import { createProxyServer } from "../dist/proxy-server.js";
import { SessionStore } from "../dist/session-store.js";
import type { ProxyConfig } from "../dist/config.js";

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return (server.address() as { port: number }).port;
}

const baseConfig = (upstreamPort = 1): ProxyConfig => ({
  listenHost: "127.0.0.1", listenPort: 0,
  upstreamUrl: `http://127.0.0.1:${upstreamPort}/mcp`,
  dataDir: "", webBaseUrl: "http://observer.test",
  redaction: { headers: ["authorization"], jsonKeys: ["token"], maxBodyBytes: 65536 }
});

test("proxy preserves the MCP response and records redacted events", async (t) => {
  const upstream = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    assert.equal(Number(request.headers["content-length"]), Buffer.concat(chunks).length);
    assert.ok(request.headers["x-observability-call-id"]);
    response.writeHead(200, { "content-type": "application/json", "mcp-session-id": "upstream-session" });
    response.end(Buffer.concat(chunks));
  });
  const upstreamPort = await listen(upstream);
  t.after(() => upstream.close());

  const dataDir = await mkdtemp(path.join(os.tmpdir(), "ump-proxy-"));
  const store = new SessionStore(dataDir, "http://observer.test");
  await store.initialize();
  const proxy = createProxyServer(baseConfig(upstreamPort), store);
  const proxyPort = await listen(proxy);
  t.after(() => proxy.close());

  const response = await fetch(`http://127.0.0.1:${proxyPort}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer hidden",
      "x-observability-source": "agent-validation"
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", token: "hidden" })
  });
  assert.equal(response.headers.get("mcp-session-id"), "upstream-session");
  assert.equal(((await response.json()) as { method: string }).method, "tools/list");

  const events = await store.readEvents();
  const started = events.find((event) => event.type === "mcp_request_started")!;
  const completed = events.find((event) => event.type === "mcp_request_completed")!;
  assert.equal(started.source, "unreal-mcp-proxy");
  assert.equal(started.clientSource, "agent-validation");
  assert.equal((started.headers as Record<string, string>).authorization, "[REDACTED]");
  assert.equal((started.body as Record<string, string>).token, "[REDACTED]");
  assert.equal(completed.status, 200);
});

test("only an explicit clear rotates the observation session", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "ump-session-"));
  const first = new SessionStore(dataDir, "http://observer.test");
  await first.initialize();
  const originalId = first.session!.id;

  const restarted = new SessionStore(dataDir, "http://observer.test");
  await restarted.initialize();
  assert.equal(restarted.session!.id, originalId);

  const result = await restarted.clear();
  assert.equal(result.previous.id, originalId);
  assert.notEqual(result.current.id, originalId);
});

test("serves the session model API, annotations, and the viewer page", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "ump-api-"));
  const store = new SessionStore(dataDir, "http://observer.test");
  await store.initialize();
  await store.append("mcp_request_started", { callId: "call-ui", method: "POST", body: { method: "tools/list" } });
  await store.append("mcp_request_completed", { callId: "call-ui", status: 200, durationMs: 5, body: { result: { tools: [] } } });

  const viewerPath = path.join(dataDir, "viewer.html");
  await writeFile(viewerPath, "<!DOCTYPE html><title>viewer</title>", "utf8");
  const proxy = createProxyServer(baseConfig(), store, { viewerPath });
  const port = await listen(proxy);
  t.after(() => proxy.close());

  const page = await fetch(`http://127.0.0.1:${port}/sessions/${store.session!.id}?call=abc`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /viewer/);

  const model = await (await fetch(`http://127.0.0.1:${port}/api/sessions/${store.session!.id}`)).json() as {
    calls: Array<{ title: string; annotations: Array<{ title: string }> }>;
  };
  assert.equal(model.calls[0]!.title, "List tools");

  const annotationResponse = await fetch(`http://127.0.0.1:${port}/api/sessions/${store.session!.id}/annotations`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ callId: "call-ui", title: "Needs review", summary: "Tool list came back empty." })
  });
  assert.equal(annotationResponse.status, 201);
  const updated = await (await fetch(`http://127.0.0.1:${port}/api/sessions/${store.session!.id}`)).json() as {
    calls: Array<{ annotations: Array<{ title: string }> }>;
  };
  assert.equal(updated.calls[0]!.annotations[0]!.title, "Needs review");
});

test("returns 503 for the viewer when it is not built", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "ump-noviewer-"));
  const store = new SessionStore(dataDir, "http://observer.test");
  await store.initialize();
  const proxy = createProxyServer(baseConfig(), store);
  const port = await listen(proxy);
  t.after(() => proxy.close());
  const response = await fetch(`http://127.0.0.1:${port}/viewer`);
  assert.equal(response.status, 503);
});

test("streams session changes over SSE", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "ump-stream-"));
  const store = new SessionStore(dataDir, "http://observer.test");
  await store.initialize();
  const proxy = createProxyServer(baseConfig(), store);
  const port = await listen(proxy);
  t.after(() => proxy.close());
  const controller = new AbortController();
  t.after(() => controller.abort());
  const response = await fetch(`http://127.0.0.1:${port}/api/sessions/${store.session!.id}/stream`, { signal: controller.signal });
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  assert.match(decoder.decode((await reader.read()).value), /event: connected/);
  await store.append("test_changed", { callId: "call-stream" });
  const changed = decoder.decode((await reader.read()).value);
  assert.match(changed, /event: changed/);
  assert.match(changed, /call-stream/);
  await reader.cancel();
});

test("ends the downstream response at the final SSE result without waiting for keep-alive", async (t) => {
  const upstream = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream", connection: "keep-alive" });
    response.write('event: message\r\ndata: {"jsonrpc":"2.0","id":7,"result":{"content":[{"type":"text","text":"ok"}]}}\r\n\r\n');
    setTimeout(() => response.end(), 1500).unref();
  });
  const upstreamPort = await listen(upstream);
  t.after(() => upstream.close());
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "ump-sse-"));
  const store = new SessionStore(dataDir, "http://observer.test");
  await store.initialize();
  const proxy = createProxyServer(baseConfig(upstreamPort), store);
  const proxyPort = await listen(proxy);
  t.after(() => proxy.close());

  const started = performance.now();
  const response = await fetch(`http://127.0.0.1:${proxyPort}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "call_tool", arguments: {} } })
  });
  const body = await response.text();
  const elapsed = performance.now() - started;
  assert.match(body, /"id":7/);
  assert.ok(elapsed < 500, `proxy took ${elapsed}ms`);
  const events = await store.readEvents();
  const completed = events.find((event) => event.type === "mcp_request_completed")!;
  assert.equal(completed.completionReason, "final_sse_event");
  assert.ok((completed.durationMs as number) < 500);
});

test("event sinks attached via subscribe are awaited and cannot break recording", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "ump-sink-"));
  const store = new SessionStore(dataDir, "http://observer.test", { source: "henneth", identity: { user: "yhj" } });
  await store.initialize();
  const seen: string[] = [];
  store.subscribe(async (event) => { seen.push(event.type); });
  store.subscribe(() => { throw new Error("bad sink"); });
  const event = await store.append("custom_event", { callId: "c1" });
  assert.equal(event.source, "henneth");
  assert.deepEqual(event.identity, { user: "yhj" });
  assert.ok(seen.includes("custom_event"));
  assert.deepEqual((await store.readEvents()).at(-1)?.type, "custom_event");
});

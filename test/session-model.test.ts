import assert from "node:assert/strict";
import test from "node:test";
import { buildSessionModel, normalizeError } from "../dist/session-model.js";
import type { SessionEvent } from "../dist/types.js";

let seq = 0;
const event = (type: string, payload: Record<string, unknown>): SessionEvent => ({
  schemaVersion: 2, source: "unreal-mcp-proxy", sessionId: "s-1", sequence: ++seq,
  timestamp: new Date(1700000000000 + seq * 1000).toISOString(), type, identity: null, ...payload
} as SessionEvent);

const callPair = (callId: string, tool: string, options: { error?: boolean; toolset?: string; target?: string } = {}): SessionEvent[] => [
  event("mcp_request_started", {
    callId, method: "POST",
    body: { method: "tools/call", id: seq + 1, params: { name: "call_tool", arguments: {
      toolset_name: options.toolset ?? "editor_toolset.toolsets.scene.SceneTools",
      tool_name: tool,
      arguments: options.target ? { actor: { refPath: options.target } } : {}
    } } }
  }),
  event("mcp_request_completed", {
    callId, status: 200, durationMs: 100,
    body: options.error
      ? { result: { isError: true, content: [{ text: "Error: boom" }] } }
      : { result: { content: [{ text: "ok" }] } }
  })
];

test("labels Unreal call_tool invocations as Toolset.tool and extracts arguments", () => {
  seq = 0;
  const model = buildSessionModel("s-1", callPair("c1", "find_actors"), "http://x");
  const call = model.calls[0]!;
  assert.equal(call.title, "SceneTools.find_actors");
  assert.equal(call.toolName, "find_actors");
  assert.equal(call.toolsetName, "editor_toolset.toolsets.scene.SceneTools");
  assert.equal(call.outcome, "success");
  assert.equal(call.deepLink, "http://x/sessions/s-1?call=c1");
});

test("classifies connection and discovery calls as system calls", () => {
  seq = 0;
  const events = [
    event("mcp_request_started", { callId: "c1", body: { method: "initialize" } }),
    event("mcp_request_completed", { callId: "c1", status: 200, durationMs: 5, body: {} }),
    event("mcp_request_started", { callId: "c2", body: { method: "tools/call", params: { name: "list_toolsets" } } }),
    event("mcp_request_completed", { callId: "c2", status: 200, durationMs: 5, body: {} })
  ];
  const model = buildSessionModel("s-1", events, "http://x");
  assert.equal(model.summary.totalCalls, 0);
  assert.equal(model.summary.systemCalls, 2);
  assert.equal(model.calls.find((call) => call.id === "c1")?.title, "MCP initialize");
  assert.equal(model.calls.find((call) => call.id === "c2")?.title, "List Unreal toolsets");
});

test("marks unfinished calls as running with a live duration", () => {
  seq = 0;
  const events = [callPair("c1", "find_actors")[0]!];
  const now = new Date(events[0]!.timestamp).getTime() + 5000;
  const model = buildSessionModel("s-1", events, "http://x", now);
  const call = model.calls[0]!;
  assert.equal(call.outcome, "running");
  assert.equal(call.durationMs, 5000);
});

test("classifies HTTP and JSON-RPC failures as errors", () => {
  seq = 0;
  const events = [
    ...callPair("c1", "save_assets", { error: true }),
    event("mcp_request_started", { callId: "c2", body: { method: "tools/call", params: { name: "call_tool", arguments: { toolset_name: "T.X", tool_name: "y", arguments: {} } } } }),
    event("mcp_request_failed", { callId: "c2", durationMs: 10, error: "socket hang up" })
  ];
  const model = buildSessionModel("s-1", events, "http://x");
  assert.equal(model.summary.errors, 2);
  assert.equal(model.calls.find((call) => call.id === "c2")?.error, "socket hang up");
});

test("reuses one graph node for repeated calls and makes target actors their own node", () => {
  seq = 0;
  const events = [
    ...callPair("c1", "find_actors"),
    ...callPair("c2", "find_actors"),
    ...callPair("c3", "get_actor_transform", { target: "/Game/Map.Map:PersistentLevel.Actor_1" })
  ];
  const model = buildSessionModel("s-1", events, "http://x");
  assert.equal(model.graph.nodes.length, 2);
  const toolNode = model.graph.nodes[0]!;
  assert.deepEqual(toolNode.callIds, ["c1", "c2"]);
  const targetNode = model.graph.nodes[1]!;
  assert.equal(targetNode.kind, "target");
  assert.equal(targetNode.label, "Actor_1");
  assert.deepEqual(model.graph.edges.map((edge) => edge.order), [1, 2, 3]);
});

test("attaches annotations to their call, latest per author", () => {
  seq = 0;
  const events = [
    ...callPair("c1", "save_assets", { error: true }),
    event("ai_annotation", { callId: "c1", severity: "error", title: "first", summary: "s", author: "agent" }),
    event("ai_annotation", { callId: "c1", severity: "error", title: "second", summary: "s", author: "agent" })
  ];
  const model = buildSessionModel("s-1", events, "http://x");
  const call = model.calls.find((item) => item.id === "c1")!;
  assert.equal(call.annotations.length, 1);
  assert.equal(call.annotations[0]!.title, "second");
});

test("normalizeError masks paths, uuids, hex and numbers", () => {
  const norm = normalizeError("Cannot remove 'D:\\proj\\A_1.uasset' (id 3f1c2e04-6a52-4b0f-9c66-8f6f6f0a1d2e) code 0xC0 after 12 tries")!;
  assert.ok(norm.includes("<path>"));
  assert.ok(norm.includes("<uuid>"));
  assert.ok(norm.includes("<hex>"));
  assert.ok(!/\d/.test(norm.replace(/<n>/g, "")));
});

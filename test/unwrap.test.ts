import assert from "node:assert/strict";
import test from "node:test";
// The viewer bundle is browser code, but unwrap is pure logic - test it directly.
import { unwrapRequest, unwrapResponse } from "../viewer/src/unwrap.ts";

test("unwraps call_tool requests down to the actual tool arguments", () => {
  const body = {
    jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "call_tool", arguments: {
      toolset_name: "T.BlueprintComponentTools", tool_name: "add_component",
      arguments: { name: "ZombieMesh", parent_name: "SourceManny" }
    } }
  };
  const { view, changed } = unwrapRequest(body);
  assert.ok(changed);
  assert.deepEqual(view, { name: "ZombieMesh", parent_name: "SourceManny" });
});

test("unwraps direct tool call requests to their arguments", () => {
  const { view, changed } = unwrapRequest({
    method: "tools/call", params: { name: "list_toolsets", arguments: { filter: "a" } }
  });
  assert.ok(changed);
  assert.deepEqual(view, { filter: "a" });
});

test("leaves non-tools/call requests untouched", () => {
  assert.equal(unwrapRequest({ method: "initialize", params: {} }).changed, false);
  assert.equal(unwrapRequest("plain").changed, false);
});

test("picks the final result from an SSE bundle and parses escaped JSON text", () => {
  const body = {
    transport: "sse",
    events: [
      { method: "notifications/progress" },
      { id: 2, jsonrpc: "2.0", result: { content: [
        { type: "text", text: "{\"returnValue\":{\"refPath\":\"/Game/X.X_C:Mesh\"}}" }
      ] } }
    ]
  };
  const { view, changed } = unwrapResponse(body);
  assert.ok(changed);
  assert.deepEqual(view, { returnValue: { refPath: "/Game/X.X_C:Mesh" } });
});

test("keeps non-JSON content text as-is", () => {
  const { view } = unwrapResponse({ result: { content: [{ type: "text", text: "plain ok" }] } });
  assert.equal(view, "plain ok");
});

test("unwraps error responses to the error object", () => {
  const { view } = unwrapResponse({ error: { code: -32000, message: "boom" } });
  assert.deepEqual(view, { code: -32000, message: "boom" });
});

test("returns multiple content items as an array", () => {
  const { view } = unwrapResponse({ result: { content: [
    { type: "text", text: "{\"a\":1}" }, { type: "text", text: "note" }
  ] } });
  assert.deepEqual(view, [{ a: 1 }, "note"]);
});

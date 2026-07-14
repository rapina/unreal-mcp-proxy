import assert from "node:assert/strict";
import test from "node:test";
import { redactHeaders, redactValue, summarizeBody } from "../dist/redaction.js";

const options = { headers: ["authorization"], jsonKeys: ["token", "password"], maxBodyBytes: 1024 };

test("redacts sensitive headers and nested JSON keys", () => {
  const headers = redactHeaders({ Authorization: "Bearer x", host: "h" }, options.headers);
  assert.equal(headers.Authorization, "[REDACTED]");
  assert.equal(headers.host, "h");
  const value = redactValue({ params: { token: "t", nested: [{ password: "p" }] }, safe: 1 }, options.jsonKeys) as {
    params: { token: string; nested: Array<{ password: string }> }; safe: number;
  };
  assert.equal(value.params.token, "[REDACTED]");
  assert.equal(value.params.nested[0]!.password, "[REDACTED]");
  assert.equal(value.safe, 1);
});

test("summarizes SSE bodies into structured event lists", () => {
  const sse = Buffer.from('event: message\ndata: {"id":1,"result":{"ok":true},"token":"x"}\n\n');
  const summary = summarizeBody(sse, "text/event-stream", options) as { transport: string; events: Array<Record<string, unknown>> };
  assert.equal(summary.transport, "sse");
  assert.equal(summary.events[0]!.token, "[REDACTED]");
});

test("marks oversized and non-JSON bodies as omitted", () => {
  const big = summarizeBody(Buffer.alloc(2048, 120), "application/json", options) as { omitted: boolean; reason: string };
  assert.equal(big.reason, "body_too_large");
  const binary = summarizeBody(Buffer.from("blob"), "application/octet-stream", options) as { omitted: boolean; reason: string };
  assert.equal(binary.reason, "non_json");
});

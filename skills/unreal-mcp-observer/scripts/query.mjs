#!/usr/bin/env node
// Zero-dependency query CLI over recorded unreal-mcp-proxy sessions.
// Usage: node query.mjs <recent-failures|similar-failures|call-detail|tool-stats|annotate> [args]
// Env:   UNREAL_MCP_PROXY_DATA_DIR (default ./data), UNREAL_MCP_PROXY_URL (default http://127.0.0.1:35100)

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const dataDir = path.resolve(process.env.UNREAL_MCP_PROXY_DATA_DIR ?? "./data");
const proxyUrl = (process.env.UNREAL_MCP_PROXY_URL ?? "http://127.0.0.1:35100").replace(/\/$/, "");
const [command, ...rest] = process.argv.slice(2);

const flags = {};
const positional = [];
for (let index = 0; index < rest.length; index += 1) {
  const arg = rest[index];
  if (arg.startsWith("--")) { flags[arg.slice(2)] = rest[index + 1]; index += 1; }
  else positional.push(arg);
}

async function loadSessions() {
  const sessionsDir = path.join(dataDir, "sessions");
  let files = [];
  try { files = (await readdir(sessionsDir)).filter((name) => name.endsWith(".jsonl")); }
  catch { fail(`no sessions directory at ${sessionsDir} (set UNREAL_MCP_PROXY_DATA_DIR)`); }
  const sessions = [];
  for (const file of files) {
    const text = await readFile(path.join(sessionsDir, file), "utf8");
    const events = text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    sessions.push({ sessionId: file.replace(/\.jsonl$/, ""), events });
  }
  return sessions;
}

function toolOf(startedEvent) {
  const body = startedEvent?.body;
  const params = body?.params;
  if (body?.method !== "tools/call") return { tool: body?.method ?? "mcp", toolset: null, args: null };
  if (params?.name === "call_tool") {
    return {
      tool: params.arguments?.tool_name ?? "unknown",
      toolset: params.arguments?.toolset_name ?? null,
      args: params.arguments?.arguments ?? null
    };
  }
  return { tool: params?.name ?? "unknown", toolset: null, args: params?.arguments ?? null };
}

function errorOf(event) {
  if (event.type === "mcp_request_failed") return event.error ?? "connection failed";
  if ((event.status ?? 0) >= 400) return `HTTP ${event.status}`;
  const messages = event.body?.transport === "sse" ? event.body.events ?? [] : [event.body];
  for (const message of messages) {
    if (message?.error) return message.error.message ?? "MCP error";
    if (message?.result?.isError) {
      const text = (message.result.content ?? []).map((item) => item?.text ?? "").join("\n").trim();
      return text.slice(0, 500) || "tool returned isError";
    }
  }
  return null;
}

function buildCalls(sessions) {
  const calls = [];
  for (const { sessionId, events } of sessions) {
    const started = new Map();
    const annotations = events.filter((event) => event.type === "ai_annotation");
    for (const event of events) {
      if (event.type === "mcp_request_started") started.set(event.callId, event);
      if (event.type === "mcp_request_completed" || event.type === "mcp_request_failed") {
        const begin = started.get(event.callId);
        const { tool, toolset, args } = toolOf(begin);
        calls.push({
          callId: event.callId, sessionId, tool, toolset, arguments: args,
          startedAt: begin?.timestamp ?? event.timestamp, durationMs: event.durationMs ?? null,
          status: event.type === "mcp_request_failed" ? "failed" : "completed",
          error: errorOf(event),
          request: begin?.body ?? null, response: event.body ?? null,
          annotations: annotations.filter((note) => note.callId === event.callId)
            .map(({ severity, title, summary, cause, suggestion, author }) => ({ severity, title, summary, cause, suggestion, author }))
        });
      }
    }
  }
  return calls.sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
}

function normalize(text) {
  return (text ?? "").toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>")
    .replace(/[a-z]:\\[^\s"'`]+/g, "<path>")
    .replace(/(?:\/[\w.-]+){2,}/g, "<path>")
    .replace(/0x[0-9a-f]+/g, "<hex>")
    .replace(/\d+/g, "<n>")
    .replace(/\s+/g, " ").trim();
}

function similarity(a, b) {
  const tokens = (text) => new Set(text.split(/[^a-z<>]+/).filter((token) => token.length > 2));
  const setA = tokens(a), setB = tokens(b);
  if (!setA.size || !setB.size) return 0;
  let shared = 0;
  for (const token of setA) if (setB.has(token)) shared += 1;
  return (2 * shared) / (setA.size + setB.size);
}

const out = (value) => console.log(JSON.stringify(value, null, 1));
const fail = (message) => { console.error(message); process.exit(1); };
const limit = Number(flags.limit ?? 10);

switch (command) {
  case "recent-failures": {
    const calls = buildCalls(await loadSessions());
    out(calls.filter((call) => call.error)
      .slice(0, limit)
      .map(({ request, response, arguments: _args, ...call }) => call));
    break;
  }
  case "similar-failures": {
    const query = positional.join(" ");
    if (!query) fail("usage: similar-failures <error text>");
    const norm = normalize(query);
    const calls = buildCalls(await loadSessions()).filter((call) => call.error);
    const matches = calls
      .map((call) => ({ score: similarity(norm, normalize(call.error)), call }))
      .filter((match) => match.score > 0.3)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ score, call: { request, response, arguments: _args, ...call } }) => ({ similarity: Math.round(score * 100) / 100, ...call }));
    out(matches);
    break;
  }
  case "call-detail": {
    const callId = positional[0];
    if (!callId) fail("usage: call-detail <callId>");
    const call = buildCalls(await loadSessions()).find((item) => item.callId.startsWith(callId));
    out(call ?? { error: "not_found" });
    break;
  }
  case "tool-stats": {
    const filterTool = positional[0];
    const calls = buildCalls(await loadSessions()).filter((call) => !filterTool || call.tool === filterTool);
    const byTool = new Map();
    for (const call of calls) {
      const stats = byTool.get(call.tool) ?? { tool: call.tool, toolset: call.toolset, calls: 0, failed: 0, durations: [] };
      stats.calls += 1;
      if (call.error) stats.failed += 1;
      if (call.durationMs != null) stats.durations.push(call.durationMs);
      byTool.set(call.tool, stats);
    }
    out([...byTool.values()]
      .sort((a, b) => b.calls - a.calls)
      .map(({ durations, ...stats }) => {
        const sorted = [...durations].sort((a, b) => a - b);
        const at = (q) => sorted.length ? Math.round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]) : null;
        return { ...stats, failureRate: stats.calls ? Math.round((stats.failed / stats.calls) * 1000) / 1000 : 0, p50: at(0.5), p95: at(0.95) };
      }));
    break;
  }
  case "annotate": {
    const callId = positional[0];
    if (!callId || !flags.title || !flags.summary) {
      fail("usage: annotate <callId> --title <t> --summary <s> [--severity info|warn|error] [--cause <c>] [--suggestion <s>] [--author <a>]");
    }
    const session = await (await fetch(`${proxyUrl}/api/session`)).json();
    const response = await fetch(`${proxyUrl}/api/sessions/${session.id}/annotations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        callId, severity: flags.severity ?? "info", title: flags.title, summary: flags.summary,
        cause: flags.cause, suggestion: flags.suggestion, author: flags.author ?? "agent"
      })
    });
    out({ status: response.status, ...(await response.json()) });
    break;
  }
  default:
    fail("usage: query.mjs <recent-failures|similar-failures|call-detail|tool-stats|annotate> [args] [--limit N]");
}

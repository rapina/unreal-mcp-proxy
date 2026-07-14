import type { JsonValue } from "../../src/types.js";

/**
 * Strips MCP transport wrapping so the default view shows what matters:
 * - request: the actual tool arguments (call_tool nests them 3 levels deep)
 * - response: the final result of the SSE stream, with escaped JSON text parsed
 * The RAW toggle shows the original body.
 */

type AnyRecord = Record<string, unknown>;
const isRecord = (value: unknown): value is AnyRecord =>
  !!value && typeof value === "object" && !Array.isArray(value);

export interface Unwrapped {
  view: unknown;
  changed: boolean;
}

export function unwrapRequest(body: unknown): Unwrapped {
  if (!isRecord(body)) return { view: body, changed: false };
  if (body.method !== "tools/call" || !isRecord(body.params)) return { view: body, changed: false };
  const params = body.params;
  const args = isRecord(params.arguments) ? params.arguments : null;
  if (params.name === "call_tool" && args) {
    return { view: args.arguments ?? {}, changed: true };
  }
  return { view: args ?? params, changed: true };
}

export function unwrapResponse(body: unknown): Unwrapped {
  if (!isRecord(body)) return { view: body, changed: false };
  const messages: unknown[] = body.transport === "sse" && Array.isArray(body.events) ? body.events : [body];
  let final: AnyRecord | null = null;
  for (const message of messages) {
    if (isRecord(message) && (message.result !== undefined || message.error !== undefined)) final = message;
  }
  if (!final) return { view: body, changed: false };
  if (final.error !== undefined) return { view: final.error, changed: true };
  const result = final.result;
  if (!isRecord(result)) return { view: result, changed: true };
  const content = result.content;
  if (!Array.isArray(content) || !content.length) return { view: result, changed: true };
  const parsed = content.map((item) =>
    isRecord(item) && typeof item.text === "string" ? parseMaybeJson(item.text) : item);
  return { view: parsed.length === 1 ? parsed[0] : parsed, changed: true };
}

function parseMaybeJson(text: string): JsonValue {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try { return JSON.parse(trimmed) as JsonValue; } catch { /* keep original */ }
  }
  return text;
}

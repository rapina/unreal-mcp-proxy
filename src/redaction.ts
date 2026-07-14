import type { BodySummary, JsonValue } from "./types.js";

const REDACTED = "[REDACTED]";

export interface RedactionConfig {
  headers: string[];
  jsonKeys: string[];
  maxBodyBytes: number;
}

export function redactHeaders(
  headers: Record<string, string | string[] | undefined>, names: string[]
): Record<string, string | string[] | undefined> {
  const blocked = new Set(names.map((name) => name.toLowerCase()));
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [
    key,
    blocked.has(key.toLowerCase()) ? REDACTED : value
  ]));
}

export function redactValue(value: JsonValue, keys: string[]): JsonValue {
  const blocked = new Set(keys.map((key) => key.toLowerCase()));
  const visit = (item: JsonValue): JsonValue => {
    if (Array.isArray(item)) return item.map(visit);
    if (!item || typeof item !== "object") return item;
    return Object.fromEntries(Object.entries(item).map(([key, child]) => [
      key,
      blocked.has(key.toLowerCase()) ? REDACTED : visit(child)
    ]));
  };
  return visit(value);
}

/** Summarize a request/response body for recording: parse JSON, unpack SSE frames, redact secrets. */
export function summarizeBody(buffer: Buffer, contentType: string | undefined, options: RedactionConfig): BodySummary | null {
  if (!buffer.length) return null;
  if (buffer.length > options.maxBodyBytes) {
    return { omitted: true, reason: "body_too_large", size: buffer.length };
  }
  if (contentType?.includes("text/event-stream")) {
    const events = buffer.toString("utf8").split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .filter(Boolean)
      .map((data): JsonValue => {
        try { return redactValue(JSON.parse(data) as JsonValue, options.jsonKeys); }
        catch { return { omitted: true, reason: "invalid_sse_json" }; }
      });
    return { transport: "sse", events };
  }
  if (!contentType?.includes("application/json")) {
    return { omitted: true, reason: "non_json", size: buffer.length };
  }
  try {
    return redactValue(JSON.parse(buffer.toString("utf8")) as JsonValue, options.jsonKeys);
  } catch {
    return { omitted: true, reason: "invalid_json", size: buffer.length };
  }
}

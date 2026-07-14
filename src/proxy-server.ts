import http, { type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Transform, type TransformCallback } from "node:stream";
import { readFile } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import type { ProxyConfig } from "./config.js";
import type { SessionStore } from "./session-store.js";
import type { BodySummary } from "./types.js";
import { redactHeaders, summarizeBody, type RedactionConfig } from "./redaction.js";
import { buildSessionModel } from "./session-model.js";

export interface ProxyServerOptions {
  /** Path to the built single-file viewer HTML. Served at /sessions/{id} and /viewer. */
  viewerPath?: string;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const data = Buffer.from(JSON.stringify(body));
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": data.length });
  response.end(data);
}

async function readJson(request: IncomingMessage, maxBytes = 65536): Promise<Record<string, unknown>> {
  const body = await collect(request);
  if (body.length > maxBytes) throw new Error("request_too_large");
  return JSON.parse(body.toString("utf8")) as Record<string, unknown>;
}

async function collect(stream: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

class BodyCapture {
  private size = 0;
  private readonly chunks: Buffer[] = [];
  constructor(private readonly limit: number) {}
  add(chunk: Buffer): void {
    this.size += chunk.length;
    if (this.size <= this.limit) this.chunks.push(Buffer.from(chunk));
  }
  summary(contentType: string | undefined, options: RedactionConfig): BodySummary | null {
    if (this.size > this.limit) return { omitted: true, reason: "body_too_large", size: this.size };
    return summarizeBody(Buffer.concat(this.chunks), contentType, options);
  }
}

class PassThroughCapture extends Transform {
  private size = 0;
  private readonly chunks: Buffer[] = [];
  constructor(private readonly limit: number) { super(); }
  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.size += chunk.length;
    if (this.size <= this.limit) this.chunks.push(Buffer.from(chunk));
    callback(null, chunk);
  }
  summary(contentType: string | undefined, options: RedactionConfig): BodySummary | null {
    if (this.size > this.limit) return { omitted: true, reason: "body_too_large", size: this.size };
    return summarizeBody(Buffer.concat(this.chunks), contentType, options);
  }
}

/**
 * Unreal's MCP HTTP server may keep a tools/call SSE connection open until its keep-alive
 * expires, long after the final result event arrived. Without this, every call appears to
 * take ~15s. We end the downstream response as soon as the final JSON-RPC result/error for
 * the request id is observed.
 */
function relayUntilFinalSse(
  upstreamResponse: IncomingMessage, response: ServerResponse, requestId: unknown, limit: number
): Promise<BodyCapture> {
  return new Promise((resolve, reject) => {
    const capture = new BodyCapture(limit);
    const decoder = new StringDecoder("utf8");
    let pending = "";
    let finished = false;

    const finish = () => {
      if (finished) return;
      finished = true;
      response.end();
      upstreamResponse.destroy();
      resolve(capture);
    };
    const fail = (error: Error) => {
      if (finished) return;
      finished = true;
      reject(error);
    };
    const inspectEvents = () => {
      const blocks = pending.split(/\r?\n\r?\n/);
      pending = blocks.pop() ?? "";
      for (const block of blocks) {
        const data = block.split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (!data) continue;
        try {
          const message = JSON.parse(data) as Record<string, unknown>;
          const sameRequest = String(message.id) === String(requestId);
          if (sameRequest && (Object.hasOwn(message, "result") || Object.hasOwn(message, "error"))) {
            finish();
            return;
          }
        } catch { /* partial frame */ }
      }
    };

    upstreamResponse.on("data", (chunk: Buffer) => {
      if (finished) return;
      capture.add(chunk);
      response.write(chunk);
      pending += decoder.write(chunk);
      inspectEvents();
    });
    upstreamResponse.on("end", () => {
      if (finished) return;
      pending += decoder.end();
      pending += "\n\n";
      inspectEvents();
      if (!finished) fail(new Error("SSE stream ended without a final JSON-RPC result"));
    });
    upstreamResponse.on("error", fail);
    response.on("close", () => {
      if (!finished) {
        upstreamResponse.destroy();
        fail(new Error("Downstream connection closed before the final SSE result"));
      }
    });
  });
}

export function createProxyServer(config: ProxyConfig, store: SessionStore, options: ProxyServerOptions = {}): Server {
  const upstream = new URL(config.upstreamUrl);
  let viewerHtml: Buffer | null = null;

  const serveViewer = async (response: ServerResponse): Promise<void> => {
    if (!viewerHtml && options.viewerPath) {
      try { viewerHtml = await readFile(options.viewerPath); } catch { /* not built */ }
    }
    if (!viewerHtml) {
      return sendJson(response, 503, { error: "viewer_not_built", message: "run `npm run build` or download viewer.html from the release" });
    }
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src data:"
    });
    response.end(viewerHtml);
  };

  return http.createServer(async (request, response) => {
    const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
    const { pathname } = requestUrl;
    if (pathname === "/health" && request.method === "GET") {
      return sendJson(response, 200, { ok: true, session: store.describe(), upstream: config.upstreamUrl });
    }
    if (pathname === "/api/session" && request.method === "GET") {
      return sendJson(response, 200, store.describe());
    }
    if (pathname === "/api/session/clear" && request.method === "POST") {
      return sendJson(response, 200, await store.clear());
    }
    {
      const match = pathname.match(/^\/api\/sessions\/([0-9a-f-]+)\/stream$/i);
      if (match && request.method === "GET") {
        response.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          "connection": "keep-alive",
          "x-accel-buffering": "no"
        });
        response.write(`event: connected\ndata: ${JSON.stringify({ sessionId: match[1] })}\n\n`);
        const unsubscribe = store.subscribe((event) => {
          if (event.sessionId !== match[1]) return;
          response.write(`event: changed\nid: ${event.sequence}\ndata: ${JSON.stringify({ sequence: event.sequence, type: event.type, callId: event.callId ?? null })}\n\n`);
        });
        const heartbeat = setInterval(() => response.write(": keepalive\n\n"), 15000);
        heartbeat.unref();
        request.on("close", () => { clearInterval(heartbeat); unsubscribe(); });
        return;
      }
    }
    {
      const match = pathname.match(/^\/api\/sessions\/([0-9a-f-]+)$/i);
      if (match && request.method === "GET") {
        const events = await store.readEvents(match[1]);
        return sendJson(response, 200, buildSessionModel(match[1]!, events, config.webBaseUrl));
      }
    }
    {
      const match = pathname.match(/^\/api\/sessions\/([0-9a-f-]+)\/events$/i);
      if (match && request.method === "GET") {
        return sendJson(response, 200, { sessionId: match[1], events: await store.readEvents(match[1]) });
      }
    }
    {
      const match = pathname.match(/^\/api\/sessions\/([0-9a-f-]+)\/annotations$/i);
      if (match && request.method === "POST") {
        try {
          if (match[1] !== store.session?.id) return sendJson(response, 409, { error: "session_not_active" });
          const annotation = await readJson(request);
          if (!annotation.callId || !annotation.title || !annotation.summary) {
            return sendJson(response, 400, { error: "callId, title, summary are required" });
          }
          const event = await store.append("ai_annotation", {
            callId: annotation.callId,
            severity: annotation.severity ?? "info",
            title: annotation.title,
            summary: annotation.summary,
            cause: annotation.cause,
            suggestion: annotation.suggestion,
            author: annotation.author ?? "agent"
          });
          return sendJson(response, 201, event);
        } catch (error) {
          return sendJson(response, 400, { error: (error as Error).message });
        }
      }
    }
    if ((pathname === "/viewer" || /^\/sessions\/[0-9a-f-]+$/i.test(pathname)) && request.method === "GET") {
      return serveViewer(response);
    }
    if (pathname !== "/mcp") return sendJson(response, 404, { error: "not_found" });

    // GET /mcp is the streamable-HTTP notification channel, not a call - pipe it without recording.
    if (request.method === "GET" || request.method === "DELETE") {
      const passthrough = http.request(upstream, {
        method: request.method,
        headers: { ...request.headers, host: upstream.host }
      }, (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      });
      passthrough.on("error", (error) => {
        if (!response.headersSent) sendJson(response, 502, { error: "upstream_unavailable", message: error.message });
        else response.destroy(error);
      });
      request.pipe(passthrough);
      return;
    }

    // ---- transparent MCP forwarding with recording ----
    const callId = randomUUID();
    const started = performance.now();
    const requestBody = await collect(request);
    const requestSummary = summarizeBody(requestBody, request.headers["content-type"], config.redaction);
    await store.append("mcp_request_started", {
      callId,
      clientSource: request.headers["x-observability-source"] ?? "agent",
      operationId: request.headers["x-observability-operation-id"],
      operationTitle: typeof request.headers["x-observability-operation-title"] === "string"
        ? decodeURIComponent(request.headers["x-observability-operation-title"])
        : undefined,
      operationStep: request.headers["x-observability-operation-step"],
      method: request.method,
      headers: redactHeaders(request.headers, config.redaction.headers),
      body: requestSummary
    });

    const headers: Record<string, string | string[] | undefined> = { ...request.headers, host: upstream.host };
    headers["x-observability-session-id"] = store.session!.id;
    headers["x-observability-call-id"] = callId;
    headers["content-length"] = String(requestBody.length);

    const upstreamRequest = http.request(upstream, { method: request.method, headers });
    let settled = false;
    upstreamRequest.on("response", async (upstreamResponse) => {
      const responseHeadersMs = Math.round((performance.now() - started) * 100) / 100;
      const contentType = upstreamResponse.headers["content-type"] ?? "";
      const summaryRecord = requestSummary && typeof requestSummary === "object" && !Array.isArray(requestSummary)
        ? requestSummary as Record<string, unknown> : null;
      const finalizableSse = summaryRecord?.method === "tools/call" && contentType.includes("text/event-stream");
      const downstreamHeaders = { ...upstreamResponse.headers };
      if (finalizableSse) {
        delete downstreamHeaders.connection;
        delete downstreamHeaders["content-length"];
        delete downstreamHeaders["transfer-encoding"];
      }
      response.writeHead(upstreamResponse.statusCode ?? 502, downstreamHeaders);
      try {
        let capture: BodyCapture | PassThroughCapture;
        if (finalizableSse) {
          capture = await relayUntilFinalSse(upstreamResponse, response, summaryRecord?.id, config.redaction.maxBodyBytes);
        } else {
          const passThrough = new PassThroughCapture(config.redaction.maxBodyBytes);
          await pipeline(upstreamResponse, passThrough, response);
          capture = passThrough;
        }
        settled = true;
        const resultEventMs = Math.round((performance.now() - started) * 100) / 100;
        await store.append("mcp_request_completed", {
          callId,
          status: upstreamResponse.statusCode,
          durationMs: resultEventMs,
          responseHeadersMs,
          resultEventMs,
          completionReason: finalizableSse ? "final_sse_event" : "stream_end",
          headers: redactHeaders(upstreamResponse.headers, config.redaction.headers),
          body: capture.summary(contentType, config.redaction)
        });
      } catch (error) {
        settled = true;
        await store.append("mcp_request_failed", { callId, error: (error as Error).message });
      }
    });
    upstreamRequest.on("error", async (error) => {
      if (settled) return;
      settled = true;
      await store.append("mcp_request_failed", {
        callId,
        durationMs: Math.round((performance.now() - started) * 100) / 100,
        error: error.message
      });
      if (!response.headersSent) sendJson(response, 502, { error: "upstream_unavailable", message: error.message });
      else response.destroy(error);
    });
    upstreamRequest.end(requestBody);
  });
}

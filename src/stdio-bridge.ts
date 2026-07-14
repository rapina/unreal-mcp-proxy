import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import type { ProxyConfig } from "./config.js";

/**
 * stdio mode (`unreal-mcp-proxy --stdio`): lets an MCP client auto-start everything.
 * Registered as a stdio server in the client config, this thin shim
 *   1. ensures the HTTP proxy daemon is running (spawns it detached if the port is closed),
 *   2. bridges newline-delimited JSON-RPC on stdio to the daemon's /mcp endpoint.
 * The daemon owns recording and the viewer, and outlives the client session.
 * All shim logging goes to stderr - stdout is the protocol channel.
 */

const log = (message: string): void => void process.stderr.write(`[unreal-mcp-proxy] ${message}\n`);

async function healthy(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(500) });
    return response.ok;
  } catch { return false; }
}

export async function ensureDaemon(config: ProxyConfig): Promise<string> {
  const baseUrl = `http://127.0.0.1:${config.listenPort}`;
  if (await healthy(baseUrl)) return baseUrl;
  const cliPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "cli.js");
  log(`starting proxy daemon on port ${config.listenPort}`);
  spawn(process.execPath, [cliPath], {
    detached: true,
    stdio: "ignore",
    env: process.env,
    windowsHide: true
  }).unref();
  for (let attempt = 0; attempt < 25; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    if (await healthy(baseUrl)) {
      log(`daemon ready: ${baseUrl}`);
      return baseUrl;
    }
  }
  throw new Error(`proxy daemon did not become healthy on ${baseUrl}`);
}

interface JsonRpcMessage {
  id?: unknown;
  method?: string;
}

export async function runStdioBridge(config: ProxyConfig): Promise<void> {
  const baseUrl = await ensureDaemon(config);
  const endpoint = `${baseUrl}/mcp`;
  let mcpSessionId: string | null = null;
  let notificationStreamStarted = false;

  const writeOut = (payload: unknown): void => void process.stdout.write(`${JSON.stringify(payload)}\n`);

  /** Server→client notifications (e.g. tools/listChanged) arrive on a GET SSE stream. */
  const startNotificationStream = async (): Promise<void> => {
    if (notificationStreamStarted || !mcpSessionId) return;
    notificationStreamStarted = true;
    try {
      const response = await fetch(endpoint, {
        method: "GET",
        headers: { accept: "text/event-stream", "mcp-session-id": mcpSessionId }
      });
      if (!response.ok || !response.body) return;
      let pending = "";
      const decoder = new TextDecoder();
      for await (const chunk of response.body) {
        pending += decoder.decode(chunk as Uint8Array, { stream: true });
        const blocks = pending.split(/\r?\n\r?\n/);
        pending = blocks.pop() ?? "";
        for (const block of blocks) emitSseBlock(block, writeOut);
      }
    } catch { /* optional channel - the editor may not support a standalone GET stream */ }
  };

  const rl = createInterface({ input: process.stdin, terminal: false });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let message: JsonRpcMessage;
    try { message = JSON.parse(trimmed) as JsonRpcMessage; } catch { continue; }
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...(mcpSessionId ? { "mcp-session-id": mcpSessionId } : {})
        },
        body: trimmed
      });
      const sessionHeader = response.headers.get("mcp-session-id");
      if (sessionHeader) mcpSessionId = sessionHeader;
      if (message.method === "initialize") void startNotificationStream();

      if (message.id === undefined) { void response.arrayBuffer(); continue; } // notification: no reply
      const contentType = response.headers.get("content-type") ?? "";
      const text = await response.text();
      if (contentType.includes("text/event-stream")) {
        for (const block of text.split(/\r?\n\r?\n/)) emitSseBlock(block, writeOut);
      } else if (text.trim()) {
        writeOut(JSON.parse(text));
      } else {
        writeOut({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: `empty response (HTTP ${response.status})` } });
      }
    } catch (error) {
      if (message.id !== undefined) {
        writeOut({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: (error as Error).message } });
      }
    }
  }
}

function emitSseBlock(block: string, writeOut: (payload: unknown) => void): void {
  const data = block.split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (!data) return;
  try { writeOut(JSON.parse(data)); } catch { /* keep-alive or partial frame */ }
}

#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { SessionStore } from "./session-store.js";
import { createProxyServer } from "./proxy-server.js";
import { loadSinks, closeSinks } from "./sinks.js";

const config = await loadConfig();
const store = new SessionStore(config.dataDir, config.webBaseUrl);
await store.initialize();
const sinks = await loadSinks(store, config, (message) => console.log(message));

const viewerPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "viewer.html");
const server = createProxyServer(config, store, { viewerPath });

server.listen(config.listenPort, config.listenHost, async () => {
  await store.append("proxy_started", {
    listenUrl: `http://${config.listenHost}:${config.listenPort}/mcp`,
    upstreamUrl: config.upstreamUrl,
    processId: process.pid
  });
  console.log(`unreal-mcp-proxy listening: http://${config.listenHost}:${config.listenPort}/mcp -> ${config.upstreamUrl}`);
  console.log(`session: ${store.describe().url}`);
});

async function shutdown(signal: string): Promise<void> {
  await store.append("proxy_stopping", { signal });
  await closeSinks(sinks);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

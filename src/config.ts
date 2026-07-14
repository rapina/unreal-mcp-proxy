import { readFile } from "node:fs/promises";
import path from "node:path";
import type { RedactionConfig } from "./redaction.js";

export interface ProxyConfig {
  listenHost: string;
  listenPort: number;
  upstreamUrl: string;
  dataDir: string;
  webBaseUrl: string;
  redaction: RedactionConfig;
}

const defaults: ProxyConfig = {
  listenHost: "127.0.0.1",
  listenPort: 35100,
  // Epic's Unreal MCP default: UnrealEditor -ModelContextProtocolStartServer (port 35000)
  upstreamUrl: "http://127.0.0.1:35000/mcp",
  dataDir: "./data",
  webBaseUrl: "",
  redaction: {
    headers: ["authorization", "cookie", "set-cookie", "x-api-key"],
    jsonKeys: ["token", "password", "secret", "apiKey", "authorization"],
    maxBodyBytes: 262144
  }
};

function merge(base: Record<string, unknown>, override: Record<string, unknown> | undefined): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override ?? {})) {
    if (value === undefined) continue;
    const current = result[key];
    result[key] = value && typeof value === "object" && !Array.isArray(value)
      ? merge((current ?? {}) as Record<string, unknown>, value as Record<string, unknown>)
      : value;
  }
  return result;
}

export async function loadConfig(configPath = process.env.UNREAL_MCP_PROXY_CONFIG): Promise<ProxyConfig> {
  let config: ProxyConfig = defaults;
  if (configPath) {
    config = merge(config as unknown as Record<string, unknown>, JSON.parse(await readFile(configPath, "utf8"))) as unknown as ProxyConfig;
  }
  config = merge(config as unknown as Record<string, unknown>, {
    listenHost: process.env.UNREAL_MCP_PROXY_HOST,
    listenPort: process.env.UNREAL_MCP_PROXY_PORT ? Number(process.env.UNREAL_MCP_PROXY_PORT) : undefined,
    upstreamUrl: process.env.UNREAL_MCP_UPSTREAM_URL,
    dataDir: process.env.UNREAL_MCP_PROXY_DATA_DIR,
    webBaseUrl: process.env.UNREAL_MCP_PROXY_WEB_BASE_URL
  }) as unknown as ProxyConfig;
  config.dataDir = path.resolve(config.dataDir);
  if (!config.webBaseUrl) config.webBaseUrl = `http://127.0.0.1:${config.listenPort}`;
  return config;
}

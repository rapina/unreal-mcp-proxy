import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../dist/config.js";

const ENV_KEYS = [
  "UNREAL_MCP_PROXY_CONFIG", "UNREAL_MCP_PROXY_HOST", "UNREAL_MCP_PROXY_PORT",
  "UNREAL_MCP_UPSTREAM_URL", "UNREAL_MCP_PROXY_DATA_DIR", "UNREAL_MCP_PROXY_WEB_BASE_URL",
  "UNREAL_MCP_PROXY_SINKS"
];

function withCleanEnv(t: { after(fn: () => void): void }): void {
  const saved = ENV_KEYS.map((key) => [key, process.env[key]] as const);
  for (const key of ENV_KEYS) delete process.env[key];
  t.after(() => { for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}

test("defaults target Epic's Unreal MCP on 35000 and listen on 35100", async (t) => {
  withCleanEnv(t);
  const config = await loadConfig(undefined);
  assert.equal(config.listenPort, 35100);
  assert.equal(config.upstreamUrl, "http://127.0.0.1:35000/mcp");
  assert.equal(config.webBaseUrl, "http://127.0.0.1:35100");
  assert.ok(path.isAbsolute(config.dataDir));
  assert.ok(config.redaction.headers.includes("authorization"));
});

test("config file overrides defaults, environment overrides the file", async (t) => {
  withCleanEnv(t);
  const dir = await mkdtemp(path.join(os.tmpdir(), "ump-config-"));
  const configPath = path.join(dir, "config.json");
  await writeFile(configPath, JSON.stringify({
    listenPort: 40000,
    upstreamUrl: "http://127.0.0.1:41000/mcp",
    redaction: { jsonKeys: ["customSecret"] }
  }), "utf8");
  process.env.UNREAL_MCP_PROXY_PORT = "42000";
  const config = await loadConfig(configPath);
  assert.equal(config.listenPort, 42000);                       // env wins
  assert.equal(config.upstreamUrl, "http://127.0.0.1:41000/mcp"); // file wins over default
  assert.deepEqual(config.redaction.jsonKeys, ["customSecret"]);  // nested merge
  assert.ok(config.redaction.headers.length > 0);                 // sibling keys keep defaults
  assert.equal(config.webBaseUrl, "http://127.0.0.1:42000");      // derived from final port
});

test("missing config file warns and falls back to defaults", async (t) => {
  withCleanEnv(t);
  const missingPath = path.join(os.tmpdir(), "ump-config-missing", "does-not-exist.json");
  const config = await loadConfig(missingPath);
  assert.equal(config.listenPort, 35100);
  assert.equal(config.upstreamUrl, "http://127.0.0.1:35000/mcp");
  assert.deepEqual(config.sinks, []);
});

test("malformed config file still fails fast", async (t) => {
  withCleanEnv(t);
  const dir = await mkdtemp(path.join(os.tmpdir(), "ump-config-bad-"));
  const configPath = path.join(dir, "config.json");
  await writeFile(configPath, "{ not json", "utf8");
  await assert.rejects(loadConfig(configPath), SyntaxError);
});

test("sinks come from config or env, and baseDir tracks the config file", async (t) => {
  withCleanEnv(t);
  const dir = await mkdtemp(path.join(os.tmpdir(), "ump-config-sinks-"));
  const configPath = path.join(dir, "config.json");
  await writeFile(configPath, JSON.stringify({ sinks: ["./team-sink.mjs"] }), "utf8");
  const fromFile = await loadConfig(configPath);
  assert.deepEqual(fromFile.sinks, ["./team-sink.mjs"]);
  assert.equal(fromFile.baseDir, dir); // relative sink paths resolve next to the config file

  process.env.UNREAL_MCP_PROXY_SINKS = "./a.mjs, ./b.mjs";
  const fromEnv = await loadConfig(configPath);
  assert.deepEqual(fromEnv.sinks, ["./a.mjs", "./b.mjs"]); // env wins

  delete process.env.UNREAL_MCP_PROXY_SINKS;
  const bare = await loadConfig(undefined);
  assert.deepEqual(bare.sinks, []);
  assert.equal(bare.baseDir, process.cwd());
});

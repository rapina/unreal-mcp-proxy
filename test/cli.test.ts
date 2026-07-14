import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cliPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/cli.js");

test("the packaged CLI boots, records its startup, and serves health + viewer", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "ump-cli-"));
  const port = 35190 + Math.floor(Math.random() * 100);
  const child = spawn(process.execPath, [cliPath], {
    env: {
      ...process.env,
      UNREAL_MCP_PROXY_PORT: String(port),
      UNREAL_MCP_PROXY_DATA_DIR: dataDir,
      UNREAL_MCP_PROXY_CONFIG: ""
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  t.after(() => child.kill());

  // Wait for the listen line (up to 5s)
  const booted = await new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => resolve(false), 5000);
    child.stdout.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("listening")) { clearTimeout(timeout); resolve(true); }
    });
    child.on("exit", () => { clearTimeout(timeout); resolve(false); });
  });
  assert.ok(booted, "CLI did not print its listen line");

  const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json() as {
    ok: boolean; session: { id: string };
  };
  assert.equal(health.ok, true);
  assert.ok(health.session.id);

  // viewer.html is built by `npm test`'s build step, so served mode must work
  const viewer = await fetch(`http://127.0.0.1:${port}/viewer`);
  assert.equal(viewer.status, 200);
  assert.match(await viewer.text(), /UNREAL MCP PROXY/);

  // startup itself is recorded as an event
  const events = await (await fetch(`http://127.0.0.1:${port}/api/sessions/${health.session.id}/events`)).json() as {
    events: Array<{ type: string }>;
  };
  assert.ok(events.events.some((event) => event.type === "proxy_started"));
});

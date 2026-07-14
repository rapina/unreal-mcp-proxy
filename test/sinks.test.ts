import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionStore } from "../dist/session-store.js";
import { loadSinks, closeSinks, type SinkSpec } from "../dist/sinks.js";
import type { ProxyConfig } from "../dist/config.js";

const config = (baseDir: string, sinks: SinkSpec[]): ProxyConfig => ({
  listenHost: "127.0.0.1", listenPort: 35100, upstreamUrl: "http://127.0.0.1:35000/mcp",
  dataDir: baseDir, webBaseUrl: "http://observer.test",
  redaction: { headers: [], jsonKeys: [], maxBodyBytes: 65536 },
  sinks, baseDir
});

test("a config-listed sink receives every event in order and closes on shutdown", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ump-sink-"));
  const outPath = path.join(dir, "sink-out.jsonl").replaceAll("\\", "\\\\");
  await writeFile(path.join(dir, "test-sink.mjs"), `
    import { appendFileSync } from "node:fs";
    export default function createSink({ config, log }) {
      log("test sink ready");
      return {
        onEvent(event) { appendFileSync("${outPath}", event.type + "\\n"); },
        close() { appendFileSync("${outPath}", "CLOSED\\n"); }
      };
    }
  `, "utf8");

  const store = new SessionStore(dir, "http://observer.test");
  await store.initialize();
  const logs: string[] = [];
  const sinks = await loadSinks(store, config(dir, ["./test-sink.mjs"]), (message: string) => logs.push(message));
  assert.equal(sinks.length, 1);
  assert.ok(logs.some((line) => line.includes("test sink ready")));

  await store.append("mcp_request_started", { callId: "c1" });
  await store.append("mcp_request_completed", { callId: "c1", status: 200 });
  await closeSinks(sinks);
  await store.append("after_close", {});

  const lines = (await readFile(path.join(dir, "sink-out.jsonl"), "utf8")).trim().split("\n");
  assert.deepEqual(lines, ["mcp_request_started", "mcp_request_completed", "CLOSED"]); // unsubscribed after close
});

test("sink options from the config entry are injected into the factory", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ump-sink-options-"));
  const outPath = path.join(dir, "options-out.json").replaceAll("\\", "\\\\");
  await writeFile(path.join(dir, "options-sink.mjs"), `
    import { writeFileSync } from "node:fs";
    export default function createSink({ options }) {
      writeFileSync("${outPath}", JSON.stringify(options));
      return { onEvent() {} };
    }
  `, "utf8");
  const store = new SessionStore(dir, "http://observer.test");
  await store.initialize();
  const sinks = await loadSinks(store, config(dir, [
    { module: "./options-sink.mjs", options: { url: "https://collector.internal", token: "t-1", batchSize: 50 } }
  ]), () => {});
  const injected = JSON.parse(await readFile(path.join(dir, "options-out.json"), "utf8"));
  assert.deepEqual(injected, { url: "https://collector.internal", token: "t-1", batchSize: 50 });
  await closeSinks(sinks);
});

test("a sink that throws per event never breaks recording", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ump-sink-throw-"));
  await writeFile(path.join(dir, "bad-sink.mjs"), `
    export default () => ({ onEvent() { throw new Error("collector down"); } });
  `, "utf8");
  const store = new SessionStore(dir, "http://observer.test");
  await store.initialize();
  const sinks = await loadSinks(store, config(dir, ["./bad-sink.mjs"]), () => {});
  const event = await store.append("mcp_request_started", { callId: "c1" });
  assert.equal(event.type, "mcp_request_started");
  assert.equal((await store.readEvents()).at(-1)?.type, "mcp_request_started");
  await closeSinks(sinks);
});

test("a sink that fails to load fails startup with a clear error", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ump-sink-load-"));
  await writeFile(path.join(dir, "not-a-factory.mjs"), "export default 42;\n", "utf8");
  const store = new SessionStore(dir, "http://observer.test");
  await store.initialize();
  await assert.rejects(
    loadSinks(store, config(dir, ["./not-a-factory.mjs"]), () => {}),
    /failed to load sink/
  );
  await assert.rejects(
    loadSinks(store, config(dir, ["./missing.mjs"]), () => {}),
    /failed to load sink/
  );
});

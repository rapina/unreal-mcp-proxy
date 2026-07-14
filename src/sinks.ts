import { pathToFileURL } from "node:url";
import path from "node:path";
import type { ProxyConfig } from "./config.js";
import type { SessionStore } from "./session-store.js";
import type { SessionEvent } from "./types.js";

/**
 * Event sinks: forward recorded events somewhere else (a team server, a message queue,
 * a log shipper) without touching the proxy core. A sink is an ES module listed in the
 * config, either as a plain path or with injected options:
 *
 *   "sinks": [
 *     "./my-sink.mjs",
 *     { "module": "@myteam/collector-sink", "options": { "url": "https://...", "token": "..." } }
 *   ]
 *
 * `module` may be a relative path (resolved against the config file's directory), an
 * absolute path, or a bare npm specifier. The default export is a factory:
 *
 *   export default function createSink({ config, options, log }) {
 *     return {
 *       onEvent(event) { ... },          // awaited; errors are swallowed per-event
 *       async close() { ... }            // optional; called on shutdown
 *     };
 *   }
 *
 * Recording locally always comes first: a sink that throws never breaks recording.
 * A sink that fails to LOAD, however, fails startup - a misconfigured monitoring
 * pipeline should be visible, not silent.
 */

export type SinkSpec = string | { module: string; options?: unknown };

export interface SinkContext {
  config: ProxyConfig;
  /** The `options` value from this sink's config entry (undefined for plain-path entries). */
  options: unknown;
  log: (message: string) => void;
}

export interface Sink {
  onEvent: (event: SessionEvent) => void | Promise<void>;
  close?: () => void | Promise<void>;
}

export type SinkFactory = (context: SinkContext) => Sink | Promise<Sink>;

export interface AttachedSink {
  modulePath: string;
  sink: Sink;
  unsubscribe: () => void;
}

function resolveSpecifier(module: string, baseDir: string): string {
  if (module.startsWith("./") || module.startsWith("../")) {
    return pathToFileURL(path.resolve(baseDir, module)).href;
  }
  if (path.isAbsolute(module)) return pathToFileURL(module).href;
  return module; // bare specifier: an npm package (e.g. a team-published sink)
}

export async function loadSinks(store: SessionStore, config: ProxyConfig, log: (message: string) => void): Promise<AttachedSink[]> {
  const attached: AttachedSink[] = [];
  for (const spec of config.sinks) {
    const { module, options } = typeof spec === "string" ? { module: spec, options: undefined } : spec;
    const specifier = resolveSpecifier(module, config.baseDir);
    let factory: SinkFactory;
    try {
      const loaded = await import(specifier) as { default?: SinkFactory };
      if (typeof loaded.default !== "function") throw new Error("default export is not a sink factory function");
      factory = loaded.default;
    } catch (error) {
      throw new Error(`failed to load sink "${module}": ${(error as Error).message}`);
    }
    const sink = await factory({ config, options, log });
    const unsubscribe = store.subscribe((event) => sink.onEvent(event));
    attached.push({ modulePath: module, sink, unsubscribe });
    log(`sink attached: ${module}`);
  }
  return attached;
}

export async function closeSinks(sinks: AttachedSink[]): Promise<void> {
  for (const { sink, unsubscribe } of sinks) {
    unsubscribe();
    try { await sink.close?.(); } catch { /* shutdown must not fail on a sink */ }
  }
}

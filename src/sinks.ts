import { pathToFileURL } from "node:url";
import path from "node:path";
import type { ProxyConfig } from "./config.js";
import type { SessionStore } from "./session-store.js";
import type { SessionEvent } from "./types.js";

/**
 * Event sinks: forward recorded events somewhere else (a team server, a message queue,
 * a log shipper) without touching the proxy core. A sink is an ES module listed in the
 * config (`sinks: ["./my-sink.mjs"]`); its default export is a factory:
 *
 *   export default function createSink({ config, log }) {
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

export interface SinkContext {
  config: ProxyConfig;
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

export async function loadSinks(store: SessionStore, config: ProxyConfig, log: (message: string) => void): Promise<AttachedSink[]> {
  const attached: AttachedSink[] = [];
  for (const modulePath of config.sinks) {
    const resolved = path.isAbsolute(modulePath) ? modulePath : path.resolve(config.baseDir, modulePath);
    let factory: SinkFactory;
    try {
      const module = await import(pathToFileURL(resolved).href) as { default?: SinkFactory };
      if (typeof module.default !== "function") throw new Error("default export is not a sink factory function");
      factory = module.default;
    } catch (error) {
      throw new Error(`failed to load sink "${modulePath}": ${(error as Error).message}`);
    }
    const sink = await factory({ config, log });
    const unsubscribe = store.subscribe((event) => sink.onEvent(event));
    attached.push({ modulePath: resolved, sink, unsubscribe });
    log(`sink attached: ${resolved}`);
  }
  return attached;
}

export async function closeSinks(sinks: AttachedSink[]): Promise<void> {
  for (const { sink, unsubscribe } of sinks) {
    unsubscribe();
    try { await sink.close?.(); } catch { /* shutdown must not fail on a sink */ }
  }
}

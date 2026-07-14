/** Library entry: embed the recorder or write custom sinks against these APIs. */
export { loadConfig, type ProxyConfig } from "./config.js";
export { SessionStore, type SessionStoreOptions, type EventListener } from "./session-store.js";
export { createProxyServer, type ProxyServerOptions } from "./proxy-server.js";
export { buildSessionModel, normalizeError } from "./session-model.js";
export { loadSinks, closeSinks, type Sink, type SinkFactory, type SinkContext } from "./sinks.js";
export { redactHeaders, redactValue, summarizeBody, type RedactionConfig } from "./redaction.js";
export type * from "./types.js";

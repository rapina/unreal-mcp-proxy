import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";
import type { ActiveSession, JsonObject, SessionEvent } from "./types.js";

export type EventListener = (event: SessionEvent) => void | Promise<void>;

export interface SessionStoreOptions {
  /** Envelope source tag. Defaults to "unreal-mcp-proxy". */
  source?: string;
  /** Optional metadata stamped on every event (user/machine/project). */
  identity?: JsonObject | null;
  now?: () => Date;
}

/**
 * Append-only JSONL session store.
 * An observation session survives proxy and Unreal Editor restarts; it only rolls over
 * when the user explicitly clears it. Event sinks attach via subscribe() and are awaited,
 * so a sink can persist events durably in the same write chain.
 */
export class SessionStore {
  readonly dataDir: string;
  readonly sessionsDir: string;
  private readonly activePath: string;
  private readonly webBaseUrl: string;
  private readonly source: string;
  private readonly identity: JsonObject | null;
  private readonly now: () => Date;
  session: ActiveSession | null = null;
  private writeChain: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<EventListener>();

  constructor(dataDir: string, webBaseUrl: string, options: SessionStoreOptions = {}) {
    this.dataDir = dataDir;
    this.webBaseUrl = webBaseUrl.replace(/\/$/, "");
    this.source = options.source ?? "unreal-mcp-proxy";
    this.identity = options.identity ?? null;
    this.now = options.now ?? (() => new Date());
    this.activePath = path.join(dataDir, "active-session.json");
    this.sessionsDir = path.join(dataDir, "sessions");
  }

  async initialize(): Promise<ActiveSession> {
    await mkdir(this.sessionsDir, { recursive: true });
    try {
      this.session = JSON.parse(await readFile(this.activePath, "utf8")) as ActiveSession;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.createSession("initial_start");
    }
    return this.session!;
  }

  async createSession(reason = "user_clear"): Promise<ActiveSession & { url: string }> {
    this.session = { id: randomUUID(), createdAt: this.now().toISOString(), reason, sequence: 0 };
    await this.persistActive();
    await this.append("session_started", { reason });
    return this.describe();
  }

  describe(): ActiveSession & { url: string } {
    return { ...this.session!, url: `${this.webBaseUrl}/sessions/${this.session!.id}` };
  }

  async clear(): Promise<{ previous: ActiveSession & { url: string }; current: ActiveSession & { url: string } }> {
    const previous = this.describe();
    await this.append("session_closed", { reason: "user_clear" });
    const current = await this.createSession("user_clear");
    return { previous, current };
  }

  async append(type: string, payload: Record<string, unknown> = {}): Promise<SessionEvent> {
    return this.withWriteLock(async () => {
      const session = this.session!;
      const event: SessionEvent = {
        ...payload,
        schemaVersion: 2,
        source: this.source,
        sessionId: session.id,
        sequence: ++session.sequence,
        timestamp: this.now().toISOString(),
        type,
        identity: this.identity
      };
      await appendFile(this.eventPath(session.id), `${JSON.stringify(event)}\n`, "utf8");
      await this.persistActive();
      for (const listener of this.listeners) {
        try { await listener(event); } catch { /* a sink must never break recording */ }
      }
      return event;
    });
  }

  withWriteLock<T>(action: () => Promise<T>): Promise<T> {
    const result = this.writeChain.then(action);
    this.writeChain = result.catch(() => {});
    return result;
  }

  /** Attach an event sink. Listeners are awaited inside the write chain. Returns an unsubscribe fn. */
  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  eventPath(sessionId: string): string {
    return path.join(this.sessionsDir, `${sessionId}.jsonl`);
  }

  async readEvents(sessionId: string = this.session!.id): Promise<SessionEvent[]> {
    try {
      const text = await readFile(this.eventPath(sessionId), "utf8");
      return text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as SessionEvent);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  private async persistActive(): Promise<void> {
    const temporaryPath = `${this.activePath}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(this.session, null, 2), "utf8");
    await rename(temporaryPath, this.activePath);
  }
}

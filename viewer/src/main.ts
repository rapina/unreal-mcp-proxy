import type { CallModel, SessionEvent, SessionModel } from "../../src/types.js";
import { buildSessionModel } from "../../src/session-model.js";
import { $, el, fmtMs, fmtTime, outcomeState, renderJson } from "./helpers.js";
import { unwrapRequest, unwrapResponse } from "./unwrap.js";
import { renderThread, type ThreadView } from "./thread.js";
import { renderGraph, setGraphFocus, createReplay, type GraphView } from "./graph.js";

/**
 * Single-file session viewer. Two modes, one artifact:
 * - file mode (file://): drop a session .jsonl to view it, no server needed
 * - served mode (/sessions/{id} on the proxy): auto-loads the session and follows it live
 */

let model: SessionModel | null = null;
let focusCallId: string | null = new URLSearchParams(location.search).get("call");
let threadView: ThreadView | null = null;
let graphView: GraphView | null = null;
let replayTimer: ReturnType<typeof setInterval> | null = null;
let callRows = new Map<string, { item: HTMLLIElement; duration: HTMLSpanElement; call: CallModel }>();

const servedSession = location.protocol.startsWith("http") ? /^\/sessions\/([0-9a-f-]+)$/i.exec(location.pathname)?.[1] ?? null : null;

const chronological = (): CallModel[] =>
  model ? [...model.calls].filter((call) => !call.isSystem).sort((a, b) => a.sequence - b.sequence) : [];

function setModelFromEvents(sessionId: string, events: SessionEvent[]): void {
  model = buildSessionModel(sessionId, events, location.origin.startsWith("http") ? location.origin : "");
  if (focusCallId && !model.calls.some((call) => call.id === focusCallId)) focusCallId = null;
  renderAll();
}

function renderAll(): void {
  if (!model) return;
  $("#drop-stage").hidden = true;
  $("#session-stage").hidden = false;
  renderCurstat(); renderThreadPanel(); renderGraphPanel(); renderCalls();
  void renderDetail();
}

function renderCurstat(): void {
  if (!model) return;
  const bar = $("#curstat");
  const { summary } = model;
  const state = summary.running ? "run" : summary.errors ? "fail" : "pass";
  bar.className = `curstat ${state}`;
  bar.textContent = "";
  bar.append(el("span", "", summary.running ? "RUNNING" : summary.errors ? "FAILED" : "OK"));
  bar.append(el("span", "mut num", `${summary.totalCalls} calls · ${summary.errors} failed · ${summary.running} running`));
  const meta = $("#meta");
  meta.textContent = "";
  const entries: Array<[string, string]> = [
    ["session", model.id.slice(0, 8)],
    ["started", fmtTime(model.startedAt)],
    ["last", fmtTime(model.lastEventAt)],
    ["events", String(model.rawEventCount)]
  ];
  for (const [key, value] of entries) {
    const span = el("span", "", `${key} `);
    span.append(el("b", "", value));
    meta.append(span);
  }
}

function renderThreadPanel(): void {
  const calls = chronological();
  $("#thread-cnt").textContent = String(calls.length);
  threadView = renderThread($("#thread"), calls, focusCallId, selectCall);
}

function renderGraphPanel(): void {
  if (!model) return;
  graphView = renderGraph($("#graph"), $("#graph-meta"), model.graph, focusCallId, selectCall);
}

function stopReplay(): void {
  if (replayTimer) clearInterval(replayTimer);
  replayTimer = null;
  $("#graph-play").textContent = "PLAY";
  renderGraphPanel();
}

$("#graph-play").addEventListener("click", () => {
  if (replayTimer) { stopReplay(); return; }
  if (!graphView) return;
  $("#graph-play").textContent = "STOP";
  const replay = createReplay(graphView, stopReplay);
  replay.tick();
  replayTimer = setInterval(() => replay.tick(), 650);
});

function renderCalls(): void {
  const list = $("#calls");
  const scrollTop = list.scrollTop;
  list.textContent = "";
  callRows = new Map();
  const calls = [...chronological()].reverse();
  $("#calls-cnt").textContent = String(calls.length);
  $("#calls-empty").hidden = calls.length > 0;
  const intentsById = new Map((model?.intents ?? []).map((intent) => [intent.id, intent]));
  let lastIntentId: string | null | undefined = undefined;
  for (const call of calls) {
    if (call.intentId !== lastIntentId) {
      lastIntentId = call.intentId;
      const intent = call.intentId ? intentsById.get(call.intentId) : null;
      if (intent) {
        const head = el("li", "intent-head");
        head.append(el("span", "intent-mark", "▸"));
        head.append(el("span", "grow", intent.text));
        if (intent.tags.length) head.append(el("span", "badge run", intent.tags.join(" ")));
        list.append(head);
      }
    }
    const item = el("li");
    if (call.id === focusCallId) item.classList.add("on");
    item.append(el("span", `knot ${outcomeState(call)}`));
    item.append(el("span", "grow", call.title));
    if (call.annotations.length) item.append(el("span", "badge warn", `A${call.annotations.length}`));
    const duration = el("span", "mut num", call.outcome === "running"
      ? fmtMs(Date.now() - new Date(call.startedAt).getTime())
      : fmtMs(call.durationMs));
    item.append(duration);
    item.append(el("span", "mut num", fmtTime(call.startedAt).slice(6)));
    item.addEventListener("click", () => selectCall(call.id));
    list.append(item);
    callRows.set(call.id, { item, duration, call });
  }
  list.scrollTop = scrollTop;
}

function updateCallSelection(previous: string | null): void {
  if (previous) callRows.get(previous)?.item.classList.remove("on");
  if (focusCallId) callRows.get(focusCallId)?.item.classList.add("on");
}

async function renderDetail(): Promise<void> {
  const container = $("#detail");
  const call = model?.calls.find((item) => item.id === focusCallId) ?? null;
  if (!call) {
    container.textContent = "";
    container.append(el("div", "empty", "SELECT A KNOT"));
    $("#detail-id").textContent = "";
    return;
  }
  $("#detail-id").textContent = call.id.slice(0, 8);
  container.textContent = "";

  const head = el("div", "meta-line");
  const state = outcomeState(call);
  head.append(el("span", `badge ${state}`, call.outcome));
  const fields: Array<[string, string | number | null | undefined]> = [
    ["tool", call.toolName ?? call.title], ["toolset", call.toolsetName],
    ["http", call.statusCode], ["dur", fmtMs(call.durationMs)],
    ["slow", call.performance?.classification === "slow" ? `${call.performance.ratio}x median` : null]
  ];
  for (const [key, value] of fields) {
    if (value == null) continue;
    const span = el("span", "", `${key} `);
    span.append(el("b", "", String(value)));
    head.append(span);
  }
  container.append(head);

  if (call.error) {
    const err = el("div", "verdict error");
    err.append(el("div", "vbody", call.error));
    container.append(err);
  }
  for (const note of call.annotations) {
    const card = el("div", `verdict ${note.severity}`);
    const headEl = el("div", "vhead");
    headEl.append(el("span", `badge ${note.severity === "error" ? "fail" : note.severity === "warn" || note.severity === "warning" ? "warn" : "run"}`, note.severity));
    headEl.append(el("b", "", note.title));
    card.append(headEl);
    card.append(el("div", "vbody", note.summary));
    if (note.cause) card.append(el("div", "vbody mut", note.cause));
    if (note.suggestion) card.append(el("div", "vbody", note.suggestion));
    card.append(el("div", "vmeta", `${note.author}${note.timestamp ? ` · ${fmtTime(note.timestamp)}` : ""}`));
    container.append(card);
  }

  appendBodySection(container, "REQUEST", call.request, unwrapRequest, "NO DATA");
  appendBodySection(container, "RESPONSE", call.response, unwrapResponse, call.outcome === "running" ? "RUNNING" : "NO DATA");
}

function appendBodySection(
  container: HTMLElement, title: string, body: unknown,
  unwrap: (body: unknown) => { view: unknown; changed: boolean }, emptyText: string
): void {
  const wlabel = el("div", "wlabel");
  wlabel.append(el("span", "", title));
  container.append(wlabel);
  if (body == null) {
    container.append(el("div", "empty", emptyText));
    return;
  }
  const { view, changed } = unwrap(body);
  let showRaw = false;
  let pre = renderJson(view);
  container.append(pre);
  if (!changed) return;
  const toggle = el("button", "btn-low cnt", "RAW");
  toggle.addEventListener("click", () => {
    showRaw = !showRaw;
    toggle.textContent = showRaw ? "VIEW" : "RAW";
    const next = renderJson(showRaw ? body : view);
    pre.replaceWith(next);
    pre = next;
  });
  wlabel.append(toggle);
}

function selectCall(callId: string): void {
  const previous = focusCallId;
  focusCallId = callId;
  if (servedSession) {
    const url = new URL(location.href);
    url.searchParams.set("call", callId);
    history.replaceState(null, "", url);
  }
  updateCallSelection(previous);
  threadView?.setFocus(previous, callId);
  if (graphView && !replayTimer) setGraphFocus(graphView, callId);
  void renderDetail();
  document.querySelector(".col-side")?.scrollTo({ top: 0 });
}

// ---- file mode ----

function parseJsonl(text: string): SessionEvent[] {
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as SessionEvent);
}

async function loadFile(file: File): Promise<void> {
  const events = parseJsonl(await file.text());
  const sessionId = events[0]?.sessionId ?? file.name.replace(/\.jsonl$/, "");
  setModelFromEvents(sessionId, events);
  $("#hdr-mode").textContent = `FILE · ${file.name}`;
}

function initFileMode(): void {
  const zone = $("#drop-stage");
  zone.hidden = false;
  const input = $<HTMLInputElement>("#file-input");
  zone.addEventListener("click", () => input.click());
  input.addEventListener("change", () => { if (input.files?.[0]) void loadFile(input.files[0]); });
  for (const eventName of ["dragover", "dragleave", "drop"] as const) {
    zone.addEventListener(eventName, (event) => {
      event.preventDefault();
      zone.classList.toggle("over", eventName === "dragover");
      if (eventName === "drop") {
        const file = (event as DragEvent).dataTransfer?.files?.[0];
        if (file) void loadFile(file);
      }
    });
  }
}

// ---- served mode ----

async function loadServed(sessionId: string): Promise<void> {
  const response = await fetch(`/api/sessions/${sessionId}/events`);
  const payload = await response.json() as { events: SessionEvent[] };
  setModelFromEvents(sessionId, payload.events);
  $("#hdr-mode").textContent = `LIVE · ${sessionId.slice(0, 8)}`;
}

function initServedMode(sessionId: string): void {
  void loadServed(sessionId);
  const source = new EventSource(`/api/sessions/${sessionId}/stream`);
  let pending = false;
  source.addEventListener("changed", () => {
    if (pending) return;
    pending = true;
    setTimeout(() => { pending = false; void loadServed(sessionId); }, 400);
  });
  setInterval(() => void loadServed(sessionId), 30000);
  setInterval(() => {
    if (!model?.summary.running) return;
    for (const { call, duration } of callRows.values()) {
      if (call.outcome === "running") duration.textContent = fmtMs(Date.now() - new Date(call.startedAt).getTime());
    }
  }, 1000);
}

// ---- boot ----

let resizeTimer: ReturnType<typeof setTimeout> | null = null;
window.addEventListener("resize", () => {
  if (resizeTimer) clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (model) { renderThreadPanel(); if (!replayTimer) renderGraphPanel(); } }, 200);
});

if (servedSession) initServedMode(servedSession);
else initFileMode();

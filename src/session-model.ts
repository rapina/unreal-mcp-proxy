import type {
  AnnotationModel, BodySummary, CallModel, CallOutcome, FlowEdge, FlowGraph, FlowNode,
  IntentModel, JsonObject, JsonValue, SessionEvent, SessionModel
} from "./types.js";

/**
 * Builds a human/agent-readable session model from raw recorded events.
 * Pure module (no Node APIs) - shared by the proxy API and the offline viewer bundle.
 */

interface RequestLabel {
  title: string;
  subtitle?: string;
  category: string;
  toolName?: string;
  toolsetName?: string;
  arguments?: JsonObject;
}

interface RequestBodyShape {
  omitted?: boolean;
  method?: string;
  params?: { name?: string; arguments?: JsonObject };
}

function requestLabel(body: BodySummary | null | undefined): RequestLabel {
  const shape = (body && typeof body === "object" && !Array.isArray(body) ? body : {}) as RequestBodyShape;
  if (!body || shape.omitted) return { title: "MCP request", category: "transport" };
  if (shape.method === "initialize") return { title: "MCP initialize", category: "connection" };
  if (shape.method === "notifications/initialized") return { title: "MCP initialized", category: "connection" };
  if (shape.method === "tools/list") return { title: "List tools", category: "discovery" };
  if (shape.method !== "tools/call") return { title: shape.method ?? "MCP request", category: "transport" };
  const name = shape.params?.name ?? "unknown tool";
  const args = shape.params?.arguments ?? {};
  if (name === "list_toolsets" || name === "describe_toolset") {
    return {
      title: name === "list_toolsets" ? "List Unreal toolsets" : "Describe Unreal toolset",
      category: "discovery", toolName: name, arguments: args
    };
  }
  if (name === "call_tool") {
    // Epic's Unreal MCP wraps every engine tool behind call_tool(toolset_name, tool_name, arguments)
    const toolsetName = typeof args.toolset_name === "string" ? args.toolset_name : undefined;
    const toolName = typeof args.tool_name === "string" ? args.tool_name : undefined;
    const toolset = toolsetName ? toolsetName.split(".").at(-1) : "TopLevel";
    return {
      title: `${toolset}.${toolName ?? "unknown"}`,
      subtitle: toolsetName,
      category: "unreal_tool",
      toolName,
      toolsetName,
      arguments: (args.arguments ?? {}) as JsonObject
    };
  }
  return { title: name, category: "mcp_tool", toolName: name, arguments: args };
}

interface JsonRpcShape {
  error?: { message?: string };
  result?: { isError?: boolean; content?: Array<{ text?: string }> };
}

function responseError(body: BodySummary | null | undefined, status: number | null): string | null {
  if (status != null && status >= 400) return `HTTP ${status}`;
  const record = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  const messages: unknown[] = record?.transport === "sse" ? (record.events as unknown[] ?? []) : [body];
  for (const message of messages) {
    const shape = (message ?? {}) as JsonRpcShape;
    if (shape.error) return shape.error.message ?? "MCP error";
    if (shape.result?.isError) return "Tool returned an error";
    const content = shape.result?.content;
    if (Array.isArray(content)) {
      const text = content.map((item) => item?.text ?? "").join("\n");
      if (/^(error|failed|exception|timeout)\s*:/i.test(text.trim())) return text.slice(0, 300);
    }
  }
  return null;
}

const round = (value: number | null | undefined): number => Math.round((value ?? 0) * 100) / 100;

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

interface CompletedEventShape {
  callId?: string;
  status?: number;
  durationMs?: number;
  responseHeadersMs?: number;
  resultEventMs?: number;
  completionReason?: string;
  error?: string;
  body?: BodySummary;
  headers?: JsonObject;
}

function timing(event: CompletedEventShape) {
  const total = event.durationMs ?? 0;
  const headers = Math.min(total, event.responseHeadersMs ?? total);
  const result = Math.min(total, event.resultEventMs ?? total);
  return {
    requestToHeadersMs: round(headers),
    toolResultMs: round(Math.max(0, result - headers)),
    proxyFinalizeMs: round(Math.max(0, total - result)),
    completionReason: event.completionReason ?? "stream_end"
  };
}

function targetNode(call: CallModel): Pick<FlowNode, "key" | "label" | "subtitle" | "kind"> {
  const actor = call.arguments?.actor;
  const refPath = actor && typeof actor === "object" && !Array.isArray(actor)
    ? (actor as JsonObject).refPath : undefined;
  if (typeof refPath === "string" && call.toolName === "get_actor_transform") {
    return { key: `actor:${refPath}`, label: refPath.split(/[.:]/).at(-1) ?? refPath, subtitle: call.toolName, kind: "target" };
  }
  return {
    key: `tool:${call.toolsetName ?? call.category}:${call.toolName ?? call.title}`,
    label: call.toolName ?? call.title,
    subtitle: call.toolsetName ?? call.category,
    kind: "tool"
  };
}

function buildFlowGraph(calls: CallModel[]): FlowGraph {
  const nodes: FlowNode[] = [];
  const nodesByKey = new Map<string, FlowNode>();
  const edges: FlowEdge[] = [];
  let previousNodeId = "start";
  for (const [index, call] of calls.entries()) {
    const descriptor = targetNode(call);
    let node = nodesByKey.get(descriptor.key);
    if (!node) {
      node = { id: `node-${nodes.length + 1}`, ...descriptor, callIds: [] };
      nodesByKey.set(descriptor.key, node);
      nodes.push(node);
    }
    node.callIds.push(call.id);
    edges.push({
      id: `edge-${index + 1}`,
      from: previousNodeId,
      to: node.id,
      order: index + 1,
      callId: call.id,
      durationMs: round(call.durationMs),
      outcome: call.outcome
    });
    previousNodeId = node.id;
  }
  return { basis: "raw_mcp", nodes, edges };
}

export function buildSessionModel(
  sessionId: string, events: SessionEvent[], webBaseUrl: string, now: number = Date.now()
): SessionModel {
  const started = new Map<string, SessionEvent>();
  const completed = new Set<string>();
  const annotations: AnnotationModel[] = [];
  const intents: IntentModel[] = [];
  const calls: CallModel[] = [];
  const base = webBaseUrl.replace(/\/$/, "");

  for (const event of events) {
    if (event.type === "mcp_request_started") started.set(event.callId as string, event);
    if (event.type === "ai_intent") {
      intents.push({
        id: event.intentId as string,
        sequence: event.sequence,
        timestamp: event.timestamp,
        text: event.text as string,
        tags: Array.isArray(event.tags) ? (event.tags as string[]) : [],
        author: (event.author as string) ?? "agent"
      });
    }
    if (event.type === "ai_annotation") {
      annotations.push({
        callId: event.callId as string,
        severity: (event.severity as string) ?? "info",
        title: event.title as string,
        summary: event.summary as string,
        cause: event.cause as string | undefined,
        suggestion: event.suggestion as string | undefined,
        author: (event.author as string) ?? "agent",
        timestamp: event.timestamp
      });
    }
    if (event.type === "mcp_request_completed" || event.type === "mcp_request_failed") {
      const payload = event as unknown as CompletedEventShape;
      const callId = payload.callId ?? "";
      const begin = started.get(callId);
      completed.add(callId);
      const beginBody = (begin?.body ?? null) as BodySummary | null;
      const label = requestLabel(beginBody);
      const error = event.type === "mcp_request_failed"
        ? (payload.error ?? "proxy or upstream connection failed")
        : responseError(payload.body, payload.status ?? null);
      calls.push({
        id: callId,
        sequence: begin?.sequence ?? event.sequence,
        startedAt: begin?.timestamp ?? event.timestamp,
        completedAt: event.timestamp,
        durationMs: payload.durationMs ?? null,
        statusCode: payload.status ?? null,
        outcome: error ? "error" : "success",
        error,
        request: beginBody,
        response: (payload.body ?? null) as BodySummary | null,
        requestHeaders: (begin?.headers ?? null) as JsonObject | null,
        responseHeaders: (payload.headers ?? null) as JsonObject | null,
        timing: timing(payload),
        clientSource: (begin?.clientSource as string) ?? "agent",
        operationId: begin?.operationId as string | undefined,
        operationTitle: begin?.operationTitle as string | undefined,
        operationStep: begin?.operationStep as string | undefined,
        deepLink: `${base}/sessions/${sessionId}?call=${callId}`,
        annotations: [],
        isSystem: false,
        ...label
      });
    }
  }
  for (const [callId, begin] of started) {
    if (completed.has(callId)) continue;
    const label = requestLabel((begin.body ?? null) as BodySummary | null);
    calls.push({
      id: callId,
      sequence: begin.sequence,
      startedAt: begin.timestamp,
      completedAt: null,
      durationMs: Math.max(0, now - new Date(begin.timestamp).getTime()),
      statusCode: null,
      outcome: "running",
      error: null,
      request: (begin.body ?? null) as BodySummary | null,
      response: null,
      requestHeaders: (begin.headers ?? null) as JsonObject | null,
      responseHeaders: null,
      timing: null,
      clientSource: (begin.clientSource as string) ?? "agent",
      operationId: begin.operationId as string | undefined,
      operationTitle: begin.operationTitle as string | undefined,
      operationStep: begin.operationStep as string | undefined,
      deepLink: `${base}/sessions/${sessionId}?call=${callId}`,
      annotations: [],
      isSystem: false,
      ...label
    });
  }

  for (const call of calls) {
    call.isSystem = call.clientSource === "smoke-test" || call.category === "connection" || call.category === "discovery";
  }
  const workCalls = calls.filter((call) => !call.isSystem);
  const errors = workCalls.filter((call) => call.outcome === "error").length;
  const running = workCalls.filter((call) => call.outcome === "running").length;
  const completedWork = workCalls.filter((call) => call.outcome !== "running");
  const recent = [...completedWork].sort((a, b) => b.sequence - a.sequence).slice(0, 20);

  // Per-tool baseline so the viewer can flag calls that are unusually slow for this session
  const durationsByTool = new Map<string, number[]>();
  for (const call of completedWork) {
    const values = durationsByTool.get(call.title) ?? [];
    values.push(call.durationMs ?? 0);
    durationsByTool.set(call.title, values);
  }
  for (const call of completedWork) {
    const samples = durationsByTool.get(call.title) ?? [];
    const baseline = median(samples);
    const ratio = baseline ? (call.durationMs ?? 0) / baseline : 1;
    call.performance = {
      sampleCount: samples.length,
      medianMs: round(baseline),
      ratio: round(ratio),
      classification: samples.length >= 3 && ratio >= 2 && (call.durationMs ?? 0) >= 50 ? "slow" : "normal"
    };
  }
  for (const call of calls) {
    const latestByAuthor = new Map<string, AnnotationModel>();
    for (const note of annotations.filter((item) => item.callId === call.id)) {
      latestByAuthor.set(note.author, note);
    }
    call.annotations = [...latestByAuthor.values()];
  }

  // Associate each call with the most recent intent declared before it (by sequence).
  const intentsBySeq = [...intents].sort((a, b) => a.sequence - b.sequence);
  for (const call of calls) {
    let current: IntentModel | undefined;
    for (const intent of intentsBySeq) {
      if (intent.sequence <= call.sequence) current = intent;
      else break;
    }
    if (current) call.intentId = current.id;
  }

  const chronological = [...workCalls].sort((a, b) => a.sequence - b.sequence);
  return {
    id: sessionId,
    startedAt: events.find((event) => event.type === "session_started")?.timestamp,
    lastEventAt: events.at(-1)?.timestamp,
    summary: {
      totalCalls: workCalls.length,
      successes: completedWork.length - errors,
      errors,
      running,
      systemCalls: calls.length - workCalls.length,
      averageDurationMs: recent.length
        ? Math.round(recent.reduce((sum, call) => sum + (call.durationMs ?? 0), 0) / recent.length)
        : 0,
      medianDurationMs: round(median(recent.map((call) => call.durationMs ?? 0)))
    },
    graph: buildFlowGraph(chronological),
    calls: calls.sort((a, b) => b.sequence - a.sequence),
    intents: intentsBySeq,
    annotations,
    rawEventCount: events.length
  };
}

/** Normalize an error message for similarity matching: mask paths, UUIDs, hex, and numbers. */
export function normalizeError(text: string | null | undefined): string | null {
  if (!text) return null;
  return text.toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>")
    .replace(/[a-z]:\\[^\s"'`]+/g, "<path>")
    .replace(/(?:\/[\w.-]+){2,}/g, "<path>")
    .replace(/0x[0-9a-f]+/g, "<hex>")
    .replace(/\d+/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

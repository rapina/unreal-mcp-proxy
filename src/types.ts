/** Shared domain types for the proxy core, the viewer, and tests. */

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = Record<string, JsonValue | undefined>;

/** One recorded event line in a session .jsonl file. */
export interface SessionEvent {
  schemaVersion: 2;
  source: string;
  sessionId: string;
  sequence: number;
  timestamp: string;
  type: string;
  /** Optional metadata tag (user/machine/project); null unless configured. */
  identity: JsonObject | null;
  [key: string]: unknown;
}

export interface ActiveSession {
  id: string;
  createdAt: string;
  reason: string;
  sequence: number;
}

/** Body summary produced by summarizeBody(): either parsed JSON, an SSE bundle, or an omission marker. */
export type BodySummary =
  | { omitted: true; reason: string; size?: number }
  | { transport: "sse"; events: JsonValue[] }
  | JsonValue;

export type CallOutcome = "success" | "error" | "running";

export interface CallModel {
  id: string;
  sequence: number;
  title: string;
  subtitle?: string;
  category: string;
  toolName?: string;
  toolsetName?: string;
  arguments?: JsonObject;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  statusCode: number | null;
  outcome: CallOutcome;
  error: string | null;
  request: BodySummary | null;
  response: BodySummary | null;
  requestHeaders: JsonObject | null;
  responseHeaders: JsonObject | null;
  timing: CallTiming | null;
  clientSource: string;
  operationId?: string;
  operationTitle?: string;
  operationStep?: string;
  /** Id of the ai_intent that this call falls under (the most recent intent before it). */
  intentId?: string;
  deepLink: string;
  annotations: AnnotationModel[];
  isSystem: boolean;
  performance?: CallPerformance;
}

/**
 * An agent-declared goal recorded mid-session ("why I am about to make these calls").
 * Every call whose sequence is >= this intent's (and < the next intent's) belongs to it,
 * giving a flat call log a narrative structure: what the agent was trying to accomplish.
 */
export interface IntentModel {
  id: string;
  sequence: number;
  timestamp: string;
  text: string;
  tags: string[];
  author: string;
}

export interface CallTiming {
  requestToHeadersMs: number;
  toolResultMs: number;
  proxyFinalizeMs: number;
  completionReason: string;
}

export interface CallPerformance {
  sampleCount: number;
  medianMs: number;
  ratio: number;
  classification: "slow" | "normal";
}

export interface AnnotationModel {
  callId: string;
  severity: string;
  title: string;
  summary: string;
  cause?: string;
  suggestion?: string;
  author: string;
  timestamp?: string;
}

export interface FlowNode {
  id: string;
  key: string;
  label: string;
  subtitle: string;
  kind: "tool" | "target";
  callIds: string[];
}

export interface FlowEdge {
  id: string;
  from: string;
  to: string;
  order: number;
  callId: string;
  durationMs: number;
  outcome: CallOutcome;
}

export interface FlowGraph {
  basis: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
}

export interface SessionModel {
  id: string;
  startedAt: string | undefined;
  lastEventAt: string | undefined;
  summary: {
    totalCalls: number;
    successes: number;
    errors: number;
    running: number;
    systemCalls: number;
    averageDurationMs: number;
    medianDurationMs: number;
  };
  graph: FlowGraph;
  calls: CallModel[];
  intents: IntentModel[];
  annotations: AnnotationModel[];
  rawEventCount: number;
}

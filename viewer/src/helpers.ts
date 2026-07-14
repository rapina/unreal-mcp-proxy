import type { CallModel } from "../../src/types.js";

export const $ = <T extends HTMLElement = HTMLElement>(selector: string): T => {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`element not found: ${selector}`);
  return node;
};

export const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K, cls?: string, text?: string | null
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
};

const SVG_NS = "http://www.w3.org/2000/svg";
export const svgEl = <K extends keyof SVGElementTagNameMap>(
  tag: K, attrs: Record<string, string | number> = {}, cls?: string
): SVGElementTagNameMap[K] => {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  if (cls) node.setAttribute("class", cls);
  return node;
};

export const fmtMs = (ms: number | null | undefined): string => {
  if (ms == null) return "-";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s`;
};

export const fmtTime = (iso: string | null | undefined): string => {
  if (!iso) return "-";
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
};

export type KnotState = "pass" | "fail" | "run";
export const outcomeState = (call: Pick<CallModel, "outcome">): KnotState =>
  call.outcome === "running" ? "run" : call.outcome === "error" ? "fail" : "pass";

export function renderJson(value: unknown): HTMLPreElement {
  const pre = el("pre", "code");
  const text = JSON.stringify(value, null, 2) ?? "null";
  const frag = document.createDocumentFragment();
  const re = /("(?:[^"\\]|\\.)*")(\s*:)?|(-?\d+\.?\d*(?:e[+-]?\d+)?)|(\btrue\b|\bfalse\b|\bnull\b)/gi;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    if (match.index > last) frag.append(text.slice(last, match.index));
    const span = document.createElement("span");
    span.textContent = match[1] ?? match[3] ?? match[4] ?? "";
    span.className = match[1] ? (match[2] ? "k" : "s") : match[3] ? "n" : "b";
    frag.append(span);
    if (match[2]) frag.append(match[2]);
    last = re.lastIndex;
  }
  frag.append(text.slice(last));
  pre.append(frag);
  return pre;
}

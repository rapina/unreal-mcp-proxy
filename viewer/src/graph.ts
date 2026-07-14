import type { FlowGraph, FlowNode } from "../../src/types.js";
import { el, svgEl } from "./helpers.js";

/**
 * Tool flow graph. Repeated calls to the same tool reuse one node; calls with an explicit
 * target actor become target nodes. Edge numbers are the actual call order; replay steps
 * through them one at a time.
 */

interface EdgeShape { order: number; callId: string; toId: string; path: SVGPathElement; label: SVGTextElement }
interface NodeShape { node: FlowNode; group: SVGGElement }

export interface GraphView {
  edgeShapes: EdgeShape[];
  nodeShapes: NodeShape[];
}

export function renderGraph(
  container: HTMLElement, meta: HTMLElement, graph: FlowGraph, focusCallId: string | null,
  onSelect: (callId: string) => void
): GraphView | null {
  const width0 = Math.max(container.clientWidth || 1200, 400);
  container.textContent = "";
  meta.textContent = `${graph.nodes.length}n · ${graph.edges.length}c`;
  if (!graph.nodes.length) return null;

  const CW = 300, RH = 104, NW = 220, NH = 46, PAD = 44;
  const COLS = Math.max(2, Math.floor((width0 - PAD * 2) / CW));
  const indexById = new Map(graph.nodes.map((node, index) => [node.id, index]));
  const center = (nodeId: string) => {
    const index = indexById.get(nodeId) ?? 0;
    return {
      x: PAD + (index % COLS) * CW + ((Math.floor(index / COLS) % 2) ? 40 : 0) + NW / 2,
      y: 30 + Math.floor(index / COLS) * RH + NH / 2
    };
  };
  const rows = Math.ceil(graph.nodes.length / COLS);
  const width = PAD * 2 + Math.min(graph.nodes.length, COLS) * CW;
  const height = 30 + rows * RH + 20;
  const svg = svgEl("svg", { width, height, viewBox: `0 0 ${width} ${height}` });

  const start = { x: 16, y: center(graph.nodes[0]!.id).y };
  svg.append(svgEl("circle", { cx: start.x, cy: start.y, r: 4 }, "gstart"));

  const failedNodes = new Set(graph.edges.filter((edge) => edge.outcome === "error").map((edge) => edge.to));

  const pairSeen = new Map<string, number>();
  const edgeShapes: EdgeShape[] = [];
  for (const edge of graph.edges) {
    const from = edge.from === "start" ? start : center(edge.from);
    const to = center(edge.to);
    const pair = `${edge.from}-${edge.to}`;
    const dup = pairSeen.get(pair) ?? 0;
    pairSeen.set(pair, dup + 1);
    let d: string;
    let mid: { x: number; y: number };
    if (edge.from === edge.to) {
      const loop = 18 + dup * 10;
      d = `M ${to.x - 24} ${to.y - NH / 2} C ${to.x - 24} ${to.y - NH / 2 - loop}, ${to.x + 24} ${to.y - NH / 2 - loop}, ${to.x + 24} ${to.y - NH / 2}`;
      mid = { x: to.x, y: to.y - NH / 2 - loop + 3 };
    } else {
      const dx = to.x - from.x, dy = to.y - from.y;
      const norm = Math.hypot(dx, dy) || 1;
      const off = (14 + dup * 12) * (dup % 2 ? -1 : 1);
      const cx = from.x + dx / 2 - (dy / norm) * off;
      const cy = from.y + dy / 2 + (dx / norm) * off;
      d = `M ${from.x} ${from.y} Q ${cx} ${cy} ${to.x} ${to.y}`;
      mid = { x: (from.x + 2 * cx + to.x) / 4, y: (from.y + 2 * cy + to.y) / 4 };
    }
    const path = svgEl("path", { d }, "gedge");
    const label = svgEl("text", { x: mid.x, y: mid.y, "text-anchor": "middle" }, "gorder");
    label.textContent = String(edge.order);
    label.addEventListener("click", () => onSelect(edge.callId));
    svg.append(path, label);
    edgeShapes.push({ order: edge.order, callId: edge.callId, toId: edge.to, path, label });
  }

  const nodeShapes: NodeShape[] = [];
  for (const node of graph.nodes) {
    const c = center(node.id);
    const group = svgEl("g", {}, `gnode${failedNodes.has(node.id) ? " fail" : ""}`);
    group.append(svgEl("rect", { x: c.x - NW / 2, y: c.y - NH / 2, width: NW, height: NH }));
    const label = svgEl("text", { x: c.x - NW / 2 + 10, y: c.y - 4 }, "glabel");
    label.textContent = node.label.length > 24 ? `${node.label.slice(0, 23)}…` : node.label;
    const sub = svgEl("text", { x: c.x - NW / 2 + 10, y: c.y + 13 }, "gsub");
    sub.textContent = node.subtitle.length > 34 ? `…${node.subtitle.slice(-33)}` : node.subtitle;
    const count = svgEl("text", { x: c.x + NW / 2 - 8, y: c.y - 10, "text-anchor": "end" }, "gcount");
    if (node.callIds.length > 1) count.textContent = `×${node.callIds.length}`;
    group.append(label, sub, count);
    group.addEventListener("click", () => {
      const last = node.callIds.at(-1);
      if (last) onSelect(last);
    });
    svg.append(group);
    nodeShapes.push({ node, group });
  }

  container.append(svg);
  const view: GraphView = { edgeShapes, nodeShapes };
  setGraphFocus(view, focusCallId);
  return view;
}

/** Update focus highlight in place (no rebuild, preserves scroll). */
export function setGraphFocus(view: GraphView, callId: string | null): void {
  const focusEdge = view.edgeShapes.find((shape) => shape.callId === callId) ?? null;
  for (const shape of view.edgeShapes) {
    const on = shape === focusEdge;
    shape.path.classList.toggle("on", on);
    shape.label.classList.toggle("on", on);
    shape.path.classList.remove("dim");
    shape.label.classList.remove("dim");
  }
  for (const shape of view.nodeShapes) {
    shape.group.classList.toggle("on", focusEdge != null && shape.node.id === focusEdge.toId);
    shape.group.classList.remove("dim");
  }
}

export function createReplay(view: GraphView, onDone: () => void): { tick(): void } {
  let step = -1;
  const ordered = [...view.edgeShapes].sort((a, b) => a.order - b.order);
  return {
    tick(): void {
      step += 1;
      if (step >= ordered.length) { onDone(); return; }
      for (const [index, shape] of ordered.entries()) {
        shape.path.classList.toggle("on", index === step);
        shape.label.classList.toggle("on", index === step);
        shape.path.classList.toggle("dim", index > step);
        shape.label.classList.toggle("dim", index > step);
      }
      const current = ordered[step]!;
      const visited = new Set(ordered.slice(0, step + 1).map((shape) => shape.toId));
      for (const shape of view.nodeShapes) {
        shape.group.classList.toggle("on", shape.node.id === current.toId);
        shape.group.classList.toggle("dim", !visited.has(shape.node.id));
      }
    }
  };
}

import type { CallModel } from "../../src/types.js";
import { el, fmtMs, outcomeState } from "./helpers.js";

/**
 * Thread timeline: square knots on a horizontal thread, the thread breaks around failed
 * calls, and wraps serpentine-style (like a loom's weft) instead of scrolling horizontally.
 */

const STEP = 26, ROW_H = 26, PAD = 10, KNOT = 9, HALF = KNOT / 2, GAP = 6, THREAD_Y = 16;

interface KnotPos { cx: number; y: number; row: number }

export interface ThreadView {
  setFocus(previous: string | null, next: string | null): void;
}

export function renderThread(
  container: HTMLElement, calls: CallModel[], focusCallId: string | null, onSelect: (callId: string) => void
): ThreadView {
  // Measure before clearing: forcing layout while empty clamps the page scroll position.
  const width = Math.max(container.clientWidth || 1200, 240);
  container.textContent = "";
  const perRow = Math.max(8, Math.floor((width - PAD * 2 - KNOT) / STEP) + 1);
  const rows = Math.max(1, Math.ceil(calls.length / perRow));

  const track = el("div", "track");
  track.style.height = `${rows * ROW_H + 6}px`;
  container.style.height = `${rows * ROW_H + 10}px`;

  const positions: KnotPos[] = calls.map((_, index) => {
    const row = Math.floor(index / perRow);
    const col = index % perRow;
    const visualCol = row % 2 === 0 ? col : perRow - 1 - col;
    return { cx: PAD + visualCol * STEP + HALF, y: row * ROW_H, row };
  });

  const turnX = (row: number): number =>
    row % 2 === 0 ? PAD + (perRow - 1) * STEP + KNOT + 6 : PAD - 7;
  const failTrim = (call: CallModel): number => (outcomeState(call) === "fail" ? HALF + GAP : 0);

  for (let index = 1; index < calls.length; index += 1) {
    const prev = positions[index - 1]!;
    const curr = positions[index]!;
    const prevTrim = failTrim(calls[index - 1]!);
    const currTrim = failTrim(calls[index]!);
    if (prev.row === curr.row) {
      const dir = Math.sign(curr.cx - prev.cx) || 1;
      addH(track, prev.cx + dir * prevTrim, curr.cx - dir * currTrim, prev.y + THREAD_Y);
    } else {
      const edge = turnX(prev.row);
      const dirOut = Math.sign(edge - prev.cx) || 1;
      const dirIn = Math.sign(curr.cx - edge) || 1;
      addH(track, prev.cx + dirOut * prevTrim, edge, prev.y + THREAD_Y);
      addV(track, edge, prev.y + THREAD_Y, curr.y + THREAD_Y);
      addH(track, edge, curr.cx - dirIn * currTrim, curr.y + THREAD_Y);
    }
  }

  const lastCall = calls.at(-1);
  const lastPos = positions.at(-1);
  if (lastCall && lastPos && lastCall.outcome === "running") {
    const dir = lastPos.row % 2 === 0 ? 1 : -1;
    const from = lastPos.cx + dir * HALF;
    const seg = el("span", "drawseg");
    seg.style.left = `${Math.min(from, from + dir * 20)}px`;
    seg.style.width = "20px";
    seg.style.top = `${lastPos.y + THREAD_Y}px`;
    track.append(seg);
  }

  const knots = new Map<string, { element: HTMLSpanElement; pos: KnotPos }>();
  const applyKnotStyle = (element: HTMLSpanElement, pos: KnotPos, focused: boolean): void => {
    const size = focused ? 11 : KNOT;
    element.classList.toggle("focus", focused);
    element.style.left = `${pos.cx - size / 2}px`;
    element.style.top = `${pos.y + THREAD_Y - size / 2}px`;
    element.style.width = `${size}px`;
    element.style.height = `${size}px`;
  };
  calls.forEach((call, index) => {
    const pos = positions[index]!;
    const knotEl = el("span", `tknot knot ${outcomeState(call)}`);
    applyKnotStyle(knotEl, pos, call.id === focusCallId);
    knotEl.title = `${call.title} ${fmtMs(call.durationMs)}`;
    knotEl.addEventListener("click", () => onSelect(call.id));
    track.append(knotEl);
    knots.set(call.id, { element: knotEl, pos });
  });

  container.append(track);

  return {
    setFocus(previous, next) {
      for (const callId of [previous, next]) {
        if (!callId) continue;
        const knot = knots.get(callId);
        if (knot) applyKnotStyle(knot.element, knot.pos, callId === next);
      }
    }
  };
}

function addH(track: HTMLElement, fromX: number, toX: number, y: number): void {
  const left = Math.min(fromX, toX);
  const w = Math.abs(toX - fromX);
  if (w < 1) return;
  const seg = el("span", "seg");
  seg.style.left = `${left}px`;
  seg.style.width = `${w}px`;
  seg.style.top = `${y}px`;
  track.append(seg);
}

function addV(track: HTMLElement, x: number, fromY: number, toY: number): void {
  const top = Math.min(fromY, toY);
  const h = Math.abs(toY - fromY);
  if (h < 1) return;
  const seg = el("span", "vseg");
  seg.style.left = `${x}px`;
  seg.style.top = `${top}px`;
  seg.style.height = `${h}px`;
  track.append(seg);
}

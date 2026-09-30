import type { Stroke } from '../ink/types';
import { clampScale, type View } from '../ink/viewport';

const KEY = 'calcink.page.v1';
const VIEW_KEY = 'calcink.view.v1';

export function saveView(view: View) {
  try {
    localStorage.setItem(VIEW_KEY, JSON.stringify(view));
  } catch {
    /* best-effort */
  }
}

export function loadView(): View | null {
  try {
    const v = JSON.parse(localStorage.getItem(VIEW_KEY) ?? 'null') as View | null;
    if (v && [v.x, v.y, v.scale].every(Number.isFinite)) return { x: v.x, y: v.y, scale: clampScale(v.scale) };
  } catch {
    /* fall through */
  }
  return null;
}

/** Autosave of the current page. Browser storage can be unavailable (private mode), so every access is guarded. */
export function savePage(strokes: readonly Stroke[]) {
  try {
    const compact = strokes.map((s) => ({
      i: s.id,
      o: s.order,
      w: s.width,
      c: s.color,
      p: s.points.flatMap((q) => [Math.round(q.x * 10) / 10, Math.round(q.y * 10) / 10, Math.round(q.p * 100) / 100]),
    }));
    localStorage.setItem(KEY, JSON.stringify(compact));
  } catch {
    /* quota exceeded or storage blocked — autosave is best-effort */
  }
}

export function loadPage(): Stroke[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const data = JSON.parse(raw) as { i: number; o: number; w: number; c: string; p: number[] }[];
    return data.map((s) => {
      const points = [];
      for (let k = 0; k + 2 < s.p.length; k += 3) points.push({ x: s.p[k], y: s.p[k + 1], p: s.p[k + 2] });
      return { id: s.i, order: s.o, width: s.w, color: s.c, points };
    });
  } catch {
    return [];
  }
}

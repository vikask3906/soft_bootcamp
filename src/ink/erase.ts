import { bboxIntersects, bboxOfPoints, distToPolyline, polylinesIntersect, type XY } from './geometry';
import type { InkPoint, Stroke } from './types';

/** Stroke eraser: removes every stroke that passes within `radius` of p. */
export function eraseStrokesAt(strokes: readonly Stroke[], p: XY, radius: number): readonly Stroke[] {
  const hit = (s: Stroke) => {
    const b = bboxOfPoints(s.points);
    const r = radius + s.width / 2;
    if (!bboxIntersects(b, { minX: p.x, minY: p.y, maxX: p.x, maxY: p.y }, r)) return false;
    return distToPolyline(p, s.points) <= r;
  };
  const kept = strokes.filter((s) => !hit(s));
  return kept.length === strokes.length ? strokes : kept;
}

/**
 * Pixel eraser: cuts the parts of strokes under a circular eraser, splitting
 * strokes into pieces. Works on the vector data (not the bitmap) so the
 * recogniser always sees exactly what the user sees.
 */
export function erasePixelsAt(
  strokes: readonly Stroke[],
  p: XY,
  radius: number,
  nextId: () => number,
): readonly Stroke[] {
  let changed = false;
  const out: Stroke[] = [];
  for (const s of strokes) {
    const r = radius + s.width / 2;
    const b = bboxOfPoints(s.points);
    if (!bboxIntersects(b, { minX: p.x, minY: p.y, maxX: p.x, maxY: p.y }, r)) {
      out.push(s);
      continue;
    }
    const pieces = cutStroke(s.points, p, r);
    if (pieces.length === 1 && pieces[0].length === s.points.length) {
      out.push(s);
      continue;
    }
    changed = true;
    for (const pts of pieces) out.push({ ...s, id: nextId(), points: pts });
  }
  return changed ? out : strokes;
}

/** Splits a polyline at every run of points inside the circle (p, r). */
export function cutStroke(points: readonly InkPoint[], p: XY, r: number): InkPoint[][] {
  const r2 = r * r;
  const inside = (q: XY) => (q.x - p.x) ** 2 + (q.y - p.y) ** 2 <= r2;
  // Densify long segments so the eraser can cut through the middle of them.
  const dense: InkPoint[] = [];
  const step = Math.max(r / 2, 1);
  for (let i = 0; i < points.length; i++) {
    if (i > 0) {
      const a = points[i - 1];
      const b = points[i];
      const n = Math.floor(Math.hypot(b.x - a.x, b.y - a.y) / step);
      for (let k = 1; k < n; k++) {
        const t = k / n;
        dense.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, p: a.p + (b.p - a.p) * t });
      }
    }
    dense.push(points[i]);
  }
  const pieces: InkPoint[][] = [];
  let cur: InkPoint[] = [];
  for (const q of dense) {
    if (inside(q)) {
      if (cur.length) pieces.push(cur);
      cur = [];
    } else {
      cur.push(q);
    }
  }
  if (cur.length) pieces.push(cur);
  // A lone surviving sample would render as a stray dot (and read as a "."),
  // so drop 1-point fragments unless the original stroke was itself a dot.
  return points.length === 1 ? pieces : pieces.filter((pc) => pc.length > 1);
}

/**
 * Scratch-out gesture: a fast zig-zag drawn over ink deletes that ink.
 * Detected by counting horizontal direction reversals relative to the size of
 * the scribble — handwriting of digits and operators never has this many.
 */
export function isScratchGesture(points: readonly XY[]): boolean {
  if (points.length < 12) return false;
  const b = bboxOfPoints(points);
  const w = b.maxX - b.minX;
  const h = b.maxY - b.minY;
  if (w < 12) return false;
  const minTravel = Math.max(w * 0.35, 6);
  let reversals = 0;
  let dir = 0;
  let anchor = points[0].x;
  for (const q of points) {
    const d = q.x - anchor;
    if (Math.abs(d) >= minTravel) {
      const nd = Math.sign(d);
      if (dir !== 0 && nd !== dir) reversals++;
      dir = nd;
      anchor = q.x;
    } else if (Math.sign(d) === dir) {
      anchor = dir > 0 ? Math.max(anchor, q.x) : Math.min(anchor, q.x);
    }
  }
  return reversals >= 5 && h < w * 1.5;
}

/** Strokes the scratch gesture actually crosses. */
export function strokesHitByScratch(strokes: readonly Stroke[], scratch: readonly XY[]): Set<number> {
  const sb = bboxOfPoints(scratch);
  const hit = new Set<number>();
  for (const s of strokes) {
    if (!bboxIntersects(bboxOfPoints(s.points), sb, 2)) continue;
    if (polylinesIntersect(s.points, scratch) || s.points.some((p) => distToPolyline(p, scratch) < s.width + 2)) {
      hit.add(s.id);
    }
  }
  return hit;
}

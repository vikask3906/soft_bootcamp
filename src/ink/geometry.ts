import type { BBox, InkPoint } from './types';

export type XY = { x: number; y: number };

export function emptyBBox(): BBox {
  return { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
}

export function bboxOfPoints(points: readonly XY[]): BBox {
  const b = emptyBBox();
  for (const p of points) {
    if (p.x < b.minX) b.minX = p.x;
    if (p.y < b.minY) b.minY = p.y;
    if (p.x > b.maxX) b.maxX = p.x;
    if (p.y > b.maxY) b.maxY = p.y;
  }
  return b;
}

export function unionBBox(a: BBox, b: BBox): BBox {
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  };
}

export const bboxWidth = (b: BBox) => b.maxX - b.minX;
export const bboxHeight = (b: BBox) => b.maxY - b.minY;

/** Length of the overlap of two 1-D ranges (0 when disjoint). */
export function rangeOverlap(a0: number, a1: number, b0: number, b1: number): number {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
}

export function bboxIntersects(a: BBox, b: BBox, pad = 0): boolean {
  return (
    a.minX - pad <= b.maxX && a.maxX + pad >= b.minX && a.minY - pad <= b.maxY && a.maxY + pad >= b.minY
  );
}

export function pathLength(points: readonly XY[]): number {
  let len = 0;
  for (let i = 1; i < points.length; i++) {
    len += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }
  return len;
}

/** Squared distance from point p to segment ab. */
export function distToSegmentSq(p: XY, a: XY, b: XY): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq === 0 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = a.x + t * dx - p.x;
  const cy = a.y + t * dy - p.y;
  return cx * cx + cy * cy;
}

/** Minimum distance from p to a polyline. */
export function distToPolyline(p: XY, pts: readonly XY[]): number {
  if (pts.length === 0) return Infinity;
  if (pts.length === 1) return Math.hypot(p.x - pts[0].x, p.y - pts[0].y);
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const d = distToSegmentSq(p, pts[i - 1], pts[i]);
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

/** Proper segment intersection test (shared endpoints/collinear touch counts). */
export function segmentsIntersect(a: XY, b: XY, c: XY, d: XY): boolean {
  const o = (p: XY, q: XY, r: XY) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
  const o1 = o(a, b, c);
  const o2 = o(a, b, d);
  const o3 = o(c, d, a);
  const o4 = o(c, d, b);
  return o1 !== o2 && o3 !== o4;
}

export function polylinesIntersect(a: readonly XY[], b: readonly XY[]): boolean {
  for (let i = 1; i < a.length; i++) {
    for (let j = 1; j < b.length; j++) {
      if (segmentsIntersect(a[i - 1], a[i], b[j - 1], b[j])) return true;
    }
  }
  return false;
}

/**
 * Converts a pointer event's client coordinates into logical canvas
 * coordinates, given the canvas' bounding rect. Kept pure for testing.
 */
export function clientToCanvas(clientX: number, clientY: number, rect: { left: number; top: number }): XY {
  return { x: clientX - rect.left, y: clientY - rect.top };
}

/**
 * Backing-store size for a canvas of the given CSS size on a display with the
 * given devicePixelRatio. Rounded so the bitmap maps 1:1 onto device pixels.
 */
export function backingStoreSize(cssWidth: number, cssHeight: number, dpr: number) {
  const ratio = dpr > 0 && Number.isFinite(dpr) ? dpr : 1;
  return {
    width: Math.max(1, Math.round(cssWidth * ratio)),
    height: Math.max(1, Math.round(cssHeight * ratio)),
    scale: ratio,
  };
}

export function toXY(points: readonly InkPoint[]): XY[] {
  return points.map((p) => ({ x: p.x, y: p.y }));
}

import type { InkPoint, Stroke } from './types';

/** Pen width scaling from pressure: light touch → thinner, firm → thicker. */
export const widthAt = (base: number, p: number) => base * (0.55 + 0.9 * p);

/**
 * Draws a stroke as a chain of quadratic Bézier segments through the
 * midpoints of consecutive samples (a standard, cheap smoothing that removes
 * polyline "corners"). Each segment gets its own width so pen pressure shows.
 */
export function drawStroke(ctx: CanvasRenderingContext2D, stroke: Pick<Stroke, 'points' | 'width' | 'color'>) {
  const pts = stroke.points;
  if (pts.length === 0) return;
  ctx.strokeStyle = stroke.color;
  ctx.fillStyle = stroke.color;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  if (pts.length === 1) {
    ctx.beginPath();
    ctx.arc(pts[0].x, pts[0].y, widthAt(stroke.width, pts[0].p) / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  if (pts.length === 2) {
    segment(ctx, pts[0], null, pts[1], stroke.width, pts[1].p);
    return;
  }
  let from: InkPoint = pts[0];
  for (let i = 1; i < pts.length - 1; i++) {
    const mid = midpoint(pts[i], pts[i + 1]);
    segment(ctx, from, pts[i], mid, stroke.width, pts[i].p);
    from = mid;
  }
  segment(ctx, from, null, pts[pts.length - 1], stroke.width, pts[pts.length - 1].p);
}

function segment(ctx: CanvasRenderingContext2D, a: InkPoint, ctrl: InkPoint | null, b: InkPoint, width: number, p: number) {
  ctx.lineWidth = widthAt(width, p);
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  if (ctrl) ctx.quadraticCurveTo(ctrl.x, ctrl.y, b.x, b.y);
  else ctx.lineTo(b.x, b.y);
  ctx.stroke();
}

const midpoint = (a: InkPoint, b: InkPoint): InkPoint => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, p: (a.p + b.p) / 2 });

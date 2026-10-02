import { bboxHeight, bboxOfPoints, type XY } from '../ink/geometry';
import type { BBox } from '../ink/types';
import type { RecStroke } from './segment';

/**
 * Deskewing: makes slanted rows horizontal before segmentation.
 *
 * Rows on a page can each have their own slope, and their extensions may
 * cross even when their ink doesn't touch — so a single page-wide angle is
 * wrong. Instead strokes are grouped by *when* they were written:
 *
 *  1. Bursts: a stroke continues the previous stroke's burst if it was the
 *     next one written and starts close to it (≤ 1.5 glyph heights away). An
 *     equation is written as one burst, left to right, whatever its angle.
 *  2. Slope per burst: least-squares line through the stroke centres, refitted
 *     once without outliers (e.g. a bracket or a "÷" dot far from the line).
 *  3. Small bursts (a digit added later to an old row) join the burst whose
 *     fitted line they sit on, so they are straightened with the same angle.
 *  4. Each burst is rotated upright about its centre. Rotation is a rigid
 *     motion, so glyph shapes are unchanged — only their orientation.
 *
 * The inverse rotation is returned per stroke so the pipeline can put the
 * answer back on the slanted row, following its slope.
 */

export interface RowTransform {
  /** Row slope in radians (positive = descending to the right, since y points down). */
  angle: number;
  cx: number;
  cy: number;
}

/** Below this the row is treated as straight (no rotation at all). */
const MIN_ANGLE = (3 * Math.PI) / 180;
/** Beyond this it's not a slanted row but something else (a column, a scribble). */
const MAX_ANGLE = (45 * Math.PI) / 180;

export function rotate(p: XY, t: RowTransform, sign: 1 | -1): XY {
  const a = sign * t.angle;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const dx = p.x - t.cx;
  const dy = p.y - t.cy;
  return { x: t.cx + dx * c - dy * s, y: t.cy + dx * s + dy * c };
}

/** Upright (recognition) coordinates → page coordinates. */
export const toPage = (p: XY, t: RowTransform) => rotate(p, t, 1);

interface Burst {
  strokes: RecStroke[];
  boxes: BBox[];
  fit: { slope: number; intercept: number; cx: number; cy: number } | null;
}

const centre = (b: BBox): XY => ({ x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 });
const boxGap = (a: BBox, b: BBox) => Math.hypot(Math.max(0, a.minX - b.maxX, b.minX - a.maxX), Math.max(0, a.minY - b.maxY, b.minY - a.maxY));

/** Least-squares y = slope·x + intercept through points; null if they don't span enough width. */
function fitLine(pts: XY[], minSpan: number) {
  const xs = pts.map((p) => p.x);
  if (pts.length < 3 || Math.max(...xs) - Math.min(...xs) < minSpan) return null;
  const n = pts.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = pts.reduce((a, p) => a + p.y, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (const p of pts) {
    sxx += (p.x - mx) ** 2;
    sxy += (p.x - mx) * (p.y - my);
  }
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  return { slope, intercept: my - slope * mx, cx: mx, cy: my };
}

export function deskew(strokes: readonly RecStroke[]): { strokes: RecStroke[]; transforms: Map<number, RowTransform> } {
  const transforms = new Map<number, RowTransform>();
  const valid = strokes.filter((s) => s.pts.length > 0);
  if (valid.length < 3) return { strokes: [...strokes], transforms };

  const boxes = new Map(valid.map((s) => [s, bboxOfPoints(s.pts)]));
  const heights = [...boxes.values()].map(bboxHeight).filter((h) => h > 6).sort((a, b) => a - b);
  const unit = Math.max(heights.length ? heights[Math.floor(heights.length / 2)] : 16, 16);

  // 1. Bursts by writing order + proximity.
  const byOrder = [...valid].sort((a, b) => a.order - b.order);
  const bursts: Burst[] = [];
  let cur: Burst | null = null;
  let prev: RecStroke | null = null;
  for (const s of byOrder) {
    const b = boxes.get(s)!;
    const continues = cur && prev && boxGap(boxes.get(prev)!, b) <= 1.5 * unit;
    if (!continues) {
      cur = { strokes: [], boxes: [], fit: null };
      bursts.push(cur);
    }
    cur!.strokes.push(s);
    cur!.boxes.push(b);
    prev = s;
  }

  // 2. Robust slope per burst (upright, digit-sized strokes carry the row's direction).
  const robustFit = (burst: Burst) => {
    const pts = burst.boxes.filter((b) => bboxHeight(b) >= 0.4 * unit).map(centre);
    const fit = fitLine(pts, 2 * unit);
    if (!fit) return null;
    const inliers = pts.filter((p) => Math.abs(p.y - (fit.slope * p.x + fit.intercept)) <= 0.5 * unit);
    return fitLine(inliers, 2 * unit) ?? fit;
  };
  for (const burst of bursts) burst.fit = robustFit(burst);

  // 2b. One row written in several bursts (e.g. the opening "(" added last, then the
  // rest of the line continued later) must be straightened as ONE piece: rotating
  // two parts of a line about different centres shifts them to different heights.
  // Merge fitted bursts that lie on each other's line, then refit the merged row.
  let fitted = bursts.filter((b) => b.fit);
  for (let merged = true; merged; ) {
    merged = false;
    outer: for (let i = 0; i < fitted.length; i++) {
      for (let j = i + 1; j < fitted.length; j++) {
        if (!sameRow(fitted[i], fitted[j], unit)) continue;
        const a = fitted[i];
        const b = fitted[j];
        a.strokes.push(...b.strokes);
        a.boxes.push(...b.boxes);
        a.fit = robustFit(a) ?? a.fit;
        fitted.splice(j, 1);
        bursts.splice(bursts.indexOf(b), 1);
        merged = true;
        break outer;
      }
    }
  }
  fitted = bursts.filter((b) => b.fit);

  // 3. Small / unfitted bursts join the fitted burst whose line they lie on.
  for (const burst of bursts) {
    if (burst.fit) continue;
    for (let i = 0; i < burst.strokes.length; i++) {
      const c = centre(burst.boxes[i]);
      let best: Burst | null = null;
      let bestD = Infinity;
      for (const f of fitted) {
        const { slope, intercept } = f.fit!;
        const xs = f.boxes.flatMap((b) => [b.minX, b.maxX]);
        if (c.x < Math.min(...xs) - 2 * unit || c.x > Math.max(...xs) + 2 * unit) continue;
        const d = Math.abs(c.y - (slope * c.x + intercept)) / Math.sqrt(1 + slope * slope);
        if (d < bestD) {
          bestD = d;
          best = f;
        }
      }
      if (best && bestD <= 0.6 * unit) {
        const t = transformOf(best);
        if (t) transforms.set(burst.strokes[i].id, t);
      }
    }
  }
  for (const f of fitted) {
    const t = transformOf(f);
    if (t) for (const s of f.strokes) transforms.set(s.id, t);
  }

  // 4. Rotate each stroke upright with its row's transform.
  const out = strokes.map((s) => {
    const t = transforms.get(s.id);
    return t ? { ...s, pts: s.pts.map((p) => rotate(p, t, -1)) } : s;
  });
  return { strokes: out, transforms };
}

/** Two fitted bursts are one row if their slopes agree, each centre lies on the other's line, and they are near along it. */
function sameRow(a: Burst, b: Burst, unit: number): boolean {
  const fa = a.fit!;
  const fb = b.fit!;
  const da = Math.atan(fa.slope);
  const db = Math.atan(fb.slope);
  if (Math.abs(da - db) > (8 * Math.PI) / 180) return false;
  const off = (f: NonNullable<Burst['fit']>, x: number, y: number) => Math.abs(y - (f.slope * x + f.intercept)) / Math.sqrt(1 + f.slope ** 2);
  if (off(fa, fb.cx, fb.cy) > 0.8 * unit || off(fb, fa.cx, fa.cy) > 0.8 * unit) return false;
  const ext = (bu: Burst) => [Math.min(...bu.boxes.map((x) => x.minX)), Math.max(...bu.boxes.map((x) => x.maxX))];
  const [a0, a1] = ext(a);
  const [b0, b1] = ext(b);
  const gap = Math.max(0, a0 - b1, b0 - a1) / Math.cos((da + db) / 2);
  return gap <= 5 * unit;
}

function transformOf(b: Burst): RowTransform | null {
  const angle = Math.atan(b.fit!.slope);
  if (Math.abs(angle) < MIN_ANGLE || Math.abs(angle) > MAX_ANGLE) return null;
  return { angle, cx: b.fit!.cx, cy: b.fit!.cy };
}

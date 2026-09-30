import {
  bboxHeight,
  bboxOfPoints,
  bboxWidth,
  distToSegmentSq,
  pathLength,
  polylinesIntersect,
  segmentsIntersect,
  type XY,
} from '../ink/geometry';

/**
 * Geometric recogniser for the operator vocabulary.
 *
 * MNIST only knows digits, but operators are geometrically trivial — they are
 * built from straight lines and dots whose count, orientation and relative
 * layout identify them unambiguously. Classifying them from vector strokes
 * is faster and more robust than any pixel model, and lets the CNN focus on
 * digits (see ARCHITECTURE.md §4).
 */

export type ShapeSymbol = '+' | '−' | '×' | '÷' | '=' | '.' | '1' | '(' | ')';

export interface ShapeGuess {
  symbol: ShapeSymbol;
  confidence: number;
}

interface StrokeFeatures {
  pts: readonly XY[];
  w: number;
  h: number;
  size: number;
  cx: number;
  cy: number;
  /** 1 = perfectly straight. */
  straightness: number;
  /** Angle of the chord in degrees, folded into [0, 180). */
  angle: number;
}

/**
 * Drops the first and last `frac` of a stroke's path length. Real pens add
 * small hooks where the nib lands and lifts; left in, they make a clearly
 * straight bar look curved (measured on real tablet strokes: an "=" bar
 * scored 0.58 straightness with hooks, ~0.97 without).
 */
export function trimHooks(pts: readonly XY[], frac = 0.12): readonly XY[] {
  if (pts.length < 5) return pts;
  const total = pathLength(pts);
  if (total === 0) return pts;
  const cut = total * frac;
  let acc = 0;
  let start = 0;
  let end = pts.length - 1;
  for (let i = 1; i < pts.length; i++) {
    acc += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    if (acc >= cut) {
      start = i - 1;
      break;
    }
  }
  acc = 0;
  for (let i = pts.length - 1; i > 0; i--) {
    acc += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    if (acc >= cut) {
      end = i;
      break;
    }
  }
  return end - start >= 1 ? pts.slice(start, end + 1) : pts;
}

export function strokeFeatures(pts: readonly XY[]): StrokeFeatures {
  const b = bboxOfPoints(pts);
  const w = bboxWidth(b);
  const h = bboxHeight(b);
  // Shape (straightness, direction) is measured without the landing/lifting hooks.
  const core = trimHooks(pts);
  const a = core[0];
  const z = core[core.length - 1];
  const chord = Math.hypot(z.x - a.x, z.y - a.y);
  const len = pathLength(core);
  let maxDev = 0;
  for (const p of core) maxDev = Math.max(maxDev, Math.sqrt(distToSegmentSq(p, a, z)));
  const straightness = len === 0 ? 0 : Math.min(chord / len, 1 - maxDev / Math.max(chord, 1e-6) / 2);
  let angle = (Math.atan2(z.y - a.y, z.x - a.x) * 180) / Math.PI;
  if (angle < 0) angle += 180;
  if (angle >= 180) angle -= 180;
  return { pts, w, h, size: Math.max(w, h), cx: (b.minX + b.maxX) / 2, cy: (b.minY + b.maxY) / 2, straightness, angle };
}

const isStraight = (f: StrokeFeatures) => f.straightness > 0.85;
/** Angular distance from horizontal, in degrees (0..90). */
const fromHorizontal = (f: StrokeFeatures) => Math.min(f.angle, 180 - f.angle);
// A very flat (or very thin) stroke is a bar even if its ends hook: nothing else
// in the vocabulary is 3.5× wider than tall. Hooks can reach ~25% of a short bar.
const isFlat = (f: StrokeFeatures) => f.w > 3.5 * Math.max(f.h, 1);
const isThin = (f: StrokeFeatures) => f.h > 3.5 * Math.max(f.w, 1);
const isHorizontal = (f: StrokeFeatures) => (isStraight(f) && fromHorizontal(f) < 25 && f.w > 1.8 * f.h) || isFlat(f);
const isVertical = (f: StrokeFeatures) => (isStraight(f) && fromHorizontal(f) > 60) || isThin(f);
const isDiagonal = (f: StrokeFeatures) => isStraight(f) && fromHorizontal(f) >= 20 && fromHorizontal(f) <= 70;
const isDot = (f: StrokeFeatures, lineHeight: number) => f.size <= Math.max(0.2 * lineHeight, 4);

/**
 * Whether two straight strokes would cross if each were extended by
 * `extend` × its length at both ends. Catches "+" and "×" whose bars stop
 * just short of each other, while a bar far off to the side (a "⊢" or "T"
 * shape would need > 30% extension) still doesn't count.
 */
export function nearlyCross(a: StrokeFeatures, b: StrokeFeatures, extend: number): boolean {
  const ext = (f: StrokeFeatures): [XY, XY] => {
    const p = f.pts[0];
    const q = f.pts[f.pts.length - 1];
    const dx = (q.x - p.x) * extend;
    const dy = (q.y - p.y) * extend;
    return [
      { x: p.x - dx, y: p.y - dy },
      { x: q.x + dx, y: q.y + dy },
    ];
  };
  const [a0, a1] = ext(a);
  const [b0, b1] = ext(b);
  return segmentsIntersect(a0, a1, b0, b1);
}

/**
 * "(" and ")" are single, tall, narrow strokes whose ends line up vertically
 * and whose middle bows to one side. The bow direction — measured as the
 * signed distance of points from the top→bottom chord — tells them apart,
 * and the bow size separates them from a straight "1" and from loopy digits.
 */
export function classifyBracket(f: StrokeFeatures): ShapeGuess | null {
  if (f.h < 1e-6 || f.w > 0.6 * f.h || fromHorizontal(f) < 65) return null;
  const [a, z] = f.pts[0].y <= f.pts[f.pts.length - 1].y ? [f.pts[0], f.pts[f.pts.length - 1]] : [f.pts[f.pts.length - 1], f.pts[0]];
  const dx = z.x - a.x;
  const dy = z.y - a.y;
  const chord = Math.hypot(dx, dy);
  if (chord < 0.7 * f.h) return null; // ends must span the stroke's height (rules out "0", "6", "9")
  let left = 0;
  let right = 0;
  let leftY = 0;
  let rightY = 0;
  for (const p of f.pts) {
    // Cross product of chord × (p − a); with y pointing down, positive = left of the chord.
    const side = (dx * (p.y - a.y) - dy * (p.x - a.x)) / chord;
    if (side > left) [left, leftY] = [side, p.y];
    if (-side > right) [right, rightY] = [-side, p.y];
  }
  const bow = Math.max(left, right) / chord;
  const oneSided = Math.min(left, right) < 0.35 * Math.max(left, right); // a C-curve, not an S
  // A bracket bows most near its middle; a narrow "7" has its corner at the top.
  const peak = ((left > right ? leftY : rightY) - a.y) / Math.max(dy, 1e-6);
  if (bow < 0.08 || bow > 0.45 || !oneSided || peak < 0.25 || peak > 0.75) return null;
  const confidence = Math.min(0.95, 0.7 + bow);
  return { symbol: left > right ? '(' : ')', confidence };
}

/**
 * Classifies a symbol (1–3 strokes) as an operator, or returns null to hand it
 * to the digit model. `lineHeight` is the typical digit height on the line and
 * gives the recogniser a sense of scale (a dot is only a dot relative to text).
 */
export function classifyOperator(strokes: readonly (readonly XY[])[], lineHeight: number): ShapeGuess | null {
  const fs = strokes.filter((s) => s.length > 0).map(strokeFeatures);
  if (fs.length === 0) return null;

  if (fs.length === 1) {
    const [f] = fs;
    if (isDot(f, lineHeight)) return { symbol: '.', confidence: 0.9 };
    if (isHorizontal(f)) return { symbol: '−', confidence: 0.9 };
    // Brackets are checked before "1": both are tall single strokes, a bracket just bows.
    const bracket = classifyBracket(f);
    if (bracket) return bracket;
    // A single straight near-vertical bar is a "1"; MNIST handles slanted/serif ones.
    // (Requires real straightness, not just thinness: a narrow "7" is thin too.)
    if (isStraight(f) && f.h > 0.5 * lineHeight && fromHorizontal(f) > 75) return { symbol: '1', confidence: 0.9 };
    return null;
  }

  if (fs.length === 2) {
    const [a, b] = fs;
    const cross = polylinesIntersect(a.pts, b.pts);
    if (isHorizontal(a) && isHorizontal(b) && !cross) {
      const gap = Math.abs(a.cy - b.cy);
      if (gap > 0.1 * Math.max(a.w, b.w)) return { symbol: '=', confidence: 0.95 };
    }
    // Real handwriting often leaves a tiny gap where the two bars should cross,
    // so a near-miss (crossing once both bars are extended by 30%) also counts.
    const touches = cross || nearlyCross(a, b, 0.3);
    if (touches) {
      if ((isHorizontal(a) && isVertical(b)) || (isVertical(a) && isHorizontal(b))) {
        return { symbol: '+', confidence: cross ? 0.92 : 0.85 };
      }
      if (isDiagonal(a) && isDiagonal(b)) {
        // Opposite slopes: one rising, one falling.
        const slopeA = a.angle < 90;
        const slopeB = b.angle < 90;
        if (slopeA !== slopeB) return { symbol: '×', confidence: cross ? 0.92 : 0.85 };
      }
    }
    return null;
  }

  if (fs.length === 3) {
    const line = fs.find(isHorizontal);
    if (line) {
      const dots = fs.filter((f) => f !== line && f.size <= Math.max(0.45 * line.w, 6));
      if (dots.length === 2) {
        const above = dots.some((d) => d.cy < line.cy);
        const below = dots.some((d) => d.cy > line.cy);
        if (above && below) return { symbol: '÷', confidence: 0.93 };
      }
    }
  }
  return null;
}

import {
  bboxHeight,
  bboxOfPoints,
  bboxWidth,
  distToSegmentSq,
  pathLength,
  polylinesIntersect,
  rangeOverlap,
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
// × strokes are drawn fast and bow slightly; a real one measured 0.84 straightness.
const isDiagonal = (f: StrokeFeatures) => f.straightness > 0.8 && fromHorizontal(f) >= 20 && fromHorizontal(f) <= 70;

/**
 * Size thresholds, as fractions of the line's digit height. Measured on real
 * tablet ink (26–34 px lines): decimal points were 2–7 px (≤ 0.27 H); "÷" dots
 * were sometimes short dashes up to 11 px (≤ 0.41 H); the shortest real bar
 * was 13 px (0.38 H) while stray taps were ≤ 2 px.
 */
export const DOT_MAX = 0.3;
export const DIVIDE_MARK_MAX = 0.45;
export const BAR_MIN = 0.3;

const isDot = (f: StrokeFeatures, lineHeight: number) => f.size <= Math.max(DOT_MAX * lineHeight, 4);

/** Loose "+" test for two strokes that really cross: h is a roughly horizontal bar, v a roughly vertical one. */
function looseCross(h: StrokeFeatures, v: StrokeFeatures, minBar: number): boolean {
  // Thickness is judged without the end hooks (a real bar had a big hook at one end);
  // an open "4" corner stroke keeps its height because the corner is mid-stroke.
  const coreH = bboxHeight(bboxOfPoints(trimHooks(h.pts, 0.2)));
  const hOk = h.straightness > 0.7 && fromHorizontal(h) < 30 && h.w > 1.8 * coreH && h.w >= minBar && coreH <= 0.3 * v.h;
  // A truly straight stem that leans has a wide box from its tilt, not its thickness.
  const vOk = v.straightness > 0.7 && fromHorizontal(v) > 60 && v.h >= minBar && (v.straightness > 0.85 || v.w <= 0.3 * h.w);
  return hOk && vOk;
}

/**
 * Removes strokes that retrace another one: nearly parallel (≤ 20°), touching
 * it, and lying along it (every point within 25% of the line height). The
 * longer stroke is kept.
 */
function dropRetraced(fs: StrokeFeatures[], lineHeight: number): StrokeFeatures[] {
  const straightish = (f: StrokeFeatures) => f.straightness > 0.7 && f.size >= BAR_MIN * lineHeight;
  const len = (f: StrokeFeatures) => pathLength(f.pts);
  const dropped = new Set<StrokeFeatures>();
  for (const a of fs) {
    for (const b of fs) {
      if (a === b || dropped.has(a) || dropped.has(b) || !straightish(a) || !straightish(b) || len(a) > len(b)) continue;
      const dAngle = Math.abs(a.angle - b.angle);
      if (Math.min(dAngle, 180 - dAngle) > 20) continue;
      const b0 = b.pts[0];
      const b1 = b.pts[b.pts.length - 1];
      const along = a.pts.every((p) => Math.sqrt(distToSegmentSq(p, b0, b1)) <= Math.max(3, 0.25 * lineHeight));
      const touching = a.pts.some((p) => b.pts.some((q) => Math.hypot(p.x - q.x, p.y - q.y) <= Math.max(1.5, 0.08 * lineHeight)));
      if (along && touching) dropped.add(a);
    }
  }
  return dropped.size ? fs.filter((f) => !dropped.has(f)) : fs;
}

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
  // Axis may tilt down to 55° from horizontal (real brackets leaned to 61–63°).
  // (A tilted bracket has a wide bounding box, so the box may be up to 0.8 as wide as tall;
  // the bow and peak tests below measure shape along the stroke's own axis.)
  if (f.h < 1e-6 || f.w > 0.8 * f.h || fromHorizontal(f) < 55) return null;
  const m = bracketMeasure(f);
  if (!m) return null;
  const { bow, oneSided, peak, left, right, twoBumps } = m;
  // Bow is measured across the stroke's own axis, so a leaning "1" isn't mistaken
  // for a bracket (a width/height ratio would be: a 13°-leaning "1" is 25% as wide as tall).
  // Widest point anywhere in the middle 70% (real brackets peaked at 22–23% of their
  // height; narrow "7"s peak at ≤ 0, "6"s beyond the ends). Strongly curled brackets
  // bowed up to 0.51; digits that pass the other tests bowed ≥ 0.62.
  // Brackets are smooth arcs: on 29 real brackets straightness was ≥ 0.71, while
  // digits with bracket-like outlines (a "5", open "4"s, "7"s) scored ≤ 0.69.
  if (f.straightness < 0.65) return null;
  if (bow < MIN_BRACKET_BOW || bow > 0.6 || !oneSided || twoBumps || peak < 0.15 || peak > 0.85) return null;
  const confidence = Math.min(0.95, 0.7 + bow);
  return { symbol: left > right ? '(' : ')', confidence };
}

/**
 * Measured on 10 real brackets and 11 real "1"s from tablet recordings: brackets
 * bow 0.16–0.43; "1"s whose bend is mid-stroke bow ≤ 0.11 (flagged "1"s bow up
 * to 0.14 but peak at the very top, which the peak test rejects). 0.13 sits in the gap.
 */
export const MIN_BRACKET_BOW = 0.13;

/** How a tall single stroke bows away from its top→bottom chord (null if its ends don't span it). */
export function bracketMeasure(f: StrokeFeatures) {
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
  // Two bumps with a dip between them ("3") vs one arc (a bracket): walk the
  // distance-from-chord profile on the bowing side and look for a valley
  // between its first and last high points.
  const sign = left > right ? 1 : -1;
  const max = Math.max(left, right);
  const prof = f.pts.map((p) => Math.max(0, (sign * (dx * (p.y - a.y) - dy * (p.x - a.x))) / chord));
  const highs = prof.map((d, i) => (d >= 0.6 * max ? i : -1)).filter((i) => i >= 0);
  const valley = highs.length >= 2 ? Math.min(...prof.slice(highs[0], highs[highs.length - 1] + 1)) : max;
  const twoBumps = valley < 0.45 * max;
  return { bow, oneSided, peak, left, right, twoBumps };
}

/**
 * Classifies a symbol (1–3 strokes) as an operator, or returns null to hand it
 * to the digit model. `lineHeight` is the typical digit height on the line and
 * gives the recogniser a sense of scale (a dot is only a dot relative to text).
 */
export function classifyOperator(strokes: readonly (readonly XY[])[], lineHeight: number): ShapeGuess | null {
  let fs = strokes.filter((s) => s.length > 0).map(strokeFeatures);
  if (fs.length === 0) return null;
  // A line drawn again over an earlier one (e.g. one leg of a "×" retraced)
  // counts once. Only for 3+ strokes, so a 2-bar "=" can never collapse into "−".
  if (fs.length >= 3) fs = dropRetraced(fs, lineHeight);
  // Bars must have real length, so a stray tap can never become half of "=" or "+".
  const minBar = BAR_MIN * lineHeight;
  const hBar = (f: StrokeFeatures) => isHorizontal(f) && f.w >= minBar;
  const vBar = (f: StrokeFeatures) => isVertical(f) && f.h >= minBar;
  const diag = (f: StrokeFeatures) => isDiagonal(f) && f.size >= minBar;

  // Several tiny taps on one spot (a double-tapped decimal point) are one ".".
  if (fs.length > 1 && fs.every((f) => isDot(f, lineHeight))) {
    const u = bboxOfPoints(fs.flatMap((f) => f.pts));
    if (Math.max(bboxWidth(u), bboxHeight(u)) <= 1.3 * Math.max(DOT_MAX * lineHeight, 4)) return { symbol: '.', confidence: 0.85 };
  }

  if (fs.length === 1) {
    const [f] = fs;
    if (isDot(f, lineHeight)) return { symbol: '.', confidence: 0.9 };
    if (hBar(f)) return { symbol: '−', confidence: 0.9 };
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
    // A minus drawn over several times: two flat strokes on top of each other.
    const ba = bboxOfPoints(a.pts);
    const bb = bboxOfPoints(b.pts);
    const stacked = cross || Math.abs(a.cy - b.cy) <= 0.1 * Math.max(a.w, b.w);
    if (hBar(a) && hBar(b) && stacked && rangeOverlap(ba.minX, ba.maxX, bb.minX, bb.maxX) >= 0.5 * Math.min(a.w, b.w)) {
      return { symbol: '−', confidence: 0.85 };
    }
    if (hBar(a) && hBar(b) && !cross) {
      const gap = Math.abs(a.cy - b.cy);
      if (gap > 0.1 * Math.max(a.w, b.w)) return { symbol: '=', confidence: 0.95 };
    }
    // Real handwriting often leaves a tiny gap where the two bars should cross,
    // so a near-miss (crossing once both bars are extended by 30%) also counts.
    const touches = cross || nearlyCross(a, b, 0.3);
    if (touches) {
      if ((hBar(a) && vBar(b)) || (vBar(a) && hBar(b))) {
        return { symbol: '+', confidence: cross ? 0.92 : 0.85 };
      }
      // Strokes that really cross are strong evidence of "+": accept a tilted or
      // hooked bar — as long as it stays thin relative to the other bar, which
      // keeps an open "4" (corner stroke + crossing stem) out.
      if (cross && (looseCross(a, b, minBar) || looseCross(b, a, minBar))) return { symbol: '+', confidence: 0.8 };
      // Same idea for "×": two legs that really cross, with opposite slopes, may be
      // slightly curved (a real leg measured 0.79). A stem is never diagonal, so an
      // open "4" can't pass this.
      const looseDiag = (f: StrokeFeatures, max = 70) => f.straightness > 0.7 && fromHorizontal(f) >= 20 && fromHorizontal(f) <= max && f.size >= minBar;
      // One leg may be steep (a real one was 72°) as long as the other is a clear diagonal.
      const xLegs = (looseDiag(a) && looseDiag(b, 78)) || (looseDiag(b) && looseDiag(a, 78));
      if (cross && xLegs && a.angle < 90 !== b.angle < 90) return { symbol: '×', confidence: 0.8 };
      if (cross && looseDiag(a) && looseDiag(b) && a.angle < 90 !== b.angle < 90) return { symbol: '×', confidence: 0.8 };
      if (diag(a) && diag(b)) {
        // Opposite slopes: one rising, one falling.
        const slopeA = a.angle < 90;
        const slopeB = b.angle < 90;
        if (slopeA !== slopeB) return { symbol: '×', confidence: cross ? 0.92 : 0.85 };
      }
    }
    return null;
  }

  // ÷ : exactly one real bar, and every other stroke a small mark (a dot, a
  // short dash, or several taps on the same spot), with marks above and below.
  if (fs.length >= 3) {
    const bars = fs.filter(hBar);
    if (bars.length === 1) {
      const [bar] = bars;
      const marks = fs.filter((f) => f !== bar);
      const markMax = Math.max(DIVIDE_MARK_MAX * lineHeight, 6);
      if (marks.every((m) => m.size <= markMax && m.size < bar.w)) {
        const above = marks.some((m) => m.cy < bar.cy);
        const below = marks.some((m) => m.cy > bar.cy);
        if (above && below) return { symbol: '÷', confidence: 0.93 };
      }
    }
  }
  return null;
}

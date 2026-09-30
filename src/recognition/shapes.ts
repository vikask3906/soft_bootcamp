import {
  bboxHeight,
  bboxOfPoints,
  bboxWidth,
  distToSegmentSq,
  pathLength,
  polylinesIntersect,
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

export type ShapeSymbol = '+' | '−' | '×' | '÷' | '=' | '.' | '1';

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

export function strokeFeatures(pts: readonly XY[]): StrokeFeatures {
  const b = bboxOfPoints(pts);
  const w = bboxWidth(b);
  const h = bboxHeight(b);
  const a = pts[0];
  const z = pts[pts.length - 1];
  const chord = Math.hypot(z.x - a.x, z.y - a.y);
  const len = pathLength(pts);
  let maxDev = 0;
  for (const p of pts) maxDev = Math.max(maxDev, Math.sqrt(distToSegmentSq(p, a, z)));
  const straightness = len === 0 ? 0 : Math.min(chord / len, 1 - maxDev / Math.max(chord, 1e-6) / 2);
  let angle = (Math.atan2(z.y - a.y, z.x - a.x) * 180) / Math.PI;
  if (angle < 0) angle += 180;
  if (angle >= 180) angle -= 180;
  return { pts, w, h, size: Math.max(w, h), cx: (b.minX + b.maxX) / 2, cy: (b.minY + b.maxY) / 2, straightness, angle };
}

const isStraight = (f: StrokeFeatures) => f.straightness > 0.85;
/** Angular distance from horizontal, in degrees (0..90). */
const fromHorizontal = (f: StrokeFeatures) => Math.min(f.angle, 180 - f.angle);
const isHorizontal = (f: StrokeFeatures) => isStraight(f) && fromHorizontal(f) < 25 && f.w > 1.8 * f.h;
const isVertical = (f: StrokeFeatures) => isStraight(f) && fromHorizontal(f) > 60;
const isDiagonal = (f: StrokeFeatures) => isStraight(f) && fromHorizontal(f) >= 20 && fromHorizontal(f) <= 70;
const isDot = (f: StrokeFeatures, lineHeight: number) => f.size <= Math.max(0.2 * lineHeight, 4);

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
    // A single straight near-vertical bar is a "1"; MNIST handles slanted/serif ones.
    if (isVertical(f) && f.h > 0.5 * lineHeight && fromHorizontal(f) > 75) return { symbol: '1', confidence: 0.9 };
    return null;
  }

  if (fs.length === 2) {
    const [a, b] = fs;
    const cross = polylinesIntersect(a.pts, b.pts);
    if (isHorizontal(a) && isHorizontal(b) && !cross) {
      const gap = Math.abs(a.cy - b.cy);
      if (gap > 0.1 * Math.max(a.w, b.w)) return { symbol: '=', confidence: 0.95 };
    }
    if (cross) {
      if ((isHorizontal(a) && isVertical(b)) || (isVertical(a) && isHorizontal(b))) {
        return { symbol: '+', confidence: 0.92 };
      }
      if (isDiagonal(a) && isDiagonal(b)) {
        // Opposite slopes: one rising, one falling.
        const slopeA = a.angle < 90;
        const slopeB = b.angle < 90;
        if (slopeA !== slopeB) return { symbol: '×', confidence: 0.92 };
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

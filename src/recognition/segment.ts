import { bboxHeight, bboxOfPoints, bboxWidth, rangeOverlap, unionBBox, type XY } from '../ink/geometry';
import type { BBox } from '../ink/types';
import { strokeFeatures } from './shapes';

/** The minimal stroke shape the recogniser needs (transferable to a Worker). */
export interface RecStroke {
  id: number;
  order: number;
  pts: XY[];
}

export interface SymbolGroup {
  strokes: RecStroke[];
  bbox: BBox;
}

export interface Line {
  symbols: SymbolGroup[];
  bbox: BBox;
  /** Typical glyph height on this line, used as the recogniser's unit of scale. */
  height: number;
}

interface Item {
  s: RecStroke;
  b: BBox;
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const a = [...xs].sort((p, q) => p - q);
  return a[Math.floor(a.length / 2)];
}

/**
 * Splits a page of strokes into text lines, then each line into symbols.
 *
 * 1. "Tall" strokes (digits, vertical bars) are clustered into lines by
 *    vertical overlap; small strokes (dots, dashes) are then attached to the
 *    line whose band contains them — this keeps a decimal point that sits
 *    slightly below the baseline on its own line.
 * 2. Lines are split where the horizontal gap is larger than 2.5× the line
 *    height, so two equations side by side stay independent.
 * 3. Within a line, strokes sorted by x are merged into a symbol when they
 *    overlap horizontally and were written close together in time.
 */
export function segment(strokes: readonly RecStroke[]): Line[] {
  const items: Item[] = strokes.filter((s) => s.pts.length > 0).map((s) => ({ s, b: bboxOfPoints(s.pts) }));
  if (items.length === 0) return [];

  const heights = items.map((i) => bboxHeight(i.b)).filter((h) => h > 6);
  const unit = Math.max(median(heights), 16);
  const isTall = (i: Item) => bboxHeight(i.b) >= 0.45 * unit;

  // --- 1a. Cluster tall strokes by vertical overlap (union-find).
  const tall = items.filter(isTall);
  const small = items.filter((i) => !isTall(i));
  const parent = tall.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < tall.length; i++) {
    for (let j = i + 1; j < tall.length; j++) {
      const a = tall[i].b;
      const b = tall[j].b;
      const ov = rangeOverlap(a.minY, a.maxY, b.minY, b.maxY);
      if (ov >= 0.4 * Math.min(bboxHeight(a), bboxHeight(b))) parent[find(i)] = find(j);
    }
  }
  const bands = new Map<number, Item[]>();
  tall.forEach((it, i) => {
    const r = find(i);
    if (!bands.has(r)) bands.set(r, []);
    bands.get(r)!.push(it);
  });
  const groups: Item[][] = [...bands.values()];

  // --- 1b. Attach small strokes to the nearest band that vertically contains them.
  for (const it of small) {
    const cy = (it.b.minY + it.b.maxY) / 2;
    let best: Item[] | null = null;
    let bestDist = Infinity;
    for (const g of groups) {
      const gb = g.map((x) => x.b).reduce(unionBBox);
      const h = bboxHeight(gb);
      const top = gb.minY - 0.35 * h;
      const bottom = gb.maxY + 0.35 * h;
      if (cy < top || cy > bottom) continue;
      const dx = Math.max(0, gb.minX - it.b.maxX, it.b.minX - gb.maxX);
      if (dx > 3 * h) continue;
      const d = Math.abs(cy - (gb.minY + gb.maxY) / 2) + dx;
      if (d < bestDist) {
        bestDist = d;
        best = g;
      }
    }
    if (best) best.push(it);
    else groups.push([it]);
  }

  // --- 2. Split each band on large horizontal gaps, then build symbols.
  const lines: Line[] = [];
  for (const g of groups) {
    g.sort((a, b) => a.b.minX - b.b.minX);
    const lineHeight = estimateLineHeight(g);
    let chunk: Item[] = [];
    let reach = -Infinity;
    for (const it of g) {
      if (chunk.length > 0 && it.b.minX - reach > 2.5 * lineHeight) {
        lines.push(buildLine(chunk, lineHeight));
        chunk = [];
      }
      chunk.push(it);
      reach = Math.max(reach, it.b.maxX);
    }
    if (chunk.length) lines.push(buildLine(chunk, lineHeight));
  }
  lines.sort((a, b) => a.bbox.minY - b.bbox.minY || a.bbox.minX - b.bbox.minX);
  return lines;
}

function paddedRange(lo: number, hi: number, minW: number): [number, number] {
  if (hi - lo >= minW) return [lo, hi];
  const c = (lo + hi) / 2;
  return [c - minW / 2, c + minW / 2];
}

function estimateLineHeight(items: Item[]): number {
  const hs = items.map((i) => bboxHeight(i.b));
  const maxH = Math.max(...hs);
  const tallish = hs.filter((h) => h >= 0.5 * maxH);
  return Math.max(median(tallish), 12);
}

function buildLine(items: Item[], lineHeight: number): Line {
  const minW = 0.15 * lineHeight;
  const dotSize = Math.max(0.2 * lineHeight, 4);
  const isDotItem = (i: Item) => Math.max(bboxWidth(i.b), bboxHeight(i.b)) <= dotSize;
  const isBar = (i: Item) => {
    const f = strokeFeatures(i.s.pts);
    return f.straightness > 0.85 && f.w > 1.8 * f.h;
  };

  const syms: { items: Item[]; b: BBox }[] = [];
  for (const it of items) {
    let target: { items: Item[]; b: BBox } | null = null;
    // Only look back a few symbols: merging is a local decision.
    for (let k = syms.length - 1; k >= Math.max(0, syms.length - 3); k--) {
      const sym = syms[k];
      // Pad very narrow ranges (a vertical bar has ~0 width) to minW around their centre.
      const [a0, a1] = paddedRange(sym.b.minX, sym.b.maxX, minW);
      const [b0, b1] = paddedRange(it.b.minX, it.b.maxX, minW);
      const ov = rangeOverlap(a0, a1, b0, b1);
      const wa = a1 - a0;
      const wb = b1 - b0;
      const ratioNarrow = ov / Math.min(wa, wb);
      const ratioWide = ov / Math.max(wa, wb);
      if (ratioNarrow < 0.5) continue;
      const adjacent = sym.items.some((x) => Math.abs(x.s.order - it.s.order) <= 2);
      if (!adjacent && ratioWide < 0.5) continue;
      // Dots only join a symbol containing a bar (÷), and vice versa for bars
      // joining lone dots — keeps decimal points separate from digits.
      const symOnlyDots = sym.items.every(isDotItem);
      if (isDotItem(it) && !sym.items.some(isBar)) continue;
      if (symOnlyDots && !isBar(it)) continue;
      target = sym;
      break;
    }
    if (target) {
      target.items.push(it);
      target.b = unionBBox(target.b, it.b);
    } else {
      syms.push({ items: [it], b: { ...it.b } });
    }
  }

  const symbols: SymbolGroup[] = syms
    .map((s) => ({ strokes: s.items.sort((a, b) => a.s.order - b.s.order).map((i) => i.s), bbox: s.b }))
    .sort((a, b) => (a.bbox.minX + a.bbox.maxX) / 2 - (b.bbox.minX + b.bbox.maxX) / 2);
  return { symbols, bbox: symbols.map((s) => s.bbox).reduce(unionBBox), height: lineHeight };
}

import {
  bboxHeight,
  bboxOfPoints,
  bboxWidth,
  distToPolyline,
  pathLength,
  polylinesIntersect,
  rangeOverlap,
  unionBBox,
  type XY,
} from '../ink/geometry';
import type { BBox } from '../ink/types';
import { BAR_MIN, DIVIDE_MARK_MAX, DOT_MAX, strokeFeatures } from './shapes';

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
      const minH = Math.min(bboxHeight(a), bboxHeight(b));
      const maxH = Math.max(bboxHeight(a), bboxHeight(b));
      if (rangeOverlap(a.minY, a.maxY, b.minY, b.maxY) <= 0) continue;
      // Same row ⇔ vertical centres line up. This accepts a big bracket around
      // small digits (same centre, 3× taller) but rejects a scribble or a
      // stroke spanning two rows (its centre falls between them).
      const dCenter = Math.abs((a.minY + a.maxY) / 2 - (b.minY + b.maxY) / 2);
      if (dCenter > 0.5 * Math.max(minH, 0.5 * unit)) continue;
      // Only link horizontal neighbours: a row is a chain of nearby glyphs, so one
      // sloppy stroke can't pull far-away ink into the row. Generous, because
      // people leave wide spaces around operators (small strokes don't bridge here).
      const gap = Math.max(0, a.minX - b.maxX, b.minX - a.maxX);
      if (gap > 3.5 * Math.max(maxH, unit)) continue;
      parent[find(i)] = find(j);
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
      if (chunk.length > 0 && it.b.minX - reach > 3.5 * lineHeight) {
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

/** Smallest distance between two polylines (0 if they cross). */
function polylineGap(a: readonly XY[], b: readonly XY[]): number {
  if (polylinesIntersect(a, b)) return 0;
  let best = Infinity;
  for (const p of a) best = Math.min(best, distToPolyline(p, b));
  for (const p of b) best = Math.min(best, distToPolyline(p, a));
  return best;
}

function paddedRange(lo: number, hi: number, minW: number): [number, number] {
  if (hi - lo >= minW) return [lo, hi];
  const c = (lo + hi) / 2;
  return [c - minW / 2, c + minW / 2];
}

/**
 * Typical glyph height on a line — the unit every size threshold is relative to.
 * Median height of the upright strokes with a real amount of ink (digits,
 * brackets) — flat bars, dots and short "÷" dashes are ignored, and digits
 * normally outnumber brackets, so neither can skew it. Measured bugs this avoids:
 * "strokes ≥ half the tallest" gave 55 px for ~25 px digits inside 81 px
 * brackets; "all upright strokes" gave 10 px for "9÷0=" whose ÷ dots were dashes.
 */
export function estimateLineHeight(items: { b: BBox; s: RecStroke }[]): number {
  const inkOf = new Map(items.map((i) => [i, pathLength(i.s.pts)]));
  const maxInk = Math.max(...inkOf.values());
  const upright = items
    .filter((i) => bboxHeight(i.b) >= 0.6 * bboxWidth(i.b) && inkOf.get(i)! >= 0.3 * maxInk)
    .map((i) => bboxHeight(i.b));
  const h = upright.length ? median(upright) : Math.max(...items.map((i) => bboxHeight(i.b)));
  return Math.max(h, 12);
}

function buildLine(items: Item[], lineHeight: number): Line {
  const minW = 0.15 * lineHeight;
  const dotSize = Math.max(DOT_MAX * lineHeight, 4);
  const markMax = Math.max(DIVIDE_MARK_MAX * lineHeight, 6);
  const size = (i: Item) => Math.max(bboxWidth(i.b), bboxHeight(i.b));
  const isDotItem = (i: Item) => size(i) <= dotSize;
  const barCache = new Map<Item, boolean>();
  const isBar = (i: Item) => {
    let v = barCache.get(i);
    if (v === undefined) {
      const f = strokeFeatures(i.s.pts);
      v = ((f.straightness > 0.85 && f.w > 1.8 * f.h) || f.w > 3.5 * Math.max(f.h, 1)) && f.w >= BAR_MIN * lineHeight;
      barCache.set(i, v);
    }
    return v;
  };
  /** A dot, short dash or tap — what "÷" marks look like in real handwriting. */
  const isMark = (i: Item) => size(i) <= markMax && !isBar(i);
  const cy = (b: BBox) => (b.minY + b.maxY) / 2;

  type Sym = { items: Item[]; b: BBox };
  const syms: Sym[] = [];

  /**
   * "÷" marks join the bar they sit above/below, whatever order they were
   * written in (people often tap a dot twice, or add the dots last).
   */
  const divisionBarFor = (it: Item): Sym | null => {
    if (!isMark(it)) return null;
    const mx = (it.b.minX + it.b.maxX) / 2;
    for (let k = syms.length - 1; k >= 0; k--) {
      const sym = syms[k];
      const bars = sym.items.filter(isBar);
      if (bars.length !== 1 || !sym.items.every((x) => x === bars[0] || isMark(x))) continue;
      const bar = bars[0].b;
      const pad = 0.15 * bboxWidth(bar);
      const dy = Math.abs(cy(it.b) - cy(bar));
      if (mx >= bar.minX - pad && mx <= bar.maxX + pad && dy >= 0.1 * lineHeight && dy <= 0.9 * lineHeight) return sym;
    }
    return null;
  };

  /** A dot tapped twice (two tiny strokes a hair apart) is one decimal point. */
  const doubleTapFor = (it: Item): Sym | null => {
    if (!isDotItem(it)) return null;
    for (let k = syms.length - 1; k >= Math.max(0, syms.length - 3); k--) {
      const sym = syms[k];
      if (!sym.items.every(isDotItem)) continue;
      const gap = Math.max(0, sym.b.minX - it.b.maxX, it.b.minX - sym.b.maxX, sym.b.minY - it.b.maxY, it.b.minY - sym.b.maxY);
      const u = unionBBox(sym.b, it.b);
      if (gap <= 0.2 * lineHeight && Math.max(bboxWidth(u), bboxHeight(u)) <= 1.3 * dotSize) return sym;
    }
    return null;
  };

  /**
   * Strokes that physically belong together, regardless of the overlap test:
   *  F. they CROSS — whenever they were written (e.g. a "+" whose second bar was
   *     drawn after erasing something) — as long as together they're no wider
   *     than one symbol, so a sloppy stroke can't glue two digits;
   *  J. they were drawn one right after the other and TOUCH — an open "4" whose
   *     stem just meets the end of the first stroke — and together are narrower
   *     than a symbol and not taller than a digit.
   */
  const physicalPartnerFor = (it: Item): Sym | null => {
    if (isMark(it) || isDotItem(it)) return null;
    for (let k = syms.length - 1; k >= Math.max(0, syms.length - 3); k--) {
      const sym = syms[k];
      if (sym.items.every((x) => isMark(x) || isDotItem(x))) continue;
      const u = unionBBox(sym.b, it.b);
      const crosses = bboxWidth(u) <= 1.2 * lineHeight && sym.items.some((x) => polylinesIntersect(x.s.pts, it.s.pts));
      if (crosses) return sym;
      const last = sym.items.reduce((a, b) => (a.s.order > b.s.order ? a : b));
      const touches =
        it.s.order === last.s.order + 1 &&
        bboxWidth(u) <= 0.8 * lineHeight &&
        bboxHeight(u) <= 1.3 * lineHeight &&
        polylineGap(last.s.pts, it.s.pts) <= Math.max(1.5, 0.1 * lineHeight);
      if (touches) return sym;
    }
    return null;
  };

  for (const it of items) {
    let target: Sym | null = divisionBarFor(it) ?? doubleTapFor(it) ?? physicalPartnerFor(it);
    // Only look back a few symbols: merging is a local decision.
    for (let k = syms.length - 1; !target && k >= Math.max(0, syms.length - 3); k--) {
      const sym = syms[k];
      // Pad very narrow ranges (a vertical bar has ~0 width) to minW around their centre.
      const [a0, a1] = paddedRange(sym.b.minX, sym.b.maxX, minW);
      const [b0, b1] = paddedRange(it.b.minX, it.b.maxX, minW);
      const ov = rangeOverlap(a0, a1, b0, b1);
      const wa = a1 - a0;
      const wb = b1 - b0;
      const ratioNarrow = ov / Math.min(wa, wb);
      const ratioWide = ov / Math.max(wa, wb);
      const adjacent = sym.items.some((x) => Math.abs(x.s.order - it.s.order) <= 2);
      if (ratioNarrow < 0.5) continue;
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

  // Late "cap" strokes: the top bar of a 5 (or 7) is often added after the rest
  // of the line. A lone short bar in the TOP part of a digit it overlaps belongs
  // to that digit; a real minus sits at mid-height, and "=" bars come in pairs.
  const merged = new Set<Sym>();
  for (const bar of syms) {
    if (bar.items.length !== 1 || !isBar(bar.items[0])) continue;
    const bb = bar.b;
    const barW = Math.max(bboxWidth(bb), 1);
    const paired = syms.some(
      (o) => o !== bar && o.items.length === 1 && isBar(o.items[0]) && rangeOverlap(o.b.minX, o.b.maxX, bb.minX, bb.maxX) >= 0.5 * barW && Math.abs(cy(o.b) - cy(bb)) <= 0.7 * lineHeight,
    );
    if (paired) continue;
    const host = syms.find((d) => {
      if (d === bar || merged.has(d) || d.items.every((x) => isBar(x) || isMark(x))) return false;
      const h = bboxHeight(d.b);
      if (h < 0.5 * lineHeight) return false;
      const ov = rangeOverlap(d.b.minX, d.b.maxX, bb.minX, bb.maxX);
      const atTop = cy(bb) <= d.b.minY + 0.35 * h && cy(bb) >= d.b.minY - 0.25 * lineHeight;
      if (!atTop) return false;
      if (ov >= 0.4 * barW) return true;
      // A long cap that sticks out to the side: accept it when it was drawn right
      // after the digit and touches it (a real "5" cap measured only 26% overlap).
      const capStroke = bar.items[0];
      const last = d.items.reduce((p, q) => (p.s.order > q.s.order ? p : q));
      return ov > 0 && capStroke.s.order === last.s.order + 1 && polylineGap(last.s.pts, capStroke.s.pts) <= Math.max(1.5, 0.1 * lineHeight);
    });
    if (host) {
      host.items.push(bar.items[0]);
      host.b = unionBBox(host.b, bb);
      merged.add(bar);
    }
  }

  const symbols: SymbolGroup[] = syms
    .filter((s) => !merged.has(s))
    .map((s) => ({ strokes: s.items.sort((a, b) => a.s.order - b.s.order).map((i) => i.s), bbox: s.b }))
    .sort((a, b) => (a.bbox.minX + a.bbox.maxX) / 2 - (b.bbox.minX + b.bbox.maxX) / 2);
  return { symbols, bbox: symbols.map((s) => s.bbox).reduce(unionBBox), height: lineHeight };
}

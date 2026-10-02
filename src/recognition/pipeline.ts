import { bboxOfPoints, unionBBox } from '../ink/geometry';
import type { BBox } from '../ink/types';
import { evaluate, formatResult, type EvalResult } from '../math/evaluate';
import { deskew, toPage, type RowTransform } from './deskew';
import { rasterizeStrokes } from './rasterize';
import { segment, type RecStroke, type SymbolGroup } from './segment';
import { bracketMeasure, classifyOperator, MIN_BRACKET_BOW, strokeFeatures } from './shapes';

export interface DigitPrediction {
  digit: number;
  confidence: number;
  /** Runner-up digits, most likely first. */
  alternatives?: { digit: number; p: number }[];
}

/** Batched digit classifier — implemented by the ONNX model in the worker, mocked in tests. */
export type DigitClassifier = (tensors: Float32Array[]) => Promise<DigitPrediction[]>;

export interface RecognizedSymbol {
  symbol: string;
  confidence: number;
  bbox: BBox;
  /** 'repair' = changed automatically by the bracket-balance safety net. */
  source: 'shape' | 'model' | 'user' | 'repair';
  /** Stable identity of the symbol: its stroke ids. A correction is stored against it. */
  key: string;
  /** Likely alternatives, best first (model runner-ups, or common confusions for shapes). */
  alternatives: string[];
  /** What the recogniser read before a correction or repair (source 'user' / 'repair'). */
  recognizedAs?: string;
}

/**
 * User corrections from tap-to-correct: symbol key → replacement symbol, or
 * IGNORE to drop a stray mark. Keys are stroke ids, so erasing or rewriting a
 * symbol automatically invalidates its correction.
 */
export type Corrections = Record<string, string>;
export const IGNORE = '∅';

export interface EquationResult {
  /** Stable identity: the stroke ids of the "=" sign. */
  key: string;
  expression: string;
  symbols: RecognizedSymbol[];
  result: EvalResult;
  display: string;
  /** Lowest per-symbol confidence — the chain is only as strong as its weakest link. */
  confidence: number;
  /** Where to draw the answer: right edge of "=", vertical centre and height of the line. */
  /** `angle` (radians) is the row's slope, so the answer can follow a slanted row. */
  anchor: { x: number; y: number; height: number; angle: number };
}

/** Maps handwriting glyphs to the evaluator's input alphabet. */
const TO_EXPR: Record<string, string> = { '−': '-', '×': '*', '÷': '/' };

/** Plausible confusions for shape-recognised symbols (offered first when correcting). */
const SHAPE_ALTERNATIVES: Record<string, string[]> = {
  '1': ['7', '(', ')'],
  '(': ['1', ')'],
  ')': ['1', '('],
  '+': ['×', '÷', '4'],
  '×': ['+', '4'],
  '÷': ['+', '−'],
  '−': ['1'],
  '.': ['0', '1'],
  '=': ['−'],
};

export const symbolKey = (sym: SymbolGroup) => sym.strokes.map((s) => s.id).join(',');

/** What was read on one line of the page — shown to the user even when it isn't a solvable equation. */
export interface LineReading {
  text: string;
  /** Top of the line in world coordinates (for ordering). */
  y: number;
  solved: boolean;
}

export async function recognizePage(
  strokes: readonly RecStroke[],
  classifyDigits: DigitClassifier,
  corrections: Corrections = {},
): Promise<EquationResult[]> {
  return (await recognizeDetailed(strokes, classifyDigits, false, corrections)).equations;
}

/**
 * Full recognition. With `readAllLines`, digits on lines without "=" are
 * classified too, so the UI can show "18+7 — add = to solve" instead of
 * silently doing nothing.
 */
export async function recognizeDetailed(
  strokes: readonly RecStroke[],
  classifyDigits: DigitClassifier,
  readAllLines = false,
  corrections: Corrections = {},
): Promise<{ equations: EquationResult[]; lines: LineReading[] }> {
  // Straighten slanted rows first; recognition runs on the upright copy.
  const { strokes: upright, transforms } = deskew(strokes);
  // Each straightened row is segmented on its own (straight writing together):
  // rows rotated about different centres may overlap in upright space.
  const groups = new Map<RowTransform | undefined, RecStroke[]>();
  for (const s of upright) {
    const t = transforms.get(s.id);
    if (!groups.has(t)) groups.set(t, []);
    groups.get(t)!.push(s);
  }
  const lines = [...groups.values()].flatMap((g) => segment(g));
  // Page-space boxes for the UI (tap-to-correct labels sit under the real ink).
  const pageBox = new Map(strokes.filter((s) => s.pts.length).map((s) => [s.id, bboxOfPoints(s.pts)]));
  const toPageBox = (sym: RecognizedSymbol): RecognizedSymbol => {
    const ids = sym.key.split(',').map(Number);
    const boxes = ids.map((id) => pageBox.get(id)).filter((b): b is BBox => !!b);
    return boxes.length && ids.some((id) => transforms.has(id)) ? { ...sym, bbox: boxes.reduce(unionBBox) } : sym;
  };

  // Pass 1: geometric operators; collect everything else for one batched model call.
  // A symbol the user corrected skips recognition entirely.
  const pending: { line: number; sym: number; tensor: Float32Array }[] = [];
  const recognized: (RecognizedSymbol | null)[][] = lines.map((line, li) =>
    line.symbols.map((sym, si) => {
      const key = symbolKey(sym);
      const pts = sym.strokes.map((s) => s.pts);
      const guess = classifyOperator(pts, line.height);
      if (guess) {
        return { symbol: guess.symbol, confidence: guess.confidence, bbox: sym.bbox, source: 'shape', key, alternatives: SHAPE_ALTERNATIVES[guess.symbol] ?? [] };
      }
      pending.push({ line: li, sym: si, tensor: rasterizeStrokes(pts) });
      return null;
    }),
  );

  // Only lines containing "=" (as read, or as corrected) can hold equations; skip model work for the rest.
  const isEquationLine = lines.map((line, li) =>
    line.symbols.some((group, si) => (corrections[symbolKey(group)] ?? recognized[li][si]?.symbol) === '='),
  );
  const needed = readAllLines ? pending : pending.filter((p) => isEquationLine[p.line]);
  if (needed.length > 0) {
    const preds = await classifyDigits(needed.map((p) => p.tensor));
    needed.forEach((p, i) => {
      const sym = lines[p.line].symbols[p.sym];
      recognized[p.line][p.sym] = {
        symbol: String(preds[i].digit),
        confidence: preds[i].confidence,
        bbox: sym.bbox,
        source: 'model',
        key: symbolKey(sym),
        alternatives: (preds[i].alternatives ?? []).map((a) => String(a.digit)),
      };
    });
  }

  // K. A lone "." clearly ABOVE the digits is a stray pen touch, not a decimal
  // point (those sit at mid-height or on the baseline): drop it. A user
  // correction on it still wins, since corrections are applied below.
  lines.forEach((line, li) => {
    const mid = digitMidline(line.symbols, line.height);
    if (mid === null) return;
    recognized[li].forEach((rec, si) => {
      if (rec?.symbol !== '.' || rec.source !== 'shape') return;
      const b = line.symbols[si].bbox;
      if ((b.minY + b.maxY) / 2 < mid - 0.3 * line.height) recognized[li][si] = { ...rec, symbol: IGNORE };
    });
  });

  // Apply user corrections, and drop marks the user chose to ignore.
  const rows = lines.map((line, li) =>
    line.symbols
      .map((group, si) => {
        const key = symbolKey(group);
        const rec = recognized[li][si] ?? { symbol: '?', confidence: 0, bbox: group.bbox, source: 'model' as const, key, alternatives: [] };
        const fix = corrections[key];
        // Any stored correction is the user's decision — even one that confirms the
        // reading — so the automatic bracket repair must never touch it.
        const final: RecognizedSymbol = fix === undefined ? rec : { ...rec, symbol: fix, confidence: 1, source: 'user', recognizedAs: rec.symbol };
        return { group, rec: final };
      })
      .filter((e) => e.rec.symbol !== IGNORE),
  );

  const results: EquationResult[] = [];
  lines.forEach((line, li) => {
    if (!isEquationLine[li]) return;
    const row = rows[li];
    const syms = row.map((e) => e.rec);
    let start = 0;
    syms.forEach((eq, k) => {
      if (eq.symbol !== '=') return;
      let exprSyms = syms.slice(start, k);
      const from = start;
      start = k + 1;
      if (exprSyms.length === 0 || !hasRoomForAnswer(syms, k, line.height)) return;
      let expression = toExpression(exprSyms);
      let result = evaluate(expression);
      // Safety net: an error with unbalanced brackets is most likely a "(" / ")"
      // misread as "1" or vice versa. Try the most plausible swaps.
      if (result.kind === 'error' && !bracketsBalanced(exprSyms)) {
        const repaired = repairBrackets(row.slice(from, k));
        if (repaired) {
          repaired.forEach((e, i) => (row[from + i] = e));
          exprSyms = repaired.map((e) => e.rec);
          expression = toExpression(exprSyms);
          result = evaluate(expression);
        }
      }
      results.push({
        key: row[k].rec.key,
        expression: exprSyms.map((s) => s.symbol).join(''),
        symbols: exprSyms.map(toPageBox),
        result,
        display: formatResult(result),
        confidence: Math.min(...exprSyms.map((s) => s.confidence), eq.confidence),
        anchor: anchorOnPage(eq, line, transforms.get(Number(eq.key.split(',')[0]))),
      });
    });
  });

  const readings: LineReading[] = lines.map((line, li) => ({
    text: rows[li].map((e) => e.rec.symbol).join(''),
    y: line.bbox.minY,
    solved: results.some((r) => rows[li].some((e) => e.rec.key === r.key)),
  }));
  return { equations: results, lines: readings };
}

/** Median vertical centre of the digit-sized symbols on a line (null if there are none). */
function digitMidline(symbols: SymbolGroup[], lineHeight: number): number | null {
  const cys = symbols
    .filter((s) => {
      const h = s.bbox.maxY - s.bbox.minY;
      return h >= 0.6 * lineHeight && h <= 1.6 * lineHeight;
    })
    .map((s) => (s.bbox.minY + s.bbox.maxY) / 2)
    .sort((a, b) => a - b);
  return cys.length ? cys[Math.floor(cys.length / 2)] : null;
}

/** Answer position: right of the "=", on the row's centre line — rotated back onto a slanted row. */
function anchorOnPage(eq: RecognizedSymbol, line: { bbox: BBox; height: number }, t: RowTransform | undefined) {
  const p = { x: eq.bbox.maxX, y: (line.bbox.minY + line.bbox.maxY) / 2 };
  const q = t ? toPage(p, t) : p;
  return { x: q.x, y: q.y, height: line.height, angle: t?.angle ?? 0 };
}

const toExpression = (syms: RecognizedSymbol[]) => syms.map((s) => TO_EXPR[s.symbol] ?? s.symbol).join('');

export function bracketsBalanced(syms: { symbol: string }[]): boolean {
  let depth = 0;
  for (const s of syms) {
    if (s.symbol === '(') depth++;
    else if (s.symbol === ')' && --depth < 0) return false;
  }
  return depth === 0;
}

type Entry = { group: SymbolGroup; rec: RecognizedSymbol };
type Swap = { index: number; to: string; plausibility: number };

/**
 * Bracket-balance repair. Candidates are symbols read as "1", "(" or ")"
 * (never ones the user corrected). Each possible swap gets a plausibility from
 * the stroke's bow: a "1" can become "(" only if it bows left, ")" only if it
 * bows right, and the more it bows the likelier; a bracket becomes "1" the
 * straighter it is. The most plausible single swap — or pair of swaps — that
 * makes the expression balanced AND valid wins. Returns null if none does.
 */
function repairBrackets(entries: Entry[]): Entry[] | null {
  const swaps: Swap[] = [];
  entries.forEach((e, index) => {
    const { symbol, source } = e.rec;
    if (source === 'user' || !['1', '(', ')'].includes(symbol) || e.group.strokes.length !== 1) return;
    const m = bracketMeasure(strokeFeatures(e.group.strokes[0].pts));
    if (!m) return;
    // Misreads only happen near the bracket/1 boundary (real "1"s bow ≤ 0.11,
    // real brackets ≥ 0.16): a dead-straight "1" or a clearly curved bracket is
    // never swapped. Plausibility peaks at the boundary.
    const plausibility = 1 - Math.abs(m.bow - MIN_BRACKET_BOW) / MIN_BRACKET_BOW;
    if (symbol === '1') {
      if (m.bow < 0.05) return;
      swaps.push({ index, to: m.left > m.right ? '(' : ')', plausibility }); // only the side it bows towards
    } else if (m.bow <= 0.2) {
      swaps.push({ index, to: '1', plausibility });
    }
  });
  if (swaps.length === 0) return null;
  swaps.sort((a, b) => b.plausibility - a.plausibility);
  const top = swaps.slice(0, 8);

  const tryApply = (chosen: Swap[]): Entry[] | null => {
    if (new Set(chosen.map((s) => s.index)).size !== chosen.length) return null;
    const next = entries.map((e, i) => {
      const s = chosen.find((c) => c.index === i);
      if (!s) return e;
      return {
        group: e.group,
        rec: { ...e.rec, symbol: s.to, source: 'repair' as const, confidence: 0.5, recognizedAs: e.rec.symbol, alternatives: [e.rec.symbol, ...e.rec.alternatives] },
      };
    });
    const syms = next.map((e) => e.rec);
    return bracketsBalanced(syms) && evaluate(toExpression(syms)).kind !== 'error' ? next : null;
  };

  let best: { entries: Entry[]; score: number } | null = null;
  for (const s of top) {
    const r = tryApply([s]);
    if (r && (!best || s.plausibility > best.score)) best = { entries: r, score: s.plausibility };
  }
  if (best) return best.entries;
  for (let i = 0; i < top.length; i++) {
    for (let j = i + 1; j < top.length; j++) {
      const score = top[i].plausibility * top[j].plausibility;
      if (best && score <= best.score) continue;
      const r = tryApply([top[i], top[j]]);
      if (r) best = { entries: r, score };
    }
  }
  return best?.entries ?? null;
}

/**
 * An "=" asks for an answer when nothing follows it, or when the next ink is
 * far enough away to be a separate equation. "2+2=4" (the user already wrote
 * an answer) is left alone.
 */
function hasRoomForAnswer(syms: RecognizedSymbol[], eqIndex: number, lineHeight: number): boolean {
  const next = syms[eqIndex + 1];
  if (!next) return true;
  return next.bbox.minX - syms[eqIndex].bbox.maxX > lineHeight;
}

import type { BBox } from '../ink/types';
import { evaluate, formatResult, type EvalResult } from '../math/evaluate';
import { rasterizeStrokes } from './rasterize';
import { segment, type RecStroke, type SymbolGroup } from './segment';
import { classifyOperator } from './shapes';

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
  source: 'shape' | 'model' | 'user';
  /** Stable identity of the symbol: its stroke ids. A correction is stored against it. */
  key: string;
  /** Likely alternatives, best first (model runner-ups, or common confusions for shapes). */
  alternatives: string[];
  /** What the recogniser read before a user correction (only for source 'user'). */
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
  anchor: { x: number; y: number; height: number };
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
  const lines = segment(strokes);

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

  // Apply user corrections, and drop marks the user chose to ignore.
  const rows = lines.map((line, li) =>
    line.symbols
      .map((group, si) => {
        const key = symbolKey(group);
        const rec = recognized[li][si] ?? { symbol: '?', confidence: 0, bbox: group.bbox, source: 'model' as const, key, alternatives: [] };
        const fix = corrections[key];
        const final: RecognizedSymbol =
          fix === undefined || fix === rec.symbol ? rec : { ...rec, symbol: fix, confidence: 1, source: 'user', recognizedAs: rec.symbol };
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
      const exprSyms = syms.slice(start, k);
      start = k + 1;
      if (exprSyms.length === 0 || !hasRoomForAnswer(syms, k, line.height)) return;
      const expression = exprSyms.map((s) => TO_EXPR[s.symbol] ?? s.symbol).join('');
      const result = evaluate(expression);
      results.push({
        key: row[k].rec.key,
        expression: exprSyms.map((s) => s.symbol).join(''),
        symbols: exprSyms,
        result,
        display: formatResult(result),
        confidence: Math.min(...exprSyms.map((s) => s.confidence), eq.confidence),
        anchor: { x: eq.bbox.maxX, y: (line.bbox.minY + line.bbox.maxY) / 2, height: line.height },
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

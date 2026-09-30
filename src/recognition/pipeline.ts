import type { BBox } from '../ink/types';
import { evaluate, formatResult, type EvalResult } from '../math/evaluate';
import { rasterizeStrokes } from './rasterize';
import { segment, type RecStroke } from './segment';
import { classifyOperator } from './shapes';

export interface DigitPrediction {
  digit: number;
  confidence: number;
}

/** Batched digit classifier — implemented by the ONNX model in the worker, mocked in tests. */
export type DigitClassifier = (tensors: Float32Array[]) => Promise<DigitPrediction[]>;

export interface RecognizedSymbol {
  symbol: string;
  confidence: number;
  bbox: BBox;
  source: 'shape' | 'model';
}

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

/** What was read on one line of the page — shown to the user even when it isn't a solvable equation. */
export interface LineReading {
  text: string;
  /** Top of the line in world coordinates (for ordering). */
  y: number;
  solved: boolean;
}

export async function recognizePage(strokes: readonly RecStroke[], classifyDigits: DigitClassifier): Promise<EquationResult[]> {
  return (await recognizeDetailed(strokes, classifyDigits)).equations;
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
): Promise<{ equations: EquationResult[]; lines: LineReading[] }> {
  const lines = segment(strokes);

  // Pass 1: geometric operators; collect everything else for one batched model call.
  const pending: { line: number; sym: number; tensor: Float32Array }[] = [];
  const recognized: (RecognizedSymbol | null)[][] = lines.map((line, li) =>
    line.symbols.map((sym, si) => {
      const pts = sym.strokes.map((s) => s.pts);
      const guess = classifyOperator(pts, line.height);
      if (guess) return { symbol: guess.symbol, confidence: guess.confidence, bbox: sym.bbox, source: 'shape' };
      pending.push({ line: li, sym: si, tensor: rasterizeStrokes(pts) });
      return null;
    }),
  );

  // Only lines containing "=" can hold equations; skip model work for the rest.
  const isEquationLine = recognized.map((syms) => syms.some((s) => s?.symbol === '='));
  const needed = readAllLines ? pending : pending.filter((p) => isEquationLine[p.line]);
  if (needed.length > 0) {
    const preds = await classifyDigits(needed.map((p) => p.tensor));
    needed.forEach((p, i) => {
      recognized[p.line][p.sym] = {
        symbol: String(preds[i].digit),
        confidence: preds[i].confidence,
        bbox: lines[p.line].symbols[p.sym].bbox,
        source: 'model',
      };
    });
  }

  const results: EquationResult[] = [];
  lines.forEach((line, li) => {
    if (!isEquationLine[li]) return;
    const syms = recognized[li] as RecognizedSymbol[];
    let start = 0;
    syms.forEach((eq, k) => {
      if (eq.symbol !== '=') return;
      const exprSyms = syms.slice(start, k);
      start = k + 1;
      if (exprSyms.length === 0 || !hasRoomForAnswer(syms, k, line.height)) return;
      const expression = exprSyms.map((s) => TO_EXPR[s.symbol] ?? s.symbol).join('');
      const result = evaluate(expression);
      results.push({
        key: line.symbols[k].strokes.map((s) => s.id).join(','),
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
    text: recognized[li].map((s) => s?.symbol ?? '?').join(''),
    y: line.bbox.minY,
    solved: results.some((r) => line.symbols.some((s) => s.strokes.map((x) => x.id).join(',') === r.key)),
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

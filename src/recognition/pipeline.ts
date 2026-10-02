import { bboxOfPoints, unionBBox } from '../ink/geometry';
import type { BBox } from '../ink/types';
import { evaluate, formatNumber, formatResult, solveLinear, type SolveResult } from '../math/evaluate';
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
  /**
   * evaluate: "18+4×3 =" → 30 (uses the stored x if the expression has one)
   * solve:    "2x+4 = 10" → x = 3 (and stores x for the lines below)
   * define:   "x = 10" → stores x = 10
   */
  mode: 'evaluate' | 'solve' | 'define';
  /** The expression as read; for solve/define it includes "=" and the right side. */
  expression: string;
  symbols: RecognizedSymbol[];
  result: SolveResult;
  display: string;
  /** solve/define: the value found for x. evaluate: the stored x that was used, if any. */
  x?: number;
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
  '×': ['x', '+', '4'],
  x: ['×', '2'],
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
  // Q. A dot smaller than 4.5% of the line height is a pen touch, not a decimal point
  // (measured: real decimal points ≥ 0.11 H; the touch that broke "72×34" was 0.028 H).
  lines.forEach((line, li) => {
    const mid = digitMidline(line.symbols, line.height);
    recognized[li].forEach((rec, si) => {
      if (rec?.symbol !== '.' || rec.source !== 'shape') return;
      const b = line.symbols[si].bbox;
      const tiny = Math.max(b.maxX - b.minX, b.maxY - b.minY) < 0.045 * line.height;
      const above = mid !== null && (b.minY + b.maxY) / 2 < mid - 0.3 * line.height;
      if (tiny || above) recognized[li][si] = { ...rec, symbol: IGNORE };
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

  // Split every equation line into equations: each "=" has a left side (since the
  // previous equation) and a right side (ink written close after it, if any).
  type Candidate = { li: number; from: number; k: number; to: number };
  const candidates: Candidate[] = [];
  lines.forEach((line, li) => {
    if (!isEquationLine[li]) return;
    const syms = rows[li].map((e) => e.rec);
    let i = 0;
    while (i < syms.length) {
      let k = i;
      while (k < syms.length && syms[k].symbol !== '=') k++;
      if (k >= syms.length) break;
      let m = k + 1;
      const near = (j: number) => syms[j].bbox.minX - syms[j - 1].bbox.maxX <= line.height;
      while (m < syms.length && syms[m].symbol !== '=' && near(m)) m++;
      if (k > i) candidates.push({ li, from: i, k, to: m });
      i = m;
    }
  });

  const hasX = (es: Entry[]) => es.some((e) => e.rec.symbol === 'x');
  const text = (es: Entry[]) => toExpression(es.map((e) => e.rec));

  type Solved = Candidate & {
    mode: EquationResult['mode'];
    entries: Entry[]; // from..to-1, possibly repaired
    result: SolveResult;
    x?: number;
  };
  const solved: Solved[] = [];
  const evaluateLater: Candidate[] = [];

  for (const c of candidates) {
    let entries = rows[c.li].slice(c.from, c.to);
    const eqAt = c.k - c.from;
    const split = (es: Entry[]) => [es.slice(0, eqAt), es.slice(eqAt + 1)] as const;
    const [, rhs0] = split(entries);
    if (rhs0.length === 0) {
      evaluateLater.push(c);
      continue;
    }
    // Something follows "=". With an x it's an equation to solve; without one the
    // user wrote their own answer ("2+2=4") — unless a "×" sits where a
    // multiplication makes no sense, i.e. it is really an x ("2×+4=10").
    const solvable = (es: Entry[]) => {
      const [l, r] = split(es);
      return (hasX(l) || hasX(r)) && solveLinear(text(l), text(r)).kind !== 'error';
    };
    const asX = repairX(entries, solvable);
    if (asX) entries = asX;
    else if (!hasX(entries)) continue;
    let [l, r] = split(entries);
    let result = solveLinear(text(l), text(r));
    if (result.kind === 'error') {
      const fixed = bracketsBalanced(l.map((e) => e.rec)) && bracketsBalanced(r.map((e) => e.rec)) ? null : repairBrackets(entries, solvable);
      if (fixed) {
        entries = fixed;
        [l, r] = split(entries);
        result = solveLinear(text(l), text(r));
      }
    }
    const isDef = (side: Entry[], other: Entry[]) => side.length === 1 && side[0].rec.symbol === 'x' && !hasX(other);
    const mode = isDef(l, r) || isDef(r, l) ? 'define' : 'solve';
    solved.push({ ...c, mode, entries, result, x: result.kind === 'ok' ? result.value : undefined });
  }

  // Where each definition of x sits on the page, so a later line uses the one just above it.
  const pageY = (c: Candidate) => {
    const eq = rows[c.li][c.k].rec;
    const t = transforms.get(Number(eq.key.split(',')[0]));
    const b = eq.bbox;
    const p = { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
    return (t ? toPage(p, t) : p).y;
  };
  const definitions = solved.filter((s) => s.x !== undefined).map((s) => ({ y: pageY(s), x: s.x! }));
  const storedXFor = (c: Candidate) => {
    const y = pageY(c);
    let best: { y: number; x: number } | undefined;
    for (const d of definitions) if (d.y < y && (!best || d.y > best.y)) best = d;
    return best?.x;
  };

  for (const c of evaluateLater) {
    let entries = rows[c.li].slice(c.from, c.k + 1);
    const lhs = () => entries.slice(0, -1);
    // Syntax check with a placeholder x (the real value may be unknown).
    const valid = (es: Entry[]) => evaluate(text(es.slice(0, -1)), 1).kind !== 'error';
    entries = repairX(entries, valid) ?? entries;
    let x = hasX(lhs()) ? storedXFor(c) : undefined;
    let result: SolveResult = evaluate(text(lhs()), x);
    if (result.kind === 'error' && result.code !== 'unknown-variable') {
      const fixed = bracketsBalanced(lhs().map((e) => e.rec)) ? null : repairBrackets(entries, valid);
      if (fixed) {
        entries = fixed;
        x = hasX(lhs()) ? storedXFor(c) : undefined;
        result = evaluate(text(lhs()), x);
      }
    }
    solved.push({ ...c, mode: 'evaluate', entries: [...entries, ...rows[c.li].slice(c.k + 1, c.to)], result, x });
  }

  // Typical digit height on the page (median height of the recognised digits): a
  // line made mostly of lower-case x's measures short, but its answer is digits
  // and should be drawn at digit size.
  const digitHeights = rows
    .flat()
    .filter((e) => e.rec.source === 'model' || /^[0-9]$/.test(e.rec.symbol))
    .map((e) => e.group.bbox.maxY - e.group.bbox.minY)
    .sort((a, b) => a - b);
  const typicalHeight = digitHeights.length ? digitHeights[Math.floor(digitHeights.length / 2)] : 0;

  const results: EquationResult[] = [];
  for (const s of solved.sort((a, b) => a.li - b.li || a.k - b.k)) {
    // Repairs are written back so the panel and tap-to-correct show them.
    s.entries.forEach((e, i) => (rows[s.li][s.from + i] = e));
    const eqAt = s.k - s.from;
    const lhs = s.entries.slice(0, eqAt).map((e) => e.rec);
    const rhs = s.entries.slice(eqAt + 1).map((e) => e.rec);
    const eq = s.entries[eqAt].rec;
    const line = lines[s.li];
    const t = transforms.get(Number(eq.key.split(',')[0]));
    const shown = s.mode === 'evaluate' ? lhs : [...lhs, eq, ...rhs];
    const last = s.mode === 'evaluate' || rhs.length === 0 ? eq : rhs[rhs.length - 1];
    results.push({
      key: eq.key,
      mode: s.mode,
      expression: shown.map((x) => x.symbol).join(''),
      symbols: [...lhs, ...(s.mode === 'evaluate' ? [] : rhs)].map(toPageBox),
      result: s.result,
      display: displayFor(s.mode, s.result, rhs),
      x: s.x,
      confidence: Math.min(...lhs.map((x) => x.confidence), ...rhs.map((x) => x.confidence), eq.confidence),
      anchor: { ...anchorOnPage(last, line, t), height: Math.max(line.height, typicalHeight) },
    });
  }

  const readings: LineReading[] = lines.map((line, li) => ({
    text: rows[li].map((e) => e.rec.symbol).join(''),
    y: line.bbox.minY,
    solved: results.some((r) => rows[li].some((e) => e.rec.key === r.key)),
  }));
  return { equations: results, lines: readings };
}

/**
 * What to write on the paper. Solving shows "x = 3"; a plain definition such as
 * "x = 10" just gets a tick (writing "x = 10" next to it would be noise).
 */
function displayFor(mode: EquationResult['mode'], result: SolveResult, rhs: RecognizedSymbol[]): string {
  if (mode === 'evaluate' || result.kind !== 'ok') return formatResult(result);
  const value = formatNumber(result.value).replace(/^-/, '−');
  const rhsIsJustTheValue = rhs.map((s) => s.symbol).join('').replace(/^−/, '−') === value;
  return mode === 'define' && rhsIsJustTheValue ? '✓' : `x = ${value}`;
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

/** Answer position: right of the given symbol, on the row's centre line — rotated back onto a slanted row. */
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
function repairBrackets(entries: Entry[], valid: (es: Entry[]) => boolean): Entry[] | null {
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
    return bracketsBalanced(next.map((e) => e.rec).filter((x) => x.symbol !== '=')) && valid(next) ? next : null;
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
 * A variable x written with two straight crossing lines looks exactly like "×".
 * Only a "×" where multiplication makes no sense on paper is reconsidered: at
 * the start or end, or next to an operator, "(", ")" or "=" — "2×+4", "×−3",
 * "5×=". A "×" between two values ("4×3") is always multiplication. Flipped
 * symbols must make the whole equation valid; they are marked as guesses
 * (amber, confidence 0.5) and user fixes are never touched.
 */
function repairX(entries: Entry[], valid: (es: Entry[]) => boolean): Entry[] | null {
  const OPS = new Set(['+', '−', '×', '÷']);
  const unnatural = (i: number) => {
    const prev = entries[i - 1]?.rec.symbol;
    const next = entries[i + 1]?.rec.symbol;
    return !prev || !next || OPS.has(prev) || OPS.has(next) || prev === '(' || prev === '=' || next === ')' || next === '=';
  };
  const crosses = entries.map((e, i) => (e.rec.symbol === '×' && e.rec.source !== 'user' && unnatural(i) ? i : -1)).filter((i) => i >= 0);
  if (crosses.length === 0) return null;
  const flip = (idx: number[]) =>
    entries.map((e, i) =>
      idx.includes(i)
        ? { group: e.group, rec: { ...e.rec, symbol: 'x', source: 'repair' as const, confidence: 0.5, recognizedAs: '×', alternatives: ['×', ...e.rec.alternatives.filter((a) => a !== 'x')] } }
        : e,
    );
  for (const i of crosses) {
    const next = flip([i]);
    if (valid(next)) return next;
  }
  if (crosses.length > 1) {
    const all = flip(crosses);
    if (valid(all)) return all;
  }
  return null;
}

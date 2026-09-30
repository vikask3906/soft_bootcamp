import { describe, expect, it } from 'vitest';
import { MNIST_SIZE, rasterizeStrokes } from '../src/recognition/rasterize';
import { recognizePage, type DigitClassifier } from '../src/recognition/pipeline';
import { segment } from '../src/recognition/segment';
import { classifyOperator } from '../src/recognition/shapes';
import { DIGITS, OPERATORS, writeLine } from './fixtures/glyphs';

/**
 * Pure-logic tests with a mock digit classifier, so they run in milliseconds
 * and isolate segmentation/shape bugs from model accuracy.
 */
const mockDigits = (answers: string): DigitClassifier => {
  const queue = answers.split('');
  return async (tensors) => tensors.map(() => ({ digit: Number(queue.shift()), confidence: 0.95 }));
};

const scale = (glyph: { x: number; y: number }[][], s = 0.6) => glyph.map((p) => p.map((q) => ({ x: q.x * s, y: q.y * s })));

describe('operator shape recogniser', () => {
  for (const [sym, glyph] of Object.entries(OPERATORS)) {
    it(`recognises ${sym}`, () => {
      expect(classifyOperator(scale(glyph), 60)?.symbol).toBe(sym);
    });
  }
  it('hands curved digits to the model', () => {
    for (const d of ['0', '2', '3', '5', '6', '8', '9']) {
      expect(classifyOperator(scale(DIGITS[d]), 60)).toBeNull();
    }
  });
  it('reads a + whose bars do not quite touch (real tablet handwriting)', () => {
    const bar = Array.from({ length: 11 }, (_, i) => ({ x: 20 + i * 6, y: 50 }));
    const stemAbove = Array.from({ length: 11 }, (_, i) => ({ x: 50, y: 18 + i * 2.8 })); // stops at y=46, bar at 50
    expect(classifyOperator([stemAbove, bar], 60)?.symbol).toBe('+');
    const stemShort = Array.from({ length: 11 }, (_, i) => ({ x: 50, y: 55 + i * 2.5 })); // starts just below the bar
    expect(classifyOperator([bar, stemShort], 60)?.symbol).toBe('+');
  });
  it('reads an × whose strokes miss slightly', () => {
    const a = Array.from({ length: 11 }, (_, i) => ({ x: 25 + i * 4.5, y: 25 + i * 4.5 }));
    const b = Array.from({ length: 11 }, (_, i) => ({ x: 75 - i * 2, y: 25 + i * 2 })); // stops short of the centre
    expect(classifyOperator([a, b], 60)?.symbol).toBe('×');
  });
  it('still reads a two-stroke 4 as a digit, not a +', () => {
    expect(classifyOperator(scale(DIGITS['4']), 60)).toBeNull();
  });
  it('keeps "1−" as two symbols even when written close together', () => {
    const [line] = segment(writeLine('1−2'));
    expect(line.symbols).toHaveLength(3);
  });
  it('tells ( and ) apart, drawn in either direction', () => {
    const reversed = (g: { x: number; y: number }[][]) => g.map((p) => [...p].reverse());
    expect(classifyOperator(scale(OPERATORS['(']), 60)?.symbol).toBe('(');
    expect(classifyOperator(scale(OPERATORS[')']), 60)?.symbol).toBe(')');
    expect(classifyOperator(reversed(scale(OPERATORS['('])), 60)?.symbol).toBe('(');
    expect(classifyOperator(reversed(scale(OPERATORS[')'])), 60)?.symbol).toBe(')');
  });
  it('does not mistake digits for brackets', () => {
    for (const d of ['1', '2', '3', '7']) {
      const s = classifyOperator(scale(DIGITS[d]), 60)?.symbol;
      expect(s === '(' || s === ')').toBe(false);
    }
    // A narrow 7 (corner at the top) must not read as ")".
    const narrow7 = DIGITS['7'].map((p) => p.map((q) => ({ x: q.x * 0.35, y: q.y * 0.6 })));
    expect(classifyOperator(narrow7, 60)?.symbol).not.toBe(')');
  });
  it('recognises a straight vertical bar as 1', () => {
    expect(classifyOperator(scale(DIGITS['1']), 60)?.symbol).toBe('1');
  });
  it('does not mistake a tall vertical bar for a dot', () => {
    expect(classifyOperator([[{ x: 0, y: 0 }, { x: 0, y: 3 }]], 60)?.symbol).toBe('.');
    expect(classifyOperator([[{ x: 0, y: 0 }, { x: 0, y: 50 }]], 60)?.symbol).not.toBe('.');
  });
});

describe('segmentation', () => {
  it('groups multi-stroke symbols (4, +, ×, =, ÷)', () => {
    const [line] = segment(writeLine('4+×=÷'));
    expect(line.symbols.map((s) => s.strokes.length)).toEqual([2, 2, 2, 2, 3]);
  });
  it('keeps a decimal point separate from its digits', () => {
    const [line] = segment(writeLine('7.5'));
    expect(line.symbols).toHaveLength(3);
  });
  it('separates stacked lines', () => {
    const lines = segment([...writeLine('1+2=', 20, 20), ...writeLine('3+4=', 20, 140, 60, 100)]);
    expect(lines).toHaveLength(2);
    expect(lines[0].bbox.minY).toBeLessThan(lines[1].bbox.minY);
  });
  it('splits far-apart equations on the same row', () => {
    const lines = segment([...writeLine('1+2=', 20, 20), ...writeLine('3+4=', 700, 20, 60, 100)]);
    expect(lines).toHaveLength(2);
  });
  it('keeps tightly packed rows apart (cramped page)', async () => {
    // Rows only 6 px apart, as happens when the page fills up.
    // (No "1"s here: a straight "1" is recognised by shape and would never reach the mock model.)
    const strokes = [...writeLine('2+3=', 20, 20), ...writeLine('4+5=', 20, 86, 60, 100), ...writeLine('6+7=', 20, 152, 60, 200)];
    const eqs = await recognizePage(strokes, mockDigits('234567'));
    expect(eqs.map((e) => e.display)).toEqual(['5', '9', '13']);
  });
  it('a tall scribble spanning rows does not break the equations', async () => {
    const scribble = { id: 999, order: 999, pts: [{ x: 400, y: 0 }, { x: 440, y: 120 }, { x: 410, y: 240 }] };
    const strokes = [...writeLine('2+3=', 20, 20), ...writeLine('4+5=', 20, 140, 60, 100), scribble];
    const eqs = await recognizePage(strokes, mockDigits('2345'));
    expect(eqs.map((e) => e.display)).toEqual(['5', '9']);
  });
  it('returns nothing for an empty page', () => {
    expect(segment([])).toEqual([]);
  });
});

describe('rasterizer (strokes → MNIST tensor)', () => {
  it('produces a 28×28 tensor in [0, 1]', () => {
    const t = rasterizeStrokes(DIGITS['8']);
    expect(t).toHaveLength(MNIST_SIZE * MNIST_SIZE);
    expect(Math.max(...t)).toBeLessThanOrEqual(1);
    expect(Math.min(...t)).toBeGreaterThanOrEqual(0);
  });
  it('is scale-invariant (same tensor for small and large writing)', () => {
    const small = rasterizeStrokes(scale(DIGITS['3'], 0.3));
    const large = rasterizeStrokes(scale(DIGITS['3'], 3));
    const diff = small.reduce((acc, v, i) => acc + Math.abs(v - large[i]), 0);
    expect(diff).toBeLessThan(1);
  });
  it('centres the ink by centre of mass', () => {
    const t = rasterizeStrokes(DIGITS['0']);
    let m = 0, cx = 0, cy = 0;
    t.forEach((v, i) => {
      m += v;
      cx += v * ((i % MNIST_SIZE) + 0.5);
      cy += v * (Math.floor(i / MNIST_SIZE) + 0.5);
    });
    expect(Math.abs(cx / m - 14)).toBeLessThan(1);
    expect(Math.abs(cy / m - 14)).toBeLessThan(1);
  });
  it('returns a blank tensor for no strokes', () => {
    expect(rasterizeStrokes([]).every((v) => v === 0)).toBe(true);
  });
});

describe('pipeline', () => {
  it('evaluates an equation ending in =', async () => {
    const [eq] = await recognizePage(writeLine('18+43='), mockDigits('843'));
    expect(eq.expression).toBe('18+43');
    expect(eq.display).toBe('61');
    expect(eq.result.kind).toBe('ok');
  });
  it('evaluates brackets end-to-end', async () => {
    const [eq] = await recognizePage(writeLine('(2+3)×4='), mockDigits('234'));
    expect(eq.expression).toBe('(2+3)×4');
    expect(eq.display).toBe('20');
  });
  it('ignores lines without =', async () => {
    expect(await recognizePage(writeLine('18+4'), mockDigits('84'))).toEqual([]);
  });
  it('does not overwrite an answer the user already wrote', async () => {
    expect(await recognizePage(writeLine('2+2=4'), mockDigits('224'))).toEqual([]);
  });
  it('reports Undefined for division by zero', async () => {
    const [eq] = await recognizePage(writeLine('9÷0='), mockDigits('90'));
    expect(eq.display).toBe('Undefined');
  });
  it('reports malformed input without throwing', async () => {
    const [eq] = await recognizePage(writeLine('+×='), mockDigits(''));
    expect(eq.result.kind).toBe('error');
    expect(eq.display).toBe('?');
  });
  it('anchors the answer just right of the = sign', async () => {
    const strokes = writeLine('3+3=');
    const eqRight = Math.max(...strokes.slice(-2).flatMap((s) => s.pts.map((p) => p.x)));
    const [eq] = await recognizePage(strokes, mockDigits('33'));
    expect(eq.anchor.x).toBeCloseTo(eqRight, 5);
  });
  it('uses the weakest symbol as the equation confidence', async () => {
    const lowConf: DigitClassifier = async (ts) => ts.map((_, i) => ({ digit: 3, confidence: i === 0 ? 0.4 : 0.99 }));
    const [eq] = await recognizePage(writeLine('3+3='), lowConf);
    expect(eq.confidence).toBeCloseTo(0.4);
  });
  it('keeps a stable key per equation so edits elsewhere do not re-animate it', async () => {
    const strokes = writeLine('3+3=');
    const [a] = await recognizePage(strokes, mockDigits('33'));
    const [b] = await recognizePage([...strokes, ...writeLine('1', 20, 300, 60, 500)], mockDigits('33'));
    expect(a.key).toBe(b.key);
  });
});

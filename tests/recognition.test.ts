import { describe, expect, it } from 'vitest';
import { MNIST_SIZE, rasterizeStrokes } from '../src/recognition/rasterize';
import { IGNORE, recognizeDetailed, recognizePage, type DigitClassifier } from '../src/recognition/pipeline';
import { softmaxArgmax } from '../src/recognition/model';
import { estimateLineHeight, segment } from '../src/recognition/segment';
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

describe('real-handwriting size rules (fixes A–E, from the tablet benchmark)', () => {
  const pts = (arr: [number, number][]) => arr.map(([x, y]) => ({ x, y }));
  const vline = (x: number, y0: number, y1: number, lean = 0) =>
    Array.from({ length: 12 }, (_, i) => ({ x: x + (lean * i) / 11, y: y0 + ((y1 - y0) * i) / 11 }));
  const hline = (x0: number, x1: number, y: number) => Array.from({ length: 12 }, (_, i) => ({ x: x0 + ((x1 - x0) * i) / 11, y }));
  const blob = (cx: number, cy: number, r: number) => Array.from({ length: 8 }, (_, i) => ({ x: cx + r * Math.cos(i), y: cy + r * Math.sin(i) }));

  it('A: a leaning, slightly bowed "1" is not a bracket', () => {
    // 30 px tall, leaning 6 px, bowing ~3 px in the middle (like the real one that read as "(").
    const one = Array.from({ length: 15 }, (_, i) => {
      const t = i / 14;
      return { x: 6 * t - 3 * Math.sin(Math.PI * t), y: 30 * t };
    });
    expect(classifyOperator([one], 28)?.symbol).not.toBe('(');
    expect(classifyOperator([one], 28)?.symbol).not.toBe(')');
  });

  it('B: ÷ whose dots are short dashes, or tapped several times', () => {
    const bar = hline(0, 20, 20);
    expect(classifyOperator([bar, vline(10, 8, 17), vline(10, 24, 33)], 26)?.symbol).toBe('÷'); // dashes
    expect(classifyOperator([bar, blob(10, 12, 1.5), blob(11, 12, 1.5), blob(10, 28, 1.5)], 26)?.symbol).toBe('÷'); // double tap
  });

  it('B: ÷ marks join their bar even when drawn out of order', () => {
    const s = (id: number, order: number, p: { x: number; y: number }[]) => ({ id, order, pts: p });
    const strokes = [
      s(1, 1, vline(0, 0, 26)), // "1"
      s(2, 2, hline(20, 40, 13)), // bar
      s(3, 3, vline(60, 0, 26)), // next "1"
      s(4, 4, blob(30, 5, 1.5)), // dots added last
      s(5, 5, blob(30, 22, 1.5)),
    ];
    const [line] = segment(strokes);
    expect(line.symbols.map((x) => x.strokes.length)).toEqual([1, 3, 1]);
  });

  it('C: a stray tap next to a bar does not make "="', () => {
    expect(classifyOperator([hline(0, 18, 10), pts([[3, 23], [4.8, 23.2]])], 26)?.symbol).not.toBe('=');
  });

  it('D: a 5 whose top bar was added at the end stays one digit', () => {
    const body = pts([[2, 0], [0, 12], [8, 10], [14, 16], [12, 24], [2, 25]]); // 5 without its cap
    const strokes = [
      { id: 1, order: 1, pts: body },
      { id: 2, order: 2, pts: vline(30, 0, 25) }, // "1" after it
      { id: 3, order: 3, pts: hline(2, 16, 0.5) }, // the 5's cap, drawn last
    ];
    const [line] = segment(strokes);
    expect(line.symbols).toHaveLength(2);
    expect(line.symbols[0].strokes.map((x) => x.id).sort()).toEqual([1, 3]);
  });

  it('D: a real minus between digits is not swallowed as a cap', () => {
    const [line] = segment(writeLine('5−6'));
    expect(line.symbols).toHaveLength(3);
  });

  it('a double-tapped decimal point is one "."', () => {
    expect(classifyOperator([blob(0, 0, 2), blob(2, -2, 1.5)], 26)?.symbol).toBe('.');
  });
});

describe('free-writing rules (fixes F–K, from a real tablet page)', () => {
  const seg = (x0: number, y0: number, x1: number, y1: number, n = 10) =>
    Array.from({ length: n + 1 }, (_, i) => ({ x: x0 + ((x1 - x0) * i) / n, y: y0 + ((y1 - y0) * i) / n }));
  const st = (id: number, order: number, pts: { x: number; y: number }[]) => ({ id, order, pts });

  it('F: crossing strokes form one symbol even when written far apart in time', () => {
    const strokes = [
      st(1, 1, seg(0, 0, 0, 30)), // "1"
      st(2, 2, seg(20, 15, 40, 15)), // "+" bar
      st(9, 9, seg(60, 0, 60, 30)), // something written later, further right
      st(10, 10, seg(30, 5, 30, 25)), // "+" stem, added afterwards
    ];
    const [line] = segment(strokes);
    expect(line.symbols.map((x) => x.strokes.map((q) => q.id).sort((a, b) => a - b))).toEqual([[1], [2, 10], [9]]);
    expect(classifyOperator(line.symbols[1].strokes.map((q) => q.pts), 30)?.symbol).toBe('+');
  });

  it('G: a + with a tilted, hooked bar is still +', () => {
    const bar = [{ x: 0, y: 12 }, { x: 2, y: 11 }, { x: 6, y: 10 }, { x: 10, y: 8.5 }, { x: 11, y: 8 }, { x: 11.5, y: 9 }]; // ~24° with a hook
    expect(classifyOperator([bar, seg(5, 0, 5.5, 16)], 22)?.symbol).toBe('+');
  });

  it('a × whose crossing legs are slightly curved is still ×', () => {
    const curved = Array.from({ length: 12 }, (_, i) => ({ x: 17 - (17 * i) / 11 + 3 * Math.sin((Math.PI * i) / 11), y: (22 * i) / 11 }));
    expect(classifyOperator([seg(0, 2, 12, 20), curved], 29)?.symbol).toBe('×');
  });

  it('I: a × with one leg drawn twice is still ×', () => {
    expect(classifyOperator([seg(0, 0, 10, 14), seg(12, 0, 0, 18), seg(0, 0, 16, 16)], 22)?.symbol).toBe('×');
  });

  it('J: an open 4 whose stem just touches the first stroke is one symbol', () => {
    const corner = [...seg(0, 0, 0, 14, 7), ...seg(0, 14, 10, 12, 5).slice(1)];
    const strokes = [st(1, 1, corner), st(2, 2, seg(10.5, 4, 10.5, 20)), st(3, 3, seg(30, 0, 30, 20))];
    const [line] = segment(strokes);
    expect(line.symbols.map((x) => x.strokes.length)).toEqual([2, 1]);
  });

  it('K: a stray dot above the digits is ignored; a real decimal point is kept', async () => {
    const strokes = [...writeLine('6÷2='), st(900, 900, [{ x: 70, y: 16 }, { x: 70.5, y: 16.3 }])]; // tap above the digits
    const [eq] = await recognizePage(strokes, mockDigits('62'));
    expect(eq.expression).toBe('6÷2');
    const [dec] = await recognizePage(writeLine('7.5='), mockDigits('75'));
    expect(dec.expression).toBe('7.5');
  });
});

describe('line height estimate', () => {
  const item = (w: number, h: number, ink: number) => ({
    b: { minX: 0, minY: 0, maxX: w, maxY: h },
    s: { id: 0, order: 0, pts: [{ x: 0, y: 0 }, { x: 0, y: ink }] },
  });
  it('is not inflated by tall brackets', () => {
    const digits = Array.from({ length: 6 }, () => item(15, 25, 70));
    expect(estimateLineHeight([...digits, item(20, 81, 90), item(18, 46, 60)])).toBe(25);
  });
  it('is not deflated by dash-shaped ÷ dots', () => {
    expect(estimateLineHeight([item(13, 34, 90), item(1, 10, 10), item(6, 9, 10), item(8, 9, 10), item(18, 26, 80)])).toBeGreaterThanOrEqual(26);
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

describe('softmax', () => {
  it('returns probabilities that sum to 1 and ranks runner-ups', () => {
    const r = softmaxArgmax([0, 3, 1, 0, 0, 0, 0, 0, 2.5, 0]);
    expect(r.digit).toBe(1);
    expect(r.alternatives!.map((a) => a.digit)).toEqual([8, 2, 0]);
    const total = r.confidence + r.alternatives!.reduce((s, a) => s + a.p, 0);
    expect(total).toBeLessThan(1);
    expect(r.confidence).toBeCloseTo(Math.exp(3) / [0, 3, 1, 0, 0, 0, 0, 0, 2.5, 0].reduce((s, z) => s + Math.exp(z), 0), 10);
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

describe('safety net: bracket-balance repair', () => {
  // A single stroke 60 px tall at x, bowing sideways by `bow` × its height
  // (negative = bows left like "(", positive = bows right like ")").
  const bowed = (id: number, x: number, bow: number) => ({
    id,
    order: id,
    pts: Array.from({ length: 16 }, (_, i) => {
      const t = i / 15;
      return { x: x + bow * 60 * Math.sin(Math.PI * t), y: 20 + 60 * t };
    }),
  });
  const shift = (strokes: ReturnType<typeof writeLine>, from: number) => strokes.map((s) => ({ ...s, id: s.id + from, order: s.order + from }));

  it('a "(" that was really a "1" is swapped back when brackets do not balance', async () => {
    // "(" with a borderline bow (0.14) + "+2=" → "(+2" is invalid → "1+2" = 3.
    const strokes = [bowed(1, 40, -0.14), ...shift(writeLine('+2=', 60, 20), 10)];
    const [eq] = await recognizePage(strokes, mockDigits('2'));
    expect(eq.expression).toBe('1+2');
    expect(eq.display).toBe('3');
    expect(eq.symbols[0]).toMatchObject({ source: 'repair', recognizedAs: '(' });
    expect(eq.confidence).toBeLessThan(0.6); // shown as unsure (amber) — never a silent change
  });

  it('a ")" misread as "1" is repaired to the side it bows towards', async () => {
    // "(2+3" then a slightly right-bowed stroke read as "1" → "(2+31" → "(2+3)" = 5, not "12+3…".
    const head = writeLine('(2+3', 20, 20);
    const strokes = [...head, bowed(50, 300, 0.1), ...shift(writeLine('=', 330, 20), 60)];
    const [eq] = await recognizePage(strokes, mockDigits('23'));
    expect(eq.expression).toBe('(2+3)');
    expect(eq.display).toBe('5');
  });

  it('never swaps a clearly curved bracket: a forgotten ")" shows "missing )"', async () => {
    const [eq] = await recognizePage(writeLine('(2+3='), mockDigits('23'));
    expect(eq.display).toBe('?');
    expect(eq.result).toMatchObject({ kind: 'error', code: 'missing-close', message: 'missing )' });
  });

  it('leaves valid, balanced expressions alone', async () => {
    const strokes = [...writeLine('12+3', 20, 20), bowed(50, 300, 0.1), ...shift(writeLine('=', 330, 20), 60)];
    const [eq] = await recognizePage(strokes, mockDigits('23'));
    expect(eq.expression).toBe('12+31');
    expect(eq.symbols.every((s) => s.source !== 'repair')).toBe(true);
  });

  it('never overrides a symbol the user corrected', async () => {
    const head = writeLine('(2+3', 20, 20);
    const one = bowed(50, 300, 0.1);
    const strokes = [...head, one, ...shift(writeLine('=', 330, 20), 60)];
    const [eq] = await recognizePage(strokes, mockDigits('23'), { '50': '1' });
    expect(eq.symbols.at(-1)).toMatchObject({ symbol: '1', source: 'user' });
    expect(eq.result).toMatchObject({ kind: 'error', code: 'missing-close' });
  });
});

describe('tap-to-correct (corrections in the pipeline)', () => {
  it('a corrected symbol replaces what was read, and the answer follows', async () => {
    // Model misreads the 3 as a 2: "2.5×2=" → 5. The user fixes it to 3.
    const strokes = writeLine('3.5×2=');
    const misread: DigitClassifier = async (ts) => ts.map((_, i) => ({ digit: [2, 5, 2][i], confidence: 0.9, alternatives: [{ digit: 3, p: 0.08 }] }));
    const [before] = await recognizePage(strokes, misread);
    expect(before.display).toBe('5');
    const three = before.symbols[0];
    expect(three.alternatives[0]).toBe('3'); // model runner-up offered first
    const [after] = await recognizePage(strokes, misread, { [three.key]: '3' });
    expect(after.expression).toBe('3.5×2');
    expect(after.display).toBe('7');
    expect(after.symbols[0]).toMatchObject({ source: 'user', recognizedAs: '2', confidence: 1 });
  });

  it('"ignore this mark" drops a stray tap from the expression', async () => {
    const strokes = [...writeLine('6÷2='), { id: 900, order: 900, pts: [{ x: 95, y: 49 }, { x: 96, y: 50 }] }];
    const { lines } = await recognizeDetailed(strokes, mockDigits('62'), true);
    const stray = lines[0].text; // contains an extra "." from the tap
    expect(stray).toContain('.');
    const [eq] = await recognizePage(strokes, mockDigits('62'), { '900': IGNORE });
    expect(eq.expression).toBe('6÷2');
    expect(eq.display).toBe('3');
  });

  it('a correction stops applying once its strokes change', async () => {
    const strokes = writeLine('8+1=');
    const [eq] = await recognizePage(strokes, mockDigits('8'));
    const key = eq.symbols[0].key;
    // Rewrite the 8 (new stroke ids): the old correction no longer matches.
    const rewritten = strokes.map((s, i) => (i === 0 ? { ...s, id: 999 } : s));
    const [again] = await recognizePage(rewritten, mockDigits('8'), { [key]: '6' });
    expect(again.expression).toBe('8+1');
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

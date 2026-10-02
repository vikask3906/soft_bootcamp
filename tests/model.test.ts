import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as ort from 'onnxruntime-web';
import { beforeAll, describe, expect, it } from 'vitest';
import { createDigitClassifier } from '../src/recognition/model';
import { recognizePage, type DigitClassifier } from '../src/recognition/pipeline';
import { rasterizeStrokes, tensorToAscii } from '../src/recognition/rasterize';
import { DIGITS, writeLine } from './fixtures/glyphs';

/** Integration test: real MNIST ONNX model on synthetic handwriting. */
let classify: DigitClassifier;

beforeAll(async () => {
  ort.env.wasm.numThreads = 1;
  const model = readFileSync(resolve(__dirname, '../public/models/mnist-12.onnx'));
  classify = await createDigitClassifier(ort, new Uint8Array(model));
}, 30_000);

describe('MNIST digit model', () => {
  for (const [digit, glyph] of Object.entries(DIGITS)) {
    it(`recognises a synthetic ${digit}`, async () => {
      const t = rasterizeStrokes(glyph);
      const [pred] = await classify([t]);
      if (String(pred.digit) !== digit) console.log(`${digit} → ${pred.digit}\n${tensorToAscii(t)}`);
      expect(String(pred.digit)).toBe(digit);
    });
  }

  it('recognises and solves a whole handwritten line end-to-end', async () => {
    const [eq] = await recognizePage(writeLine('18+4×3='), classify);
    expect(eq.expression).toBe('18+4×3');
    expect(eq.display).toBe('30');
  });

  it('solves real tablet handwriting (hooked stroke ends, stray palm dots, far-away ink)', async () => {
    const fx = JSON.parse(readFileSync(resolve(__dirname, 'fixtures/real/tablet-18plus7.json'), 'utf8')) as {
      strokes: { id: number; order: number; pts: [number, number][] }[];
    };
    const strokes = fx.strokes.map((s) => ({ id: s.id, order: s.order, pts: s.pts.map(([x, y]) => ({ x, y })) }));
    const eqs = await recognizePage(strokes, classify);
    expect(eqs.map((e) => `${e.expression}=${e.display}`)).toEqual(['18+7=25']);
  });

  it('solves real tablet handwriting with nested brackets and wide operator spacing', async () => {
    const fx = JSON.parse(readFileSync(resolve(__dirname, 'fixtures/real/tablet-nested-brackets.json'), 'utf8')) as {
      expected: string[];
      strokes: { id: number; order: number; pts: [number, number][] }[];
    };
    const strokes = fx.strokes.map((s) => ({ id: s.id, order: s.order, pts: s.pts.map(([x, y]) => ({ x, y })) }));
    const eqs = await recognizePage(strokes, classify);
    expect(eqs.map((e) => `${e.expression}=${e.display}`)).toEqual(fx.expected);
  });

  it('solves free tablet writing: erased+redrawn +, retraced ×, open 4, stray pen touch, high-peaked brackets', async () => {
    const fx = JSON.parse(readFileSync(resolve(__dirname, 'fixtures/real/tablet-free-writing-1.json'), 'utf8')) as {
      expected: string[];
      strokes: { id: number; order: number; pts: [number, number][] }[];
    };
    const strokes = fx.strokes.map((s) => ({ id: s.id, order: s.order, pts: s.pts.map(([x, y]) => ({ x, y })) }));
    const got = (await recognizePage(strokes, classify)).map((e) => `${e.expression}=${e.display}`);
    // The long middle row still has two errors rules can't fix (an extra stroke on
    // a "×", and the model reading a 6 as 8) — those are for tap-to-correct.
    for (const want of fx.expected) expect(got).toContain(want);
  });

  it('solves free tablet writing 2: slightly curved × leg, near-straight ( repaired by bracket balance', async () => {
    const fx = JSON.parse(readFileSync(resolve(__dirname, 'fixtures/real/tablet-free-writing-2.json'), 'utf8')) as {
      expected: string[];
      strokes: { id: number; order: number; pts: [number, number][] }[];
    };
    const strokes = fx.strokes.map((s) => ({ id: s.id, order: s.order, pts: s.pts.map(([x, y]) => ({ x, y })) }));
    const got = (await recognizePage(strokes, classify)).map((e) => `${e.expression}=${e.display}`);
    for (const want of fx.expected) expect(got).toContain(want);
  });

  it('solves a real line written uphill at ~26° (deskewing), without disturbing the straight rows', async () => {
    const fx = JSON.parse(readFileSync(resolve(__dirname, 'fixtures/real/tablet-slanted-1.json'), 'utf8')) as {
      expected: string[];
      strokes: { id: number; order: number; pts: [number, number][] }[];
    };
    const strokes = fx.strokes.map((s) => ({ id: s.id, order: s.order, pts: s.pts.map(([x, y]) => ({ x, y })) }));
    const got = (await recognizePage(strokes, classify)).map((e) => `${e.expression}=${e.display}`);
    for (const want of fx.expected) expect(got).toContain(want);
  });

  describe('slanted rows (deskewing)', () => {
    type S = ReturnType<typeof writeLine>;
    const rot = (strokes: S, deg: number, cx: number, cy: number): S => {
      const t = (deg * Math.PI) / 180;
      return strokes.map((s) => ({
        ...s,
        pts: s.pts.map((p) => ({ x: cx + (p.x - cx) * Math.cos(t) - (p.y - cy) * Math.sin(t), y: cy + (p.x - cx) * Math.sin(t) + (p.y - cy) * Math.cos(t) })),
      }));
    };

    for (const text of ['6+3+4=', '18+4×3=', '7.5÷2−1=']) {
      it(`reads "${text}" at every angle from −30° to +30°`, async () => {
        for (const deg of [-30, -20, -10, 0, 10, 20, 30]) {
          const [eq] = await recognizePage(rot(writeLine(text, 20, 300, 50), deg, 20, 325), classify);
          expect(`${deg}°: ${eq?.expression}`).toBe(`${deg}°: ${text.slice(0, -1)}`);
        }
      });
    }

    it('keeps two rows apart when their slopes cross (+20° and −20°)', async () => {
      const down = rot(writeLine('2+3=', 20, 40, 50, 1), 20, 20, 65);
      const up = rot(writeLine('4+5=', 20, 420, 50, 100), -20, 20, 445);
      const got = (await recognizePage([...down, ...up], classify)).map((e) => `${e.expression}=${e.display}`);
      expect(got.sort()).toEqual(['2+3=5', '4+5=9']);
    });

    it('a slanted row written in two bursts is straightened as one piece (real tablet page)', async () => {
      const fx = JSON.parse(readFileSync(resolve(__dirname, 'fixtures/real/tablet-slanted-2.json'), 'utf8')) as {
        expected: string[];
        strokes: { id: number; order: number; pts: [number, number][] }[];
      };
      const strokes = fx.strokes.map((s) => ({ id: s.id, order: s.order, pts: s.pts.map(([x, y]) => ({ x, y })) }));
      const got = (await recognizePage(strokes, classify)).map((e) => `${e.expression}=${e.display}`);
      expect(got).toEqual(fx.expected);
    });

    it('keeps four close slanted rows apart, incl. two whose centres sit at the same height (real tablet page)', async () => {
      const fx = JSON.parse(readFileSync(resolve(__dirname, 'fixtures/real/tablet-slanted-3.json'), 'utf8')) as {
        expected: string[];
        strokes: { id: number; order: number; pts: [number, number][] }[];
      };
      const strokes = fx.strokes.map((s) => ({ id: s.id, order: s.order, pts: s.pts.map(([x, y]) => ({ x, y })) }));
      const got = (await recognizePage(strokes, classify)).map((e) => `${e.expression}=${e.display}`);
      for (const want of fx.expected) expect(got).toContain(want);
      expect(got).toHaveLength(4); // four rows, none merged
    });

    it('a slanted row continued later (after writing elsewhere) stays one row', async () => {
      const row = rot(writeLine('12+34+56=', 20, 300, 45, 1), -28, 20, 322);
      const firstHalf = row.slice(0, 7); // "12+34" …
      const rest = row.slice(7).map((s, i) => ({ ...s, id: 300 + i, order: 300 + i })); // …"+56=" written later
      const other = writeLine('2+2=', 20, 650, 45, 100);
      const got = (await recognizePage([...firstHalf, ...other, ...rest], classify)).map((e) => `${e.expression}=${e.display}`);
      expect(got.sort()).toEqual(['12+34+56=102', '2+2=4']);
    });

    it('a symbol added later to an old slanted row joins that row', async () => {
      const row = rot(writeLine('7+5=', 20, 300, 50, 1), -25, 20, 325);
      const eqStrokes = row.slice(-2).map((s, i) => ({ ...s, id: 500 + i, order: 500 + i })); // "=" written last…
      const other = writeLine('2+2=', 20, 600, 50, 200); // …after a different row
      const got = (await recognizePage([...row.slice(0, -2), ...other, ...eqStrokes], classify)).map((e) => `${e.expression}=${e.display}`);
      expect(got.sort()).toEqual(['2+2=4', '7+5=12']);
    });

    it('puts the answer on the slanted row, following its slope', async () => {
      const [eq] = await recognizePage(rot(writeLine('2+3=', 20, 300, 50), -25, 20, 325), classify);
      expect(Math.abs((eq.anchor.angle * 180) / Math.PI + 25)).toBeLessThan(2); // symbol centres give the slope to within ~1°
    });
  });

  it('handles decimals and division', async () => {
    const [eq] = await recognizePage(writeLine('7.5÷2='), classify);
    expect(eq.expression).toBe('7.5÷2');
    expect(eq.display).toBe('3.75');
  });
});

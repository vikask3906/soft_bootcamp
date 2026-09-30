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

  it('handles decimals and division', async () => {
    const [eq] = await recognizePage(writeLine('7.5÷2='), classify);
    expect(eq.expression).toBe('7.5÷2');
    expect(eq.display).toBe('3.75');
  });
});

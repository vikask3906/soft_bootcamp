import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as ort from 'onnxruntime-web';
import { beforeAll, describe, expect, it } from 'vitest';
import { createDigitClassifier } from '../src/recognition/model';
import { recognizeDetailed, type DigitClassifier } from '../src/recognition/pipeline';
import { SHEET_V1, SHEET_V1_ANSWERS } from './benchmark/sheet';
import { alignRows, alignSymbols, formatReport, scoreSheet } from './benchmark/score';

describe('benchmark scorer', () => {
  it('aligns symbols with substitutions, misses and extras', () => {
    const ops = alignSymbols([...'18+7'], [...'19+77']);
    const count = (k: string) => ops.filter((o) => o.kind === k).length;
    expect([count('match'), count('sub'), count('ins'), count('del')]).toEqual([3, 1, 1, 0]);
    expect(ops.find((o) => o.kind === 'sub')).toMatchObject({ a: '8', b: '9' });
  });
  it('aligns rows despite a split row and a stray line', () => {
    const pairs = alignRows(['1 1 1', '2 2 2', '3 3 3'], ['111', '.', '22', '2', '333']);
    expect(pairs.filter(([e, g]) => e !== null && g !== null).map(([e]) => e)).toEqual([0, 1, 2]);
  });
  it('scores a perfect sheet at 100%', () => {
    const r = scoreSheet(SHEET_V1, SHEET_V1.map((s) => s.replace(/\s/g, '')));
    expect(r.correctSymbols).toBe(r.totalSymbols);
  });
});

/**
 * Real handwriting benchmark: every tests/fixtures/sheets/*.json capture of
 * the test sheet is recognised with the real model and scored. Each fixture
 * records the accuracy it achieved when added; a drop below it fails CI.
 */
const SHEETS_DIR = resolve(__dirname, 'fixtures/sheets');
const sheets = existsSync(SHEETS_DIR) ? readdirSync(SHEETS_DIR).filter((f) => f.endsWith('.json')) : [];

describe.runIf(sheets.length > 0)('handwriting benchmark (real tablet sheets)', () => {
  let classify: DigitClassifier;
  beforeAll(async () => {
    ort.env.wasm.numThreads = 1;
    classify = await createDigitClassifier(ort, new Uint8Array(readFileSync(resolve(__dirname, '../public/models/mnist-12.onnx'))));
  }, 30_000);

  for (const file of sheets) {
    it(`scores ${file}`, async () => {
      const fx = JSON.parse(readFileSync(resolve(SHEETS_DIR, file), 'utf8')) as {
        minAccuracy?: number;
        strokes: { id: number; order: number; pts: [number, number][] }[];
      };
      const strokes = fx.strokes.map((s) => ({ id: s.id, order: s.order, pts: s.pts.map(([x, y]) => ({ x, y })) }));
      const { lines, equations } = await recognizeDetailed(strokes, classify, true);
      const read = lines.map((l) => l.text).filter((t) => t.replace(/[.]/g, '').length > 0 || t.length > 1);
      const report = scoreSheet(SHEET_V1, read);
      const answers = Object.entries(SHEET_V1_ANSWERS).map(([row, want]) => {
        const expr = row.replace(/=$/, '');
        const eq = equations.find((e) => e.expression === expr);
        return `  ${eq?.display === want ? '✓' : '✗'} ${row.padEnd(16)} want ${want.padEnd(9)} got ${eq ? eq.display : '(not read correctly)'}`;
      });
      console.log(`\n===== ${file} =====\n${formatReport(report)}\n\nANSWERS\n${answers.join('\n')}\n`);
      const accuracy = report.correctSymbols / report.totalSymbols;
      expect(accuracy).toBeGreaterThanOrEqual(fx.minAccuracy ?? 0);
    }, 60_000);
  }
});

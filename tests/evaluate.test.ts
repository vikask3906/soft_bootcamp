import { describe, expect, it } from 'vitest';
import { evaluate, formatNumber, formatResult, tokenize } from '../src/math/evaluate';

const value = (s: string) => {
  const r = evaluate(s);
  if (r.kind !== 'ok') throw new Error(`${s} → ${r.kind}`);
  return r.value;
};

describe('tokenize', () => {
  it('splits numbers and operators', () => {
    expect(tokenize('18+4×3').map((t) => t.value)).toEqual([18, '+', 4, '*', 3]);
  });
  it('maps handwriting glyphs to operators', () => {
    expect(tokenize('6÷2−1').map((t) => t.value)).toEqual([6, '/', 2, '-', 1]);
  });
  it('reads multi-digit and decimal numbers', () => {
    expect(tokenize('123.45').map((t) => t.value)).toEqual([123.45]);
    expect(tokenize('.5').map((t) => t.value)).toEqual([0.5]);
  });
  it('rejects numbers with two decimal points', () => {
    expect(() => tokenize('1.2.3')).toThrow();
  });
});

describe('evaluate — precedence (BODMAS)', () => {
  it.each([
    ['18+4×3', 30],
    ['2+3×4−5', 9],
    ['10−4−3', 3], // left-associative subtraction
    ['100÷10÷2', 5], // left-associative division
    ['2×3+4×5', 26],
    ['8÷4×2', 4],
    ['1+2×3÷6', 2],
    ['(1+2)×3', 9],
  ])('%s = %d', (expr, expected) => {
    expect(value(expr)).toBe(expected);
  });
});

describe('evaluate — brackets', () => {
  it.each([
    ['(2+3)×4', 20],
    ['2×(3+4)', 14],
    ['((1+2)×(3+4))', 21],
    ['−(2+3)', -5],
    ['10÷(4−2)', 5],
    // implicit multiplication next to brackets
    ['2(3+4)', 14],
    ['(1+2)(3+4)', 21],
    ['(2+3)4', 20],
  ])('%s = %d', (expr, expected) => {
    expect(value(expr)).toBe(expected);
  });
  it('rejects empty brackets', () => expect(evaluate('()').kind).toBe('error'));
});

describe('evaluate — numbers', () => {
  it('handles multi-digit integers', () => expect(value('1234+5678')).toBe(6912));
  it('handles decimals', () => expect(value('7.5÷2')).toBe(3.75));
  it('handles a leading negative', () => expect(value('−5+3')).toBe(-2));
  it('handles negative after an operator', () => expect(value('4×−2')).toBe(-8));
  it('handles double negation', () => expect(value('−−3')).toBe(3));
  it('handles unary plus', () => expect(value('+3')).toBe(3));
});

describe('evaluate — edge cases never throw', () => {
  it('division by zero is Undefined', () => {
    expect(evaluate('9÷0').kind).toBe('undefined');
    expect(evaluate('1+2÷(3−3)').kind).toBe('undefined');
  });
  it('0÷0 is Undefined', () => expect(evaluate('0÷0').kind).toBe('undefined'));
  it('0 divided by a number is fine', () => expect(value('0÷5')).toBe(0));
  it.each(['', '+', '18+', '×3', '3××3', '(1+2', '1+2)', '1.2.3+1', '.', '2 3 ?'])('malformed "%s" is an error, not a crash', (expr) => {
    expect(() => evaluate(expr)).not.toThrow();
    expect(evaluate(expr).kind).toBe('error');
  });
  it('overflow to Infinity is Undefined', () => {
    expect(evaluate('9'.repeat(200) + '×' + '9'.repeat(200)).kind).toBe('undefined');
  });
});

describe('formatting', () => {
  it('hides floating point noise', () => {
    expect(formatNumber(0.1 + 0.2)).toBe('0.3');
    expect(formatNumber(1 / 3)).toBe('0.333333333333');
  });
  it('never shows -0', () => expect(formatNumber(-0)).toBe('0'));
  it('keeps integers clean', () => expect(formatNumber(30)).toBe('30'));
  it('uses exponent form for huge values', () => expect(formatNumber(1e20)).toBe('1e+20'));
  it('shows negative answers with a typographic minus', () => expect(formatResult(evaluate('2−5'))).toBe('−3'));
  it('formats results by kind', () => {
    expect(formatResult(evaluate('9÷0'))).toBe('Undefined');
    expect(formatResult(evaluate('9÷'))).toBe('?');
    expect(formatResult(evaluate('9÷3'))).toBe('3');
  });
});

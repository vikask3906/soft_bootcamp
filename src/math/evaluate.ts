/**
 * Deterministic arithmetic engine. Never uses eval(): input is tokenised and
 * evaluated by a small recursive-descent parser with BODMAS precedence.
 *
 * Grammar:
 *   expr   := term (('+' | '-') term)*
 *   term   := unary (('*' | '/') unary)*
 *   unary  := ('-' | '+') unary | primary
 *   primary:= NUMBER | '(' expr ')'
 */

export type Token =
  | { type: 'num'; value: number; raw: string }
  | { type: 'op'; value: '+' | '-' | '*' | '/' }
  | { type: 'paren'; value: '(' | ')' };

/**
 * What kind of syntax problem was found. Used to show a short reason on the
 * paper ("? missing )") and to decide when a bracket repair is worth trying.
 */
export type ErrorCode =
  | 'empty'
  | 'missing-close'
  | 'extra-close'
  | 'empty-brackets'
  | 'double-operator'
  | 'leading-operator'
  | 'trailing-operator'
  | 'missing-number'
  | 'bad-number'
  | 'unknown-symbol';

export type EvalResult =
  | { kind: 'ok'; value: number }
  | { kind: 'undefined'; reason: string }
  /** `message` is short and human-readable, e.g. "missing )". */
  | { kind: 'error'; message: string; code: ErrorCode };

class SyntaxError_ extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}
class UndefinedResult extends Error {}

const OP_GLYPH: Record<string, string> = { '+': '+', '-': '−', '*': '×', '/': '÷' };

/** Maps the handwriting vocabulary (and common ASCII aliases) to operators. */
const OP_ALIASES: Record<string, '+' | '-' | '*' | '/'> = {
  '+': '+',
  '-': '-',
  '−': '-',
  '–': '-',
  '*': '*',
  '×': '*',
  x: '*',
  '/': '/',
  '÷': '/',
};

export function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === ' ') {
      i++;
      continue;
    }
    if ((ch >= '0' && ch <= '9') || ch === '.') {
      let j = i;
      let dots = 0;
      while (j < input.length && ((input[j] >= '0' && input[j] <= '9') || input[j] === '.')) {
        if (input[j] === '.') dots++;
        j++;
      }
      const raw = input.slice(i, j);
      if (dots > 1 || raw === '.') throw new SyntaxError_('bad-number', raw === '.' ? 'lone decimal point' : `bad number ${raw}`);
      tokens.push({ type: 'num', value: Number(raw), raw });
      i = j;
      continue;
    }
    if (ch in OP_ALIASES) {
      tokens.push({ type: 'op', value: OP_ALIASES[ch] });
      i++;
      continue;
    }
    if (ch === '(' || ch === ')') {
      tokens.push({ type: 'paren', value: ch });
      i++;
      continue;
    }
    throw new SyntaxError_('unknown-symbol', `unknown symbol ${ch}`);
  }
  return insertImplicitMultiplication(tokens);
}

/**
 * Handwritten maths often omits "×" next to brackets: 2(3+4), (1+2)(3+4),
 * (2+3)4. Insert the multiplication wherever a value is directly followed by
 * another value.
 */
function insertImplicitMultiplication(tokens: Token[]): Token[] {
  const endsValue = (t: Token) => t.type === 'num' || (t.type === 'paren' && t.value === ')');
  const startsValue = (t: Token) => t.type === 'num' || (t.type === 'paren' && t.value === '(');
  const out: Token[] = [];
  for (const t of tokens) {
    const prev = out[out.length - 1];
    // num-num never occurs (digits are merged), so this only fires around brackets.
    if (prev && endsValue(prev) && startsValue(t) && !(prev.type === 'num' && t.type === 'num')) {
      out.push({ type: 'op', value: '*' });
    }
    out.push(t);
  }
  return out;
}

class Parser {
  private pos = 0;
  constructor(private readonly tokens: Token[]) {}

  parse(): number {
    if (this.tokens.length === 0) throw new SyntaxError_('empty', 'nothing before =');
    const v = this.expr();
    if (this.pos < this.tokens.length) {
      const t = this.tokens[this.pos];
      if (t.type === 'paren' && t.value === ')') throw new SyntaxError_('extra-close', 'extra )');
      throw new SyntaxError_('missing-number', 'check symbols');
    }
    return v;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private expr(): number {
    let v = this.term();
    for (let t = this.peek(); t && t.type === 'op' && (t.value === '+' || t.value === '-'); t = this.peek()) {
      this.pos++;
      const rhs = this.term();
      v = t.value === '+' ? v + rhs : v - rhs;
    }
    return v;
  }

  private term(): number {
    let v = this.unary();
    for (let t = this.peek(); t && t.type === 'op' && (t.value === '*' || t.value === '/'); t = this.peek()) {
      this.pos++;
      const rhs = this.unary();
      if (t.value === '*') {
        v *= rhs;
      } else {
        if (rhs === 0) throw new UndefinedResult('Division by zero');
        v /= rhs;
      }
    }
    return v;
  }

  private unary(): number {
    const t = this.peek();
    if (t && t.type === 'op' && (t.value === '-' || t.value === '+')) {
      this.pos++;
      const v = this.unary();
      return t.value === '-' ? -v : v;
    }
    return this.primary();
  }

  private primary(): number {
    const t = this.peek();
    const prev = this.tokens[this.pos - 1];
    if (!t) {
      if (prev?.type === 'op') throw new SyntaxError_('trailing-operator', `nothing after ${OP_GLYPH[prev.value]}`);
      if (prev?.type === 'paren' && prev.value === '(') throw new SyntaxError_('missing-close', 'missing )');
      throw new SyntaxError_('missing-number', 'number missing');
    }
    if (t.type === 'num') {
      this.pos++;
      return t.value;
    }
    if (t.type === 'paren' && t.value === '(') {
      this.pos++;
      const v = this.expr();
      const close = this.peek();
      if (!close || close.type !== 'paren' || close.value !== ')') throw new SyntaxError_('missing-close', 'missing )');
      this.pos++;
      return v;
    }
    // A number was expected but something else is here.
    if (t.type === 'paren') {
      if (prev?.type === 'paren' && prev.value === '(') throw new SyntaxError_('empty-brackets', 'empty ( )');
      if (prev?.type === 'op') throw new SyntaxError_('missing-number', `nothing after ${OP_GLYPH[prev.value]}`);
      throw new SyntaxError_('extra-close', 'extra )');
    }
    if (!prev) throw new SyntaxError_('leading-operator', `starts with ${OP_GLYPH[t.value]}`);
    if (prev.type === 'paren' && prev.value === '(') throw new SyntaxError_('leading-operator', `( then ${OP_GLYPH[t.value]}`);
    throw new SyntaxError_('double-operator', 'two operators');
  }
}

/** Evaluates an expression string. Never throws. */
export function evaluate(input: string): EvalResult {
  try {
    const value = new Parser(tokenize(input)).parse();
    if (!Number.isFinite(value)) return { kind: 'undefined', reason: 'Result is not finite' };
    return { kind: 'ok', value };
  } catch (e) {
    if (e instanceof UndefinedResult) return { kind: 'undefined', reason: e.message };
    if (e instanceof SyntaxError_) return { kind: 'error', message: e.message, code: e.code };
    return { kind: 'error', message: 'check symbols', code: 'missing-number' };
  }
}

/**
 * Human-friendly formatting: hides binary floating-point noise
 * (0.1 + 0.2 → "0.3"), avoids "-0" and switches to exponent form for
 * very large/small magnitudes.
 */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return 'Undefined';
  if (Math.abs(value) < 1e-12) return '0';
  const abs = Math.abs(value);
  if (abs >= 1e15 || abs < 1e-6) {
    return value.toExponential(6).replace(/\.?0+e/, 'e');
  }
  const rounded = parseFloat(value.toPrecision(12));
  return String(rounded);
}

export function formatResult(r: EvalResult): string {
  switch (r.kind) {
    case 'ok':
      // Typographic minus, matching the handwritten "−" rather than a hyphen.
      return formatNumber(r.value).replace(/^-/, '−');
    case 'undefined':
      return 'Undefined';
    case 'error':
      return '?';
  }
}

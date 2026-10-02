/**
 * Deterministic arithmetic engine. Never uses eval(): input is tokenised and
 * evaluated by a small recursive-descent parser with BODMAS precedence.
 *
 * Grammar:
 *   expr   := term (('+' | '-') term)*
 *   term   := unary (('*' | '/') unary)*
 *   unary  := ('-' | '+') unary | primary
 *   primary:= NUMBER | 'x' | '(' expr ')'
 *
 * Every value is kept as a linear form a·x + b. Without a variable a = 0 and
 * this is plain arithmetic; with x it lets `solveLinear` solve equations such
 * as 2x + 4 = 10, and `evaluate` substitute a stored value of x.
 */

export type Token =
  | { type: 'num'; value: number; raw: string }
  | { type: 'var' }
  | { type: 'op'; value: '+' | '-' | '*' | '/' }
  | { type: 'paren'; value: '(' | ')' };

/** a·x + b */
export interface Linear {
  a: number;
  b: number;
}

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
  | 'unknown-symbol'
  | 'not-linear'
  | 'unknown-variable';

export type EvalResult =
  | { kind: 'ok'; value: number }
  | { kind: 'undefined'; reason: string }
  /** `message` is short and human-readable, e.g. "missing )". */
  | { kind: 'error'; message: string; code: ErrorCode };

/** Outcome of solving an equation for x. */
export type SolveResult =
  | EvalResult
  | { kind: 'nosolution' }
  /** Both sides are equal for every x (e.g. 2x = x + x). */
  | { kind: 'identity' };

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
    if (ch === 'x') {
      tokens.push({ type: 'var' });
      i++;
      continue;
    }
    throw new SyntaxError_('unknown-symbol', `unknown symbol ${ch}`);
  }
  return insertImplicitMultiplication(tokens);
}

/**
 * Handwritten maths often omits "×": 2(3+4), (1+2)(3+4), (2+3)4, 2x, 3(x−1).
 * Insert the multiplication wherever a value is directly followed by another
 * value.
 */
function insertImplicitMultiplication(tokens: Token[]): Token[] {
  const endsValue = (t: Token) => t.type === 'num' || t.type === 'var' || (t.type === 'paren' && t.value === ')');
  const startsValue = (t: Token) => t.type === 'num' || t.type === 'var' || (t.type === 'paren' && t.value === '(');
  const out: Token[] = [];
  for (const t of tokens) {
    const prev = out[out.length - 1];
    // num-num never occurs (digits are merged), so this only fires around brackets and x.
    if (prev && endsValue(prev) && startsValue(t) && !(prev.type === 'num' && t.type === 'num')) {
      out.push({ type: 'op', value: '*' });
    }
    out.push(t);
  }
  return out;
}

const lin = (a: number, b: number): Linear => ({ a, b });

class Parser {
  private pos = 0;
  /** `x`: substitute this value for the variable; undefined keeps x symbolic. */
  constructor(
    private readonly tokens: Token[],
    private readonly x?: number,
  ) {}

  parse(): Linear {
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

  private expr(): Linear {
    let v = this.term();
    for (let t = this.peek(); t && t.type === 'op' && (t.value === '+' || t.value === '-'); t = this.peek()) {
      this.pos++;
      const r = this.term();
      v = t.value === '+' ? lin(v.a + r.a, v.b + r.b) : lin(v.a - r.a, v.b - r.b);
    }
    return v;
  }

  private term(): Linear {
    let v = this.unary();
    for (let t = this.peek(); t && t.type === 'op' && (t.value === '*' || t.value === '/'); t = this.peek()) {
      this.pos++;
      const r = this.unary();
      if (t.value === '*') {
        // (a₁x + b₁)(a₂x + b₂) stays linear only if one factor is a constant.
        if (v.a !== 0 && r.a !== 0) throw new SyntaxError_('not-linear', 'not linear');
        v = lin(v.a * r.b + r.a * v.b, v.b * r.b);
      } else {
        if (r.a !== 0) throw new SyntaxError_('not-linear', 'not linear');
        if (r.b === 0) throw new UndefinedResult('Division by zero');
        v = lin(v.a / r.b, v.b / r.b);
      }
    }
    return v;
  }

  private unary(): Linear {
    const t = this.peek();
    if (t && t.type === 'op' && (t.value === '-' || t.value === '+')) {
      this.pos++;
      const v = this.unary();
      return t.value === '-' ? lin(-v.a, -v.b) : v;
    }
    return this.primary();
  }

  private primary(): Linear {
    const t = this.peek();
    const prev = this.tokens[this.pos - 1];
    if (!t) {
      if (prev?.type === 'op') throw new SyntaxError_('trailing-operator', `nothing after ${OP_GLYPH[prev.value]}`);
      if (prev?.type === 'paren' && prev.value === '(') throw new SyntaxError_('missing-close', 'missing )');
      throw new SyntaxError_('missing-number', 'number missing');
    }
    if (t.type === 'num') {
      this.pos++;
      return lin(0, t.value);
    }
    if (t.type === 'var') {
      this.pos++;
      return this.x === undefined ? lin(1, 0) : lin(0, this.x);
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

const fail = (e: unknown): EvalResult => {
  if (e instanceof UndefinedResult) return { kind: 'undefined', reason: e.message };
  if (e instanceof SyntaxError_) return { kind: 'error', message: e.message, code: e.code };
  return { kind: 'error', message: 'check symbols', code: 'missing-number' };
};

/** Whether an expression string mentions the variable x. */
export const hasVariable = (input: string) => input.includes('x');

/**
 * Evaluates an expression string. Never throws. If it mentions x, a value for
 * x must be given (a stored value) — otherwise the result is "x has no value".
 * With a known x anything works (x × x is just a number then).
 */
export function evaluate(input: string, x?: number): EvalResult {
  try {
    const tokens = tokenize(input);
    if (x === undefined && tokens.some((t) => t.type === 'var')) {
      new Parser(tokens, 0).parse(); // report syntax errors first
      return { kind: 'error', message: 'x has no value', code: 'unknown-variable' };
    }
    const { b: value } = new Parser(tokens, x).parse();
    if (!Number.isFinite(value)) return { kind: 'undefined', reason: 'Result is not finite' };
    return { kind: 'ok', value };
  } catch (e) {
    return fail(e);
  }
}

/**
 * Solves the linear equation left = right for x. Both sides become a·x + b:
 *   a₁x + b₁ = a₂x + b₂   ⇒   x = (b₂ − b₁) / (a₁ − a₂)
 * Equal coefficients mean no solution (x + 1 = x + 2) or any x (2x = x + x).
 */
export function solveLinear(left: string, right: string): SolveResult {
  try {
    const l = new Parser(tokenize(left)).parse();
    const r = new Parser(tokenize(right)).parse();
    const a = l.a - r.a;
    const b = r.b - l.b;
    const scale = Math.max(1, Math.abs(l.a), Math.abs(r.a), Math.abs(l.b), Math.abs(r.b));
    if (Math.abs(a) < 1e-12 * scale) return Math.abs(b) < 1e-9 * scale ? { kind: 'identity' } : { kind: 'nosolution' };
    const value = b / a;
    if (!Number.isFinite(value)) return { kind: 'undefined', reason: 'Result is not finite' };
    return { kind: 'ok', value };
  } catch (e) {
    return fail(e);
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

export function formatResult(r: SolveResult): string {
  switch (r.kind) {
    case 'ok':
      // Typographic minus, matching the handwritten "−" rather than a hyphen.
      return formatNumber(r.value).replace(/^-/, '−');
    case 'undefined':
      return 'Undefined';
    case 'error':
      return '?';
    case 'nosolution':
      return 'no solution';
    case 'identity':
      return 'any x';
  }
}

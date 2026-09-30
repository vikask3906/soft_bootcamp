/**
 * Scores recognised text against a test sheet.
 *
 * Two levels of alignment, both classic dynamic programming:
 *  1. Rows: expected rows ↔ recognised lines (a row may be missing, and the
 *     page may contain extra lines, e.g. a row split in two or stray dots).
 *  2. Symbols: within a matched row, Levenshtein alignment gives exactly which
 *     symbols were right, substituted (a confusion), missed or extra.
 */

export interface SymbolStat {
  total: number;
  correct: number;
}

export interface Report {
  symbols: Record<string, SymbolStat>;
  /** "expected→got" → count */
  confusions: Record<string, number>;
  missed: Record<string, number>;
  extra: Record<string, number>;
  rows: { expected: string; got: string | null; correct: number; total: number }[];
  extraLines: string[];
  totalSymbols: number;
  correctSymbols: number;
}

const strip = (s: string) => [...s.replace(/\s+/g, '')];

type Op = { kind: 'match' | 'sub'; a: string; b: string } | { kind: 'del'; a: string } | { kind: 'ins'; b: string };

/** Levenshtein alignment with backtrace. */
export function alignSymbols(expected: string[], got: string[]): Op[] {
  const n = expected.length;
  const m = got.length;
  const d = Array.from({ length: n + 1 }, (_, i) => Array.from({ length: m + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (expected[i - 1] === got[j - 1] ? 0 : 1));
    }
  }
  const ops: Op[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && d[i][j] === d[i - 1][j - 1] + (expected[i - 1] === got[j - 1] ? 0 : 1)) {
      ops.push({ kind: expected[i - 1] === got[j - 1] ? 'match' : 'sub', a: expected[i - 1], b: got[j - 1] });
      i--;
      j--;
    } else if (i > 0 && d[i][j] === d[i - 1][j] + 1) {
      ops.push({ kind: 'del', a: expected[i - 1] });
      i--;
    } else {
      ops.push({ kind: 'ins', b: got[j - 1] });
      j--;
    }
  }
  return ops.reverse();
}

function editDistance(a: string[], b: string[]) {
  return alignSymbols(a, b).filter((o) => o.kind !== 'match').length;
}

/** Aligns expected rows with recognised lines (both top-to-bottom). */
export function alignRows(expected: string[], got: string[]): [number | null, number | null][] {
  const E = expected.map(strip);
  const G = got.map(strip);
  const n = E.length;
  const m = G.length;
  const cost = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(Infinity));
  cost[0][0] = 0;
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= m; j++) {
      const c = cost[i][j];
      if (!Number.isFinite(c)) continue;
      if (i < n && j < m) cost[i + 1][j + 1] = Math.min(cost[i + 1][j + 1], c + editDistance(E[i], G[j]));
      if (i < n) cost[i + 1][j] = Math.min(cost[i + 1][j], c + E[i].length); // row missing
      if (j < m) cost[i][j + 1] = Math.min(cost[i][j + 1], c + G[j].length); // extra line
    }
  }
  const pairs: [number | null, number | null][] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && cost[i][j] === cost[i - 1][j - 1] + editDistance(E[i - 1], G[j - 1])) {
      pairs.push([i - 1, j - 1]);
      i--;
      j--;
    } else if (i > 0 && cost[i][j] === cost[i - 1][j] + E[i - 1].length) {
      pairs.push([i - 1, null]);
      i--;
    } else {
      pairs.push([null, j - 1]);
      j--;
    }
  }
  return pairs.reverse();
}

export function scoreSheet(expected: string[], got: string[]): Report {
  const r: Report = { symbols: {}, confusions: {}, missed: {}, extra: {}, rows: [], extraLines: [], totalSymbols: 0, correctSymbols: 0 };
  const bump = (o: Record<string, number>, k: string) => (o[k] = (o[k] ?? 0) + 1);
  for (const [ei, gi] of alignRows(expected, got)) {
    if (ei === null) {
      r.extraLines.push(got[gi!]);
      continue;
    }
    const exp = strip(expected[ei]);
    const g = gi === null ? [] : strip(got[gi]);
    let correct = 0;
    for (const op of alignSymbols(exp, g)) {
      if (op.kind === 'ins') {
        bump(r.extra, op.b);
        continue;
      }
      const s = (r.symbols[op.a] ??= { total: 0, correct: 0 });
      s.total++;
      if (op.kind === 'match') {
        s.correct++;
        correct++;
      } else if (op.kind === 'sub') bump(r.confusions, `${op.a}→${op.b}`);
      else bump(r.missed, op.a);
    }
    r.rows.push({ expected: expected[ei], got: gi === null ? null : got[gi], correct, total: exp.length });
    r.totalSymbols += exp.length;
    r.correctSymbols += correct;
  }
  return r;
}

export function formatReport(r: Report): string {
  const pct = (a: number, b: number) => (b === 0 ? '–' : `${Math.round((100 * a) / b)}%`);
  const lines: string[] = [];
  lines.push(`OVERALL  ${r.correctSymbols}/${r.totalSymbols} symbols = ${pct(r.correctSymbols, r.totalSymbols)}`);
  lines.push('', 'PER SYMBOL');
  for (const [sym, s] of Object.entries(r.symbols).sort()) lines.push(`  ${sym}  ${s.correct}/${s.total}  ${pct(s.correct, s.total)}`);
  const top = (o: Record<string, number>) =>
    Object.entries(o)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k} ×${v}`)
      .join(', ') || 'none';
  lines.push('', `CONFUSIONS  ${top(r.confusions)}`, `MISSED      ${top(r.missed)}`, `EXTRA       ${top(r.extra)}`);
  lines.push('', 'ROWS');
  for (const row of r.rows) {
    const ok = row.correct === row.total && row.got !== null && row.got.replace(/\s/g, '') === row.expected.replace(/\s/g, '');
    lines.push(`  ${ok ? '✓' : '✗'} ${row.expected.padEnd(22)} read: ${row.got ?? '(missing)'}`);
  }
  if (r.extraLines.length) lines.push('', `EXTRA LINES  ${r.extraLines.map((l) => JSON.stringify(l)).join(' ')}`);
  return lines.join('\n');
}

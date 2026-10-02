import type { XY } from '../../src/ink/geometry';

/**
 * Synthetic "handwritten" glyphs as polylines in a 100×100 box (y down).
 * Used to exercise segmentation, the shape recogniser and the digit model
 * without needing a browser.
 */
type Glyph = XY[][];

const arc = (cx: number, cy: number, rx: number, ry: number, a0: number, a1: number, n = 24): XY[] =>
  Array.from({ length: n + 1 }, (_, i) => {
    const t = ((a0 + ((a1 - a0) * i) / n) * Math.PI) / 180;
    return { x: cx + rx * Math.cos(t), y: cy + ry * Math.sin(t) };
  });

const line = (x0: number, y0: number, x1: number, y1: number, n = 10): XY[] =>
  Array.from({ length: n + 1 }, (_, i) => ({ x: x0 + ((x1 - x0) * i) / n, y: y0 + ((y1 - y0) * i) / n }));

export const DIGITS: Record<string, Glyph> = {
  '0': [arc(50, 50, 30, 48, -90, 270, 40)],
  '1': [line(52, 0, 48, 100)],
  '2': [[...arc(50, 28, 30, 26, 190, 380), ...line(78, 42, 18, 100).slice(1), ...line(18, 100, 85, 100).slice(1)]],
  '3': [[...arc(48, 25, 30, 24, 200, 450), ...arc(48, 73, 32, 26, 270, 510).slice(1)]],
  '4': [[...line(62, 0, 12, 66), ...line(12, 66, 88, 66).slice(1)], line(62, 20, 62, 100)],
  '5': [[...line(80, 0, 28, 0), ...line(28, 0, 24, 44).slice(1), ...arc(48, 68, 34, 30, 230, 500).slice(1)]],
  '6': [[...arc(70, 60, 50, 60, 250, 180, 12), ...arc(48, 72, 28, 26, 180, 540, 30).slice(1)]],
  '7': [[...line(12, 0, 88, 0), ...line(88, 0, 38, 100).slice(1)]],
  '8': [[...arc(50, 25, 24, 24, 90, 450, 30), ...arc(50, 74, 30, 25, -90, 270, 30).slice(1)]],
  '9': [[...arc(48, 28, 28, 27, 0, 380, 30), ...line(76, 30, 70, 100).slice(1)]],
};

export const OPERATORS: Record<string, Glyph> = {
  '+': [line(50, 20, 50, 80), line(20, 50, 80, 50)],
  '−': [line(20, 50, 80, 52)],
  '×': [line(25, 25, 75, 75), line(75, 25, 25, 75)],
  '÷': [arc(50, 25, 3, 3, 0, 360, 8), line(20, 50, 80, 50), arc(50, 75, 3, 3, 0, 360, 8)],
  '=': [line(20, 38, 80, 38), line(20, 62, 80, 62)],
  '.': [arc(50, 95, 2.5, 2.5, 0, 360, 8)],
  '(': [arc(80, 50, 45, 55, 235, 125)],
  ')': [arc(20, 50, 45, 55, -55, 55)],
};

/** The variable x, written cursively as two arcs back to back: ")(" (lower-case height). */
export const LETTERS: Record<string, Glyph> = {
  x: [arc(20, 70, 30, 30, -90, 90), arc(80, 70, 30, 30, 90, 270)],
};

export const GLYPHS: Record<string, Glyph> = { ...DIGITS, ...OPERATORS, ...LETTERS };

/**
 * Lays out a string of glyphs left to right, returning recogniser strokes.
 * `size` is the glyph height in px, (x, y) the top-left of the line.
 */
export function writeLine(text: string, x = 20, y = 20, size = 60, startId = 1) {
  const s = size / 100;
  const strokes: { id: number; order: number; pts: XY[] }[] = [];
  let cursor = x;
  let id = startId;
  for (const ch of text) {
    if (ch === ' ') {
      cursor += 40 * s;
      continue;
    }
    const g = GLYPHS[ch];
    if (!g) throw new Error(`No glyph for ${ch}`);
    const narrow = ch === '.' ? 0.3 : ch === '1' || ch === '(' || ch === ')' ? 0.5 : 1;
    for (const poly of g) {
      strokes.push({
        id,
        order: id,
        pts: poly.map((p) => ({ x: cursor + (p.x - (narrow < 1 ? 50 - 50 * narrow : 0)) * s, y: y + p.y * s })),
      });
      id++;
    }
    cursor += 100 * narrow * s + 18 * s;
  }
  return strokes;
}

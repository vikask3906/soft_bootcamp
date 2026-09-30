import { describe, expect, it } from 'vitest';
import { cutStroke, erasePixelsAt, eraseStrokesAt, isScratchGesture, strokesHitByScratch } from '../src/ink/erase';
import { History } from '../src/ink/history';
import type { Stroke } from '../src/ink/types';

const stroke = (id: number, pts: [number, number][]): Stroke => ({
  id,
  order: id,
  width: 3,
  color: '#000',
  points: pts.map(([x, y]) => ({ x, y, p: 0.5 })),
});

const hLine = (id: number, y: number, x0 = 0, x1 = 100) => stroke(id, [[x0, y], [x1, y]]);

describe('History (undo/redo)', () => {
  it('undoes and redoes in order', () => {
    const h = new History();
    const a = [hLine(1, 0)];
    const b = [...a, hLine(2, 10)];
    h.push(a);
    h.push(b);
    expect(h.undo()).toBe(a);
    expect(h.undo()).toEqual([]);
    expect(h.canUndo).toBe(false);
    expect(h.redo()).toBe(a);
    expect(h.redo()).toBe(b);
    expect(h.canRedo).toBe(false);
  });
  it('drops the redo branch after a new edit', () => {
    const h = new History();
    h.push([hLine(1, 0)]);
    h.undo();
    h.push([hLine(2, 0)]);
    expect(h.canRedo).toBe(false);
    expect(h.current[0].id).toBe(2);
  });
  it('caps memory with a history limit', () => {
    const h = new History(5);
    for (let i = 0; i < 50; i++) h.push([hLine(i, 0)]);
    let undos = 0;
    while (h.canUndo) {
      h.undo();
      undos++;
    }
    expect(undos).toBe(4);
  });
  it('ignores pushing the unchanged state', () => {
    const h = new History();
    h.push(h.current);
    expect(h.canUndo).toBe(false);
  });
});

describe('stroke eraser', () => {
  it('removes only strokes under the eraser', () => {
    const strokes = [hLine(1, 0), hLine(2, 50)];
    const out = eraseStrokesAt(strokes, { x: 50, y: 2 }, 5);
    expect(out.map((s) => s.id)).toEqual([2]);
  });
  it('returns the same array when nothing is hit (cheap no-op)', () => {
    const strokes = [hLine(1, 0)];
    expect(eraseStrokesAt(strokes, { x: 50, y: 40 }, 5)).toBe(strokes);
  });
});

describe('pixel eraser', () => {
  it('splits a stroke in two when erasing its middle', () => {
    let id = 100;
    const out = erasePixelsAt([hLine(1, 0)], { x: 50, y: 0 }, 5, () => id++);
    expect(out).toHaveLength(2);
    const [left, right] = out;
    expect(Math.max(...left.points.map((p) => p.x))).toBeLessThan(45);
    expect(Math.min(...right.points.map((p) => p.x))).toBeGreaterThan(55);
    expect(out.every((s) => s.order === 1)).toBe(true); // pieces keep the original order
  });
  it('removes a stroke entirely when fully covered', () => {
    const out = erasePixelsAt([hLine(1, 0, 0, 4)], { x: 2, y: 0 }, 10, () => 9);
    expect(out).toHaveLength(0);
  });
  it('does not leave 1-point crumbs that would read as a decimal point', () => {
    const pieces = cutStroke(hLine(1, 0).points, { x: 1, y: 0 }, 5);
    expect(pieces.every((p) => p.length > 1)).toBe(true);
  });
});

describe('scratch-out gesture', () => {
  const zigzag = (x0: number, y0: number, w: number, n: number) =>
    Array.from({ length: n * 6 }, (_, i) => ({ x: x0 + (Math.floor(i / 3) % 2 ? w : 0) + (i % 3) * (Math.floor(i / 3) % 2 ? -1 : 1), y: y0 + i }));

  it('detects a zig-zag scribble', () => {
    expect(isScratchGesture(zigzag(0, 0, 60, 4))).toBe(true);
  });
  it('does not treat a normal stroke as a scratch', () => {
    const arc = Array.from({ length: 30 }, (_, i) => ({ x: 30 + 30 * Math.cos(i / 5), y: 30 + 30 * Math.sin(i / 5) }));
    expect(isScratchGesture(arc)).toBe(false);
    expect(isScratchGesture(hLine(1, 0).points)).toBe(false);
  });
  it('finds only the strokes it crosses', () => {
    const target = stroke(1, [[10, 5], [10, 20]]);
    const far = stroke(2, [[300, 5], [300, 20]]);
    const hit = strokesHitByScratch([target, far], zigzag(0, 0, 40, 4));
    expect([...hit]).toEqual([1]);
  });
});

import { describe, expect, it } from 'vitest';
import {
  backingStoreSize,
  bboxOfPoints,
  clientToCanvas,
  distToPolyline,
  rangeOverlap,
  segmentsIntersect,
} from '../src/ink/geometry';

describe('coordinate conversion', () => {
  it('maps client coordinates to canvas-local CSS pixels', () => {
    expect(clientToCanvas(150, 90, { left: 50, top: 40 })).toEqual({ x: 100, y: 50 });
  });
  it('is independent of devicePixelRatio (logical space)', () => {
    // Stroke data is stored in CSS px; DPR only affects the backing store.
    const p = clientToCanvas(10, 10, { left: 0, top: 0 });
    expect(p).toEqual({ x: 10, y: 10 });
  });
});

describe('high-DPI backing store', () => {
  it.each([
    [800, 600, 1, 800, 600],
    [800, 600, 2, 1600, 1200],
    [801, 601, 1.25, 1001, 751], // fractional DPR (Windows 125% scaling), rounded
    [375, 812, 3, 1125, 2436],
  ])('%dx%d @%sx → %dx%d', (w, h, dpr, bw, bh) => {
    const s = backingStoreSize(w, h, dpr);
    expect([s.width, s.height]).toEqual([bw, bh]);
    expect(s.scale).toBe(dpr);
  });
  it('falls back to 1 for invalid ratios', () => {
    expect(backingStoreSize(100, 100, 0).scale).toBe(1);
    expect(backingStoreSize(100, 100, NaN).scale).toBe(1);
  });
  it('never produces a zero-size canvas', () => {
    expect(backingStoreSize(0, 0, 2)).toMatchObject({ width: 1, height: 1 });
  });
});

describe('geometry helpers', () => {
  it('computes bounding boxes', () => {
    expect(bboxOfPoints([{ x: 3, y: 9 }, { x: -1, y: 4 }, { x: 5, y: 5 }])).toEqual({ minX: -1, minY: 4, maxX: 5, maxY: 9 });
  });
  it('measures range overlap', () => {
    expect(rangeOverlap(0, 10, 5, 20)).toBe(5);
    expect(rangeOverlap(0, 10, 11, 20)).toBe(0);
  });
  it('detects crossing segments', () => {
    expect(segmentsIntersect({ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 10, y: 0 })).toBe(true);
    expect(segmentsIntersect({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 5 }, { x: 10, y: 5 })).toBe(false);
  });
  it('measures distance to a polyline', () => {
    expect(distToPolyline({ x: 5, y: 3 }, [{ x: 0, y: 0 }, { x: 10, y: 0 }])).toBe(3);
  });
});

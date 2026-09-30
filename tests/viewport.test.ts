import { describe, expect, it } from 'vitest';
import { MAX_SCALE, MIN_SCALE, panBy, pinchView, screenToWorld, worldToScreen, zoomAt, type View } from '../src/ink/viewport';

const close = (a: { x: number; y: number }, b: { x: number; y: number }) => {
  expect(a.x).toBeCloseTo(b.x, 6);
  expect(a.y).toBeCloseTo(b.y, 6);
};

describe('viewport (pan & zoom camera)', () => {
  const v: View = { x: 40, y: -30, scale: 2 };

  it('screen ↔ world round-trips', () => {
    const w = { x: 123.4, y: -56.7 };
    close(screenToWorld(v, worldToScreen(v, w)), w);
  });

  it('identity view maps 1:1', () => {
    close(screenToWorld({ x: 0, y: 0, scale: 1 }, { x: 5, y: 7 }), { x: 5, y: 7 });
  });

  it('zooming keeps the point under the cursor fixed', () => {
    const cursor = { x: 300, y: 200 };
    const before = screenToWorld(v, cursor);
    const after = screenToWorld(zoomAt(v, cursor, 1.7), cursor);
    close(after, before);
  });

  it('clamps zoom to sane limits', () => {
    expect(zoomAt(v, { x: 0, y: 0 }, 1000).scale).toBe(MAX_SCALE);
    expect(zoomAt(v, { x: 0, y: 0 }, 0.0001).scale).toBe(MIN_SCALE);
  });

  it('panning moves the world under the screen', () => {
    const p = { x: 10, y: 10 };
    const moved = panBy(v, 50, -20);
    close(worldToScreen(moved, p), { x: worldToScreen(v, p).x + 50, y: worldToScreen(v, p).y - 20 });
  });

  it('pinch: spreading fingers 2× doubles the zoom, content follows the fingers', () => {
    const start = { x: 0, y: 0, scale: 1 };
    const next = pinchView(start, { x: 100, y: 100 }, 50, { x: 150, y: 120 }, 100);
    expect(next.scale).toBeCloseTo(2);
    // The world point that was under the fingers is now under the new finger centre.
    close(worldToScreen(next, screenToWorld(start, { x: 100, y: 100 })), { x: 150, y: 120 });
  });
});

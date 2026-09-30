import type { XY } from './geometry';

/**
 * Camera over an infinite page. Strokes live in "world" coordinates;
 * the view maps them onto the screen:  screen = world × scale + (x, y).
 * Recognition always works in world space, so zooming or panning never
 * changes what the recogniser sees.
 */
export interface View {
  x: number;
  y: number;
  scale: number;
}

export const MIN_SCALE = 0.25;
export const MAX_SCALE = 4;
export const IDENTITY_VIEW: View = { x: 0, y: 0, scale: 1 };

export const clampScale = (s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

export function screenToWorld(v: View, p: XY): XY {
  return { x: (p.x - v.x) / v.scale, y: (p.y - v.y) / v.scale };
}

export function worldToScreen(v: View, p: XY): XY {
  return { x: p.x * v.scale + v.x, y: p.y * v.scale + v.y };
}

/** Zooms by `factor` keeping the world point under screen point `at` fixed. */
export function zoomAt(v: View, at: XY, factor: number): View {
  const scale = clampScale(v.scale * factor);
  const w = screenToWorld(v, at);
  return { scale, x: at.x - w.x * scale, y: at.y - w.y * scale };
}

export function panBy(v: View, dx: number, dy: number): View {
  return { ...v, x: v.x + dx, y: v.y + dy };
}

/**
 * Two-finger pinch: given the view and finger centroid/spread when the
 * gesture started, returns the view for the current centroid/spread.
 * The world point that was under the starting centroid follows the fingers.
 */
export function pinchView(start: View, startCenter: XY, startSpread: number, center: XY, spread: number): View {
  const factor = startSpread > 0 && spread > 0 ? spread / startSpread : 1;
  const scale = clampScale(start.scale * factor);
  const w = screenToWorld(start, startCenter);
  return { scale, x: center.x - w.x * scale, y: center.y - w.y * scale };
}

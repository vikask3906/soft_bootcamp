import { bboxHeight, bboxOfPoints, bboxWidth, distToSegmentSq, type XY } from '../ink/geometry';

export const MNIST_SIZE = 28;
/** MNIST digits are size-normalised into a 20×20 box inside the 28×28 frame. */
const FIT_BOX = 20;
/** Stroke radius in model-space pixels (MNIST pen is ≈2–3 px wide). */
const PEN_RADIUS = 1.15;

/**
 * Converts raw vector strokes (logical canvas coordinates) into an
 * MNIST-style tensor: 28×28, white ink on black, values in [0, 1],
 * aspect-preserving fit into 20×20, then centred by centre of mass.
 *
 * Rendering is done analytically (distance to segment) instead of through a
 * canvas so it runs identically in a Worker, in Node tests and at any DPR.
 */
export function rasterizeStrokes(strokes: readonly (readonly XY[])[]): Float32Array {
  const all = strokes.flat();
  const out = new Float32Array(MNIST_SIZE * MNIST_SIZE);
  if (all.length === 0) return out;

  const b = bboxOfPoints(all);
  const w = bboxWidth(b);
  const h = bboxHeight(b);
  const scale = FIT_BOX / Math.max(w, h, 1e-6);
  // Very thin symbols (a "1") keep their aspect ratio and stay centred.
  const offX = (MNIST_SIZE - w * scale) / 2;
  const offY = (MNIST_SIZE - h * scale) / 2;

  const mapped = strokes.map((s) => s.map((p) => ({ x: (p.x - b.minX) * scale + offX, y: (p.y - b.minY) * scale + offY })));

  // Pass 1: draw into a scratch buffer.
  const buf = new Float32Array(MNIST_SIZE * MNIST_SIZE);
  for (const s of mapped) {
    const segs: [XY, XY][] = s.length === 1 ? [[s[0], s[0]]] : [];
    for (let i = 1; i < s.length; i++) segs.push([s[i - 1], s[i]]);
    for (const [a, c] of segs) {
      const x0 = Math.max(0, Math.floor(Math.min(a.x, c.x) - PEN_RADIUS - 1));
      const x1 = Math.min(MNIST_SIZE - 1, Math.ceil(Math.max(a.x, c.x) + PEN_RADIUS + 1));
      const y0 = Math.max(0, Math.floor(Math.min(a.y, c.y) - PEN_RADIUS - 1));
      const y1 = Math.min(MNIST_SIZE - 1, Math.ceil(Math.max(a.y, c.y) + PEN_RADIUS + 1));
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const d = Math.sqrt(distToSegmentSq({ x: x + 0.5, y: y + 0.5 }, a, c));
          // Soft anti-aliased edge, 1 px wide.
          const v = Math.max(0, Math.min(1, PEN_RADIUS + 0.5 - d));
          const idx = y * MNIST_SIZE + x;
          if (v > buf[idx]) buf[idx] = v;
        }
      }
    }
  }

  // Pass 2: shift so the centre of mass sits at the frame centre (as MNIST does).
  let mass = 0;
  let cx = 0;
  let cy = 0;
  for (let y = 0; y < MNIST_SIZE; y++) {
    for (let x = 0; x < MNIST_SIZE; x++) {
      const v = buf[y * MNIST_SIZE + x];
      mass += v;
      cx += v * (x + 0.5);
      cy += v * (y + 0.5);
    }
  }
  if (mass === 0) return buf;
  const dx = Math.round(MNIST_SIZE / 2 - cx / mass);
  const dy = Math.round(MNIST_SIZE / 2 - cy / mass);
  for (let y = 0; y < MNIST_SIZE; y++) {
    for (let x = 0; x < MNIST_SIZE; x++) {
      const sx = x - dx;
      const sy = y - dy;
      if (sx >= 0 && sy >= 0 && sx < MNIST_SIZE && sy < MNIST_SIZE) {
        out[y * MNIST_SIZE + x] = buf[sy * MNIST_SIZE + sx];
      }
    }
  }
  return out;
}

/** Debug helper: renders a tensor as ASCII art. */
export function tensorToAscii(t: Float32Array): string {
  const rows: string[] = [];
  for (let y = 0; y < MNIST_SIZE; y++) {
    let row = '';
    for (let x = 0; x < MNIST_SIZE; x++) {
      const v = t[y * MNIST_SIZE + x];
      row += v > 0.66 ? '#' : v > 0.33 ? '+' : v > 0.05 ? '.' : ' ';
    }
    rows.push(row);
  }
  return rows.join('\n');
}

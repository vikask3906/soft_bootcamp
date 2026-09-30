import type { EquationResult } from '../recognition/pipeline';

/** Stroke as sent to the worker: flat [x0, y0, x1, y1, …] to keep messages compact. */
export interface WireStroke {
  id: number;
  order: number;
  xy: Float32Array;
}

export type ToWorker = { type: 'recognize'; requestId: number; strokes: WireStroke[] };

export type FromWorker =
  | { type: 'ready'; backend: string; loadMs: number }
  | { type: 'result'; requestId: number; equations: EquationResult[]; elapsedMs: number }
  | { type: 'error'; requestId?: number; message: string };

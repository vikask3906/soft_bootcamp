import type { Stroke } from '../ink/types';
import type { EquationResult, LineReading } from '../recognition/pipeline';
import type { FromWorker, ToWorker, WireStroke } from './protocol';

export type RecognizerStatus = { state: 'loading' } | { state: 'ready'; loadMs: number } | { state: 'error'; message: string };

/**
 * Main-thread handle to the recognition worker. Requests are debounced and
 * stamped; any response older than the latest request is dropped, so the UI
 * never flashes a stale answer.
 */
export class RecognizerClient {
  private worker: Worker;
  private latest = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly onResult: (eqs: EquationResult[], lines: LineReading[], elapsedMs: number) => void,
    private readonly onStatus: (s: RecognizerStatus) => void,
    private readonly debounceMs = 120,
  ) {
    this.worker = new Worker(new URL('./recognizer.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<FromWorker>) => this.handle(e.data);
    this.worker.onerror = (e) => this.onStatus({ state: 'error', message: e.message });
    this.onStatus({ state: 'loading' });
  }

  schedule(strokes: readonly Stroke[]) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.send(strokes), this.debounceMs);
  }

  private send(strokes: readonly Stroke[]) {
    const wire: WireStroke[] = strokes.map((s) => {
      const xy = new Float32Array(s.points.length * 2);
      s.points.forEach((p, i) => {
        xy[2 * i] = p.x;
        xy[2 * i + 1] = p.y;
      });
      return { id: s.id, order: s.order, xy };
    });
    const msg: ToWorker = { type: 'recognize', requestId: ++this.latest, strokes: wire };
    // Transfer the buffers instead of copying them.
    this.worker.postMessage(msg, wire.map((w) => w.xy.buffer));
  }

  private handle(msg: FromWorker) {
    switch (msg.type) {
      case 'ready':
        this.onStatus({ state: 'ready', loadMs: msg.loadMs });
        break;
      case 'result':
        if (msg.requestId === this.latest) this.onResult(msg.equations, msg.lines, msg.elapsedMs);
        break;
      case 'error':
        if (msg.requestId === undefined) this.onStatus({ state: 'error', message: msg.message });
        else console.warn('[CalcInk] recognition error', msg.message);
        break;
    }
  }

  dispose() {
    clearTimeout(this.timer);
    this.worker.terminate();
  }
}

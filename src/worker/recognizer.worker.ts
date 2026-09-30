/// <reference lib="webworker" />
/**
 * Recognition worker: everything expensive (segmentation, rasterisation,
 * ONNX inference, evaluation) happens here so the UI thread only ever draws
 * ink and stays at 60 FPS.
 */
import * as ort from 'onnxruntime-web/wasm';
import { createDigitClassifier } from '../recognition/model';
import { recognizeDetailed, type DigitClassifier } from '../recognition/pipeline';
import type { RecStroke } from '../recognition/segment';
import type { FromWorker, ToWorker, WireStroke } from './protocol';

declare const self: DedicatedWorkerGlobalScope;

const base = new URL(import.meta.env.BASE_URL, self.location.origin).href;
// Threads need cross-origin isolation, which static hosts rarely provide.
// The .wasm binary itself is referenced by the ORT bundle via `new URL(…, import.meta.url)`,
// so Vite emits it as a hashed asset on our own origin and the service worker precaches it.
ort.env.wasm.numThreads = 1;

const post = (msg: FromWorker) => self.postMessage(msg);

let classifier: DigitClassifier | null = null;
const ready = (async () => {
  const t0 = performance.now();
  const res = await fetch(`${base}models/mnist-12.onnx`);
  if (!res.ok) throw new Error(`Model download failed (${res.status})`);
  classifier = await createDigitClassifier(ort, await res.arrayBuffer());
  post({ type: 'ready', backend: 'wasm', loadMs: Math.round(performance.now() - t0) });
})().catch((e: unknown) => post({ type: 'error', message: `Model failed to load: ${String(e)}` }));

// Only the newest request matters: while one is running, later ones overwrite
// each other so a burst of edits costs at most one extra inference pass.
let running = false;
let queued: Extract<ToWorker, { type: 'recognize' }> | null = null;

self.onmessage = (e: MessageEvent<ToWorker>) => {
  if (e.data.type === 'recognize') {
    queued = e.data;
    void pump();
  }
};

async function pump() {
  if (running) return;
  running = true;
  try {
    await ready;
    while (queued && classifier) {
      const req = queued;
      queued = null;
      const t0 = performance.now();
      try {
        const { equations, lines } = await recognizeDetailed(req.strokes.map(fromWire), classifier, true, req.corrections);
        post({ type: 'result', requestId: req.requestId, equations, lines, elapsedMs: performance.now() - t0 });
      } catch (err) {
        post({ type: 'error', requestId: req.requestId, message: String(err) });
      }
    }
  } finally {
    running = false;
  }
}

function fromWire(s: WireStroke): RecStroke {
  const pts = new Array(s.xy.length / 2);
  for (let i = 0; i < pts.length; i++) pts[i] = { x: s.xy[2 * i], y: s.xy[2 * i + 1] };
  return { id: s.id, order: s.order, pts };
}

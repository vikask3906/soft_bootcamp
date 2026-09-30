import type * as Ort from 'onnxruntime-web';
import { MNIST_SIZE } from './rasterize';
import type { DigitClassifier, DigitPrediction } from './pipeline';

/**
 * Thin wrapper around the ONNX Model Zoo MNIST CNN (mnist-12.onnx).
 * Input:  "Input3"            float32 [1, 1, 28, 28], white-on-black, [0, 1]
 * Output: "Plus214_Output_0"  float32 [1, 10] raw logits
 *
 * The ort module is injected so the same code runs with onnxruntime-web in the
 * browser worker and in Node-based tests.
 */
export async function createDigitClassifier(ort: typeof Ort, model: ArrayBuffer | Uint8Array): Promise<DigitClassifier> {
  const session = await ort.InferenceSession.create(model instanceof Uint8Array ? model : new Uint8Array(model), {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
  });
  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];

  return async (tensors) => {
    const out: DigitPrediction[] = [];
    // The zoo model has a fixed batch of 1, so run sequentially. Each call is ~0.1 ms.
    for (const data of tensors) {
      const input = new ort.Tensor('float32', data, [1, 1, MNIST_SIZE, MNIST_SIZE]);
      const res = await session.run({ [inputName]: input });
      const logits = res[outputName].data as Float32Array;
      out.push(softmaxArgmax(logits));
      res[outputName].dispose();
      input.dispose();
    }
    return out;
  };
}

/**
 * Softmax over the 10 logits: p(i) = e^(z_i) / Σ_j e^(z_j), computed with the
 * max subtracted first for numerical stability. Returns the winner plus the
 * runner-up digits (used as suggestions in tap-to-correct).
 */
export function softmaxArgmax(logits: ArrayLike<number>): DigitPrediction {
  let max = -Infinity;
  for (let i = 0; i < logits.length; i++) if (logits[i] > max) max = logits[i];
  let sum = 0;
  const exps: number[] = [];
  for (let i = 0; i < logits.length; i++) {
    exps.push(Math.exp(logits[i] - max));
    sum += exps[i];
  }
  const ranked = exps.map((e, digit) => ({ digit, p: e / sum })).sort((a, b) => b.p - a.p);
  return { digit: ranked[0].digit, confidence: ranked[0].p, alternatives: ranked.slice(1, 4) };
}

// Copies the ONNX Runtime WebAssembly binary into public/ so it is served
// (and precached by the service worker) from our own origin — no CDN at runtime.
import { copyFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const src = require.resolve('onnxruntime-web/ort-wasm-simd-threaded.wasm');
const outDir = fileURLToPath(new URL('../public/ort/', import.meta.url));
mkdirSync(outDir, { recursive: true });
copyFileSync(src, `${outDir}ort-wasm-simd-threaded.wasm`);
console.log('[copy-ort] ONNX Runtime wasm -> public/ort/');

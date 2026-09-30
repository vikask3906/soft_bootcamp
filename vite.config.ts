/// <reference types="vitest/config" />
import { mkdirSync, writeFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

/**
 * Dev-only: lets a tablet on the LAN upload its real strokes to debug/ on the
 * laptop, so recognition can be tuned against real handwriting (and turned
 * into regression tests). Never part of the production build.
 */
function debugCapture(): Plugin {
  return {
    name: 'calcink-debug-capture',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__calcink/capture', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end();
          return;
        }
        let body = '';
        req.on('data', (chunk) => {
          body += chunk;
          if (body.length > 5_000_000) req.destroy();
        });
        req.on('end', () => {
          try {
            JSON.parse(body);
            mkdirSync('debug', { recursive: true });
            const file = `debug/capture-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
            writeFileSync(file, body);
            server.config.logger.info(`[calcink] saved ${file}`);
            res.end(JSON.stringify({ file }));
          } catch {
            res.statusCode = 400;
            res.end();
          }
        });
      });
    },
  };
}

// Set BASE=/repo-name/ when deploying to GitHub Pages; defaults to "/" (Vercel/Netlify).
const base = process.env.BASE ?? '/';

export default defineConfig({
  base,
  worker: { format: 'es' },
  // Pre-bundling would rewrite ORT's `new URL('*.wasm', import.meta.url)` and break the wasm lookup in dev.
  optimizeDeps: { exclude: ['onnxruntime-web'] },
  build: { target: 'es2022' },
  plugins: [
    debugCapture(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'CalcInk — handwritten calculator',
        short_name: 'CalcInk',
        description: 'Write math by hand; answers appear on the page. Runs fully on-device.',
        theme_color: '#f7f3ea',
        background_color: '#f7f3ea',
        display: 'standalone',
        icons: [{ src: 'favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
      },
      workbox: {
        // Precache everything, including the ONNX model and the WASM runtime,
        // so the app works in airplane mode after the first visit.
        globPatterns: ['**/*.{js,mjs,css,html,svg,woff,woff2,onnx,wasm}'],
        maximumFileSizeToCacheInBytes: 30 * 1024 * 1024,
      },
    }),
  ],
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});

/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// Set BASE=/repo-name/ when deploying to GitHub Pages; defaults to "/" (Vercel/Netlify).
const base = process.env.BASE ?? '/';

export default defineConfig({
  base,
  worker: { format: 'es' },
  // Pre-bundling would rewrite ORT's `new URL('*.wasm', import.meta.url)` and break the wasm lookup in dev.
  optimizeDeps: { exclude: ['onnxruntime-web'] },
  build: { target: 'es2022' },
  plugins: [
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

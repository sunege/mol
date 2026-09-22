/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Makes the page cross-origin isolated, which is what lets it share memory with
 * the DFT worker: the user's 中止 reaches a worker that is busy relaxing only
 * through a `SharedArrayBuffer`, and without one the worker is terminated and
 * the numbers of the structure it reached go with it (`worker/engineSupport.ts`,
 * `canStopInPlace`). The same pair is in `vercel.json` for production.
 * `require-corp` is safe because the app loads nothing from another origin.
 */
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  plugins: [react()],
  server: { headers: isolation },
  preview: { headers: isolation },
  // The DFT worker is an ES module so it can `import` the wasm-bindgen glue.
  worker: { format: 'es' },
  build: {
    // wasm-bindgen glue and the worker both rely on modern syntax.
    target: 'esnext',
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});

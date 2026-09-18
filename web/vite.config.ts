/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
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

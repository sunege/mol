/// <reference lib="webworker" />
/**
 * Runs the WebAssembly DFT engine off the UI thread.
 *
 * The worker owns the WASM instance and any state that is expensive to rebuild
 * (later: the converged density grid, so isosurface threshold changes do not
 * re-run the SCF). It never throws across the message boundary: failures come
 * back as `error` responses, and a non-converged SCF is a normal `scf` response
 * with `converged: false`.
 */
import init, { supportedElements, scf } from '../wasm/dft_wasm.js';
import wasmUrl from '../wasm/dft_wasm_bg.wasm?url';
import type { ElementInfo, ScfOutcome, WorkerRequest, WorkerResponse } from './protocol';

const post = (message: WorkerResponse) => self.postMessage(message);

const ready = init({ module_or_path: wasmUrl }).then(() => {
  post({ id: 0, type: 'ready' });
});

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  try {
    await ready;
    switch (request.type) {
      case 'elements':
        post({
          id: request.id,
          type: 'elements',
          elements: supportedElements() as ElementInfo[],
        });
        break;
      case 'scf': {
        // Timed here rather than in Rust: `std::time::Instant` is not available
        // on wasm32-unknown-unknown.
        const started = performance.now();
        const result = scf(request.z, request.xyz) as Omit<ScfOutcome, 'elapsedMs'>;
        post({
          id: request.id,
          type: 'scf',
          result: { ...result, elapsedMs: performance.now() - started },
        });
        break;
      }
    }
  } catch (error) {
    post({
      id: request.id,
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
    });
  }
};

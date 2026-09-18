/// <reference lib="webworker" />
/**
 * Runs the WebAssembly DFT engine off the UI thread.
 *
 * The worker owns the WASM instance and the converged calculation, which is
 * what makes the isosurface threshold cheap to move: the SCF result and the
 * sampled density stay here, and a new threshold sends back only a mesh.
 *
 * It never throws across the message boundary: failures come back as `error`
 * responses, and a non-converged SCF is a normal `scf` response with
 * `converged: false`.
 */
import init, { supportedElements, scf, type Calculation } from '../wasm/dft_wasm.js';
import wasmUrl from '../wasm/dft_wasm_bg.wasm?url';
import type {
  DensityChannel,
  ElementInfo,
  IsoMesh,
  ScfOutcome,
  WorkerRequest,
  WorkerResponse,
} from './protocol';

const post = (message: WorkerResponse, transfer: Transferable[] = []) =>
  self.postMessage(message, transfer);

const ready = init({ module_or_path: wasmUrl }).then(() => {
  post({ id: 0, type: 'ready' });
});

/**
 * The most recent converged calculation, which the isosurface requests draw
 * from. WASM memory is not garbage collected, so the previous one is released
 * explicitly before it is replaced.
 */
let current: Calculation | null = null;

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
        const calculation = scf(request.z, request.xyz);
        current?.free();
        current = calculation;
        const result = calculation.summary() as Omit<ScfOutcome, 'elapsedMs'>;
        post({
          id: request.id,
          type: 'scf',
          result: { ...result, elapsedMs: performance.now() - started },
        });
        break;
      }
      case 'isosurface': {
        if (!current) throw new Error('no calculation to draw a surface from');
        const started = performance.now();
        const iso = current.isosurface(request.channel, request.isoLevel);
        // Each getter copies its buffer out of WASM memory into a plain
        // ArrayBuffer, so the meshes can be transferred rather than cloned.
        const mesh: IsoMesh = {
          channel: iso.channel as DensityChannel,
          isoLevel: iso.isoLevel,
          positive: {
            positions: iso.positivePositions,
            normals: iso.positiveNormals,
            indices: iso.positiveIndices,
          },
          negative: {
            positions: iso.negativePositions,
            normals: iso.negativeNormals,
            indices: iso.negativeIndices,
          },
          densityMax: iso.densityMax,
          densityMin: iso.densityMin,
          elapsedMs: performance.now() - started,
        };
        iso.free();
        post({ id: request.id, type: 'mesh', mesh }, [
          mesh.positive.positions.buffer,
          mesh.positive.normals.buffer,
          mesh.positive.indices.buffer,
          mesh.negative.positions.buffer,
          mesh.negative.normals.buffer,
          mesh.negative.indices.buffer,
        ]);
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

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
 *
 * A geometry optimisation streams: the engine calls back into JavaScript for
 * every structure it accepts, and each of those is posted immediately. The
 * computation is synchronous and blocks this worker's message loop, but
 * `postMessage` is not - the frames reach the UI thread while the next step is
 * still being solved, which is what lets a slow molecule still animate.
 *
 * The same goes for `progress`: the engine says which part of the work it is
 * starting, and that is posted as it happens, so the interface can name the
 * wait while the atoms stand still.
 */
import init, {
  supportedElements,
  scf,
  optimize,
  type Calculation,
} from '../wasm/dft_wasm.js';
import wasmUrl from '../wasm/dft_wasm_bg.wasm?url';
import { progressFromEngine } from './protocol';
import type {
  DensityChannel,
  ElementInfo,
  IsoMesh,
  ScfOutcome,
  WorkerRequest,
  WorkerResponse,
} from './protocol';

/** What the engine hands the step callback, before it is put on the wire. */
interface RawStep {
  step: number;
  /** Angstrom, flattened. */
  xyz: number[];
  energy: number;
  maxForce: number;
}

const post = (message: WorkerResponse, transfer: Transferable[] = []) =>
  self.postMessage(message, transfer);

/** The engine's progress callback, posting each report under the request's id. */
const reportProgress = (id: number) => (stage: string, step: number) => {
  const progress = progressFromEngine(stage, step);
  if (progress) post({ id, type: 'progress', progress });
};

// A module that cannot be loaded - a browser without WebAssembly SIMD, a failed
// download - is reported rather than left to hang: the client would otherwise
// wait for `ready` forever, and every request with it.
const ready = init({ module_or_path: wasmUrl }).then(
  () => post({ id: 0, type: 'ready' }),
  (error: unknown) =>
    post({
      id: 0,
      type: 'unavailable',
      message: error instanceof Error ? error.message : String(error),
    }),
);

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
        const calculation = scf(request.z, request.xyz, reportProgress(request.id));
        current?.free();
        current = calculation;
        const result = calculation.summary() as Omit<ScfOutcome, 'elapsedMs'>;
        if (import.meta.env.DEV) {
          // The one place the chosen spin state is visible. It must not reach
          // the interface (requirement F4), but a developer checking that O2
          // really was solved as a triplet has to be able to see it somewhere.
          console.debug(
            `[dft] charge ${result.charge}, multiplicity ${result.multiplicity}` +
              ` after ${result.attempts} state(s), converged=${result.converged}`,
          );
        }
        post({
          id: request.id,
          type: 'scf',
          result: { ...result, elapsedMs: performance.now() - started },
        });
        break;
      }
      case 'optimize': {
        const started = performance.now();
        const calculation = optimize(
          request.z,
          request.xyz,
          (raw: RawStep) => {
            // A fresh array each time, so it can be transferred rather than
            // copied; the worker has no use for it afterwards.
            const xyz = new Float32Array(raw.xyz);
            post(
              {
                id: request.id,
                type: 'step',
                step: {
                  step: raw.step,
                  xyz,
                  energy: raw.energy,
                  maxForce: raw.maxForce,
                },
              },
              [xyz.buffer],
            );
          },
          reportProgress(request.id),
        );
        current?.free();
        current = calculation;
        const result = calculation.summary() as Omit<ScfOutcome, 'elapsedMs'>;
        if (import.meta.env.DEV) {
          console.debug(
            `[dft] relaxed in ${result.optimization?.steps ?? 0} step(s), ` +
              `${result.optimization?.reason}, multiplicity ${result.multiplicity}`,
          );
        }
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

/**
 * Owns the DFT worker's lifecycle and correlates requests with responses.
 *
 * Cancellation is deliberately brutal: a single-threaded WASM computation
 * cannot be interrupted from outside, so `cancelAll` terminates the worker and
 * spawns a fresh one. That keeps the UI responsive when the user edits the
 * molecule mid-calculation, at the cost of re-initialising the module (a few
 * milliseconds).
 *
 * A request is not one message each way. A geometry optimisation sends a `step`
 * for every structure it accepts and only then the calculation that ends it, so
 * a pending request stays pending until a terminal response arrives and hands
 * the intermediate ones to a callback on the way through. Everything else is the
 * degenerate case of that with no intermediate responses.
 */
import { isTerminal } from './protocol';
import type {
  DensityRequest,
  ElementInfo,
  IsoMesh,
  OptimizationStep,
  ScfOutcome,
  WorkerRequest,
  WorkerResponse,
} from './protocol';

type Pending = {
  resolve: (response: WorkerResponse) => void;
  reject: (error: Error) => void;
  /** Called for each intermediate response, which does not settle the promise. */
  onPartial?: (response: WorkerResponse) => void;
};

export class DftWorkerClient {
  #worker: Worker | null = null;
  #pending = new Map<number, Pending>();
  #nextId = 1;

  /** Resolves once the freshly spawned worker reports its WASM module ready. */
  #ready!: Promise<void>;

  constructor() {
    this.#spawn();
  }

  #spawn() {
    const worker = new Worker(new URL('./dft.worker.ts', import.meta.url), {
      type: 'module',
    });
    let signalReady: () => void;
    this.#ready = new Promise<void>((resolve) => {
      signalReady = resolve;
    });

    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const response = event.data;
      if (response.type === 'ready') {
        signalReady();
        return;
      }
      const pending = this.#pending.get(response.id);
      if (!pending) return;
      if (!isTerminal(response)) {
        pending.onPartial?.(response);
        return;
      }
      this.#pending.delete(response.id);
      if (response.type === 'error') {
        pending.reject(new Error(response.message));
      } else {
        pending.resolve(response);
      }
    };

    worker.onerror = (event) => {
      this.#rejectAll(new Error(event.message || 'DFT worker crashed'));
    };

    this.#worker = worker;
  }

  #rejectAll(error: Error) {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }

  #send<T extends WorkerResponse>(
    build: (id: number) => WorkerRequest,
    onPartial?: Pending['onPartial'],
    transfer: Transferable[] = [],
  ): Promise<T> {
    const id = this.#nextId++;
    const request = build(id);
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, {
        resolve: resolve as Pending['resolve'],
        reject,
        onPartial,
      });
      this.#ready.then(() => this.#worker?.postMessage(request, transfer));
    });
  }

  /** Element data for the periodic table picker and 3D rendering. */
  async elements(): Promise<ElementInfo[]> {
    const response = await this.#send<Extract<WorkerResponse, { type: 'elements' }>>((id) => ({
      id,
      type: 'elements',
    }));
    return response.elements;
  }

  /**
   * Single-point Kohn-Sham calculation for a geometry in Angstrom.
   *
   * A molecule that fails to converge resolves normally with
   * `converged: false`; the promise only rejects when the geometry itself
   * cannot be handled, or when the worker is replaced by `cancelAll`.
   */
  async scf(z: Uint8Array, xyz: Float64Array): Promise<ScfOutcome> {
    const response = await this.#send<Extract<WorkerResponse, { type: 'scf' }>>((id) => ({
      id,
      type: 'scf',
      z,
      xyz,
    }));
    return response.result;
  }

  /**
   * Relaxes a structure towards the nearest minimum of the energy.
   *
   * `onStep` is called with every geometry the optimiser accepts, in Angstrom,
   * as it is produced - that stream is the animation. The promise resolves with
   * the calculation at the final geometry; a structure that did not reach a
   * minimum resolves normally with `optimization.converged: false`, exactly as a
   * non-converged SCF does.
   */
  async optimize(
    z: Uint8Array,
    xyz: Float64Array,
    onStep: (step: OptimizationStep) => void,
  ): Promise<ScfOutcome> {
    const response = await this.#send<Extract<WorkerResponse, { type: 'scf' }>>(
      (id) => ({ id, type: 'optimize', z, xyz }),
      (partial) => {
        if (partial.type === 'step') onStep(partial.step);
      },
    );
    return response.result;
  }

  /**
   * Triangulates one channel of the last [`scf`] call's density at `isoLevel`,
   * in electrons per cubic Bohr.
   *
   * The density stays in the worker, so this is a mesh rebuild rather than a
   * new calculation. It rejects when no calculation is loaded, which happens
   * after `cancelAll` replaces the worker.
   */
  async isosurface(channel: DensityRequest, isoLevel: number): Promise<IsoMesh> {
    const response = await this.#send<Extract<WorkerResponse, { type: 'mesh' }>>((id) => ({
      id,
      type: 'isosurface',
      channel,
      isoLevel,
    }));
    return response.mesh;
  }

  /**
   * Aborts every in-flight computation by replacing the worker.
   *
   * The converged calculation the worker was holding goes with it, so an
   * isosurface cannot be drawn again until the next `scf`.
   */
  cancelAll() {
    this.#worker?.terminate();
    this.#rejectAll(new Error('cancelled'));
    this.#spawn();
  }

  dispose() {
    this.#worker?.terminate();
    this.#worker = null;
    this.#rejectAll(new Error('disposed'));
  }
}

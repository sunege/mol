/**
 * Owns the DFT worker's lifecycle and correlates requests with responses.
 *
 * Cancellation is deliberately brutal: a single-threaded WASM computation
 * cannot be interrupted from outside, so `cancelAll` terminates the worker and
 * spawns a fresh one. That keeps the UI responsive when the user edits the
 * molecule mid-calculation, at the cost of re-initialising the module (a few
 * milliseconds).
 */
import type { ElementInfo, WorkerRequest, WorkerResponse } from './protocol';

type Pending = {
  resolve: (response: WorkerResponse) => void;
  reject: (error: Error) => void;
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
    transfer: Transferable[] = [],
  ): Promise<T> {
    const id = this.#nextId++;
    const request = build(id);
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as Pending['resolve'], reject });
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

  /** Nuclear repulsion energy in Hartree for a geometry in Angstrom. */
  async nuclearRepulsion(z: Uint8Array, xyz: Float64Array): Promise<number> {
    const response = await this.#send<
      Extract<WorkerResponse, { type: 'nuclearRepulsion' }>
    >((id) => ({ id, type: 'nuclearRepulsion', z, xyz }));
    return response.energy;
  }

  /** Aborts every in-flight computation by replacing the worker. */
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

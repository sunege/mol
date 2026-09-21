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
 * for every structure it accepts and only then the calculation that ends it, and
 * both kinds of calculation send a `progress` as each part of the work starts,
 * so a pending request stays pending until a terminal response arrives and hands
 * the intermediate ones to a callback on the way through. Everything else is the
 * degenerate case of that with no intermediate responses.
 *
 * An engine that cannot start is the one failure that is not about a request.
 * A browser without WebAssembly SIMD is caught before any worker is spawned
 * (`engineSupport.ts`); anything else that stops the module loading is reported
 * by the worker, or shows up as an error before it ever says it is ready. Either
 * way every pending request is rejected with an {@link EngineUnavailableError},
 * and so is every request after it - rather than all of them waiting for a
 * `ready` that will never come, which is what used to happen.
 */
import { isTerminal } from './protocol';
import { checkEngineSupport, EngineUnavailableError, type EngineProblem } from './engineSupport';
import type {
  CalculationProgress,
  DensityRequest,
  ElementInfo,
  IsoMesh,
  ModelLevel,
  OptimizationStep,
  ScfOutcome,
  WorkerRequest,
  WorkerResponse,
} from './protocol';

/**
 * Starts the worker the client talks to. Production uses the real module
 * worker; the tests hand in a stand-in that answers from a script, which is why
 * this is a parameter rather than a line in `#spawn`.
 */
export type SpawnWorker = () => Worker;

const spawnDftWorker: SpawnWorker = () =>
  new Worker(new URL('./dft.worker.ts', import.meta.url), { type: 'module' });

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
  #spawnWorker: SpawnWorker;

  /** Resolves once the freshly spawned worker reports its WASM module ready. */
  #ready!: Promise<void>;

  /** Set once the engine is known not to run here; every request rejects with it. */
  #unavailable: EngineUnavailableError | null = null;

  /**
   * `support` is what `checkEngineSupport()` says about this browser; the tests
   * pass it in to play one without WebAssembly SIMD.
   */
  constructor(
    spawnWorker: SpawnWorker = spawnDftWorker,
    support: EngineProblem | null = checkEngineSupport(),
  ) {
    this.#spawnWorker = spawnWorker;
    if (support !== null) {
      // Not even worth downloading the module: it cannot compile here.
      this.#giveUp(new EngineUnavailableError(support));
      return;
    }
    this.#spawn();
  }

  /** Why the engine cannot run in this browser, once that is known. */
  get unavailable(): EngineUnavailableError | null {
    return this.#unavailable;
  }

  #spawn() {
    let worker: Worker;
    try {
      worker = this.#spawnWorker();
    } catch (error) {
      // A browser that cannot construct a module worker at all.
      this.#giveUp(
        new EngineUnavailableError(
          'failed-to-load',
          error instanceof Error ? error.message : String(error),
        ),
      );
      return;
    }
    let started = false;
    let signalReady: () => void;
    this.#ready = new Promise<void>((resolve) => {
      signalReady = resolve;
    });

    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const response = event.data;
      if (response.type === 'ready') {
        started = true;
        signalReady();
        return;
      }
      if (response.type === 'unavailable') {
        this.#giveUp(new EngineUnavailableError('failed-to-load', response.message));
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
      // Before `ready`, an error means the worker never started - its script
      // did not load, or the browser cannot run a module worker - and a new
      // worker would fail the same way.
      if (!started) {
        this.#giveUp(new EngineUnavailableError('failed-to-load', event.message));
        return;
      }
      this.#rejectAll(new Error(event.message || 'DFT worker crashed'));
    };

    this.#worker = worker;
  }

  #rejectAll(error: Error) {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }

  /** The engine will not run here: fail everything now and everything later. */
  #giveUp(error: EngineUnavailableError) {
    this.#unavailable = error;
    this.#worker?.terminate();
    this.#worker = null;
    this.#rejectAll(error);
  }

  #send<T extends WorkerResponse>(
    build: (id: number) => WorkerRequest,
    onPartial?: Pending['onPartial'],
    transfer: Transferable[] = [],
  ): Promise<T> {
    if (this.#unavailable) return Promise.reject(this.#unavailable);
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
   *
   * `onProgress` hears which part of the work has started, while it runs.
   *
   * `level` is what the calculation is for; omitted means `'shape'`. Results
   * at different levels cannot be compared (see {@link ModelLevel}).
   */
  async scf(
    z: Uint8Array,
    xyz: Float64Array,
    onProgress?: (progress: CalculationProgress) => void,
    level?: ModelLevel,
  ): Promise<ScfOutcome> {
    const response = await this.#send<Extract<WorkerResponse, { type: 'scf' }>>(
      (id) => ({ id, type: 'scf', z, xyz, level }),
      (partial) => {
        if (partial.type === 'progress') onProgress?.(partial.progress);
      },
    );
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
   *
   * `onProgress` hears which part of the work has started - most of the wait
   * before the first step is spent where no atom moves.
   *
   * `budgetMs` is a wall-clock limit shorter than the engine's own, for a caller
   * that cannot wait as long as it can - the candidate pool. It resolves
   * normally with `optimization.reason: 'interrupted'` and the structure the
   * optimiser had reached, so a relaxation stopped this way still has an answer,
   * unlike one thrown away with its worker by `cancelAll`.
   *
   * `level` is what the calculation is for, and holds for every step; omitted
   * means `'shape'`.
   */
  async optimize(
    z: Uint8Array,
    xyz: Float64Array,
    onStep: (step: OptimizationStep) => void,
    onProgress?: (progress: CalculationProgress) => void,
    budgetMs?: number | null,
    level?: ModelLevel,
  ): Promise<ScfOutcome> {
    const response = await this.#send<Extract<WorkerResponse, { type: 'scf' }>>(
      (id) => ({ id, type: 'optimize', z, xyz, budgetMs, level }),
      (partial) => {
        if (partial.type === 'step') onStep(partial.step);
        else if (partial.type === 'progress') onProgress?.(partial.progress);
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
    // An engine that could not start the first time will not the second.
    if (!this.#unavailable) this.#spawn();
  }

  dispose() {
    this.#worker?.terminate();
    this.#worker = null;
    this.#rejectAll(new Error('disposed'));
  }
}

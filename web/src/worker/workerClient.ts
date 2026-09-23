/**
 * Owns the DFT worker's lifecycle and correlates requests with responses.
 *
 * Cancellation is deliberately brutal: a single-threaded WASM computation
 * cannot be interrupted from outside, so `cancelAll` terminates the worker and
 * spawns a fresh one. That keeps the UI responsive when the user edits the
 * molecule mid-calculation, at the cost of re-initialising the module (a few
 * milliseconds). The user's 中止 keeps what a relaxation reached instead
 * (`stopRelaxations`): on a page that can share memory with the worker it is
 * asked to stop after its current step, and answers with the numbers as well;
 * anywhere else it is terminated the same way, and only the structure is kept -
 * the steps have already crossed.
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
import { isTerminal, raiseStop, stopFlag } from './protocol';
import {
  canStopInPlace,
  checkEngineSupport,
  EngineUnavailableError,
  type EngineProblem,
} from './engineSupport';
import type {
  CalculationProgress,
  DensityRequest,
  ElementInfo,
  IsoMesh,
  ModelLevel,
  OptimizationStep,
  OrbitalLevel,
  ScfOutcome,
  SpinChannel,
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
  /**
   * Set for an `optimize` request: the last geometry it streamed, which is
   * what {@link DftWorkerClient.stopRelaxations} keeps, and the flag that
   * stops it in place where the page can share memory.
   */
  relaxation?: { last: OptimizationStep | null; flag: Int32Array | null };
};

/**
 * What {@link DftWorkerClient.stopRelaxations} did.
 *
 * - `idle` — no relaxation was in flight, and nothing changed.
 * - `stopping` — each was asked to stop after the step it is on, and will
 *   answer normally, with `reason: 'interrupted'` and the calculation at the
 *   structure it reached.
 * - `stopped` — the worker was replaced, and each rejected with a
 *   {@link RelaxationStopped}.
 */
export type StopOutcome = 'idle' | 'stopping' | 'stopped';

/**
 * A relaxation the user stopped, and how far it had got.
 *
 * What {@link DftWorkerClient.stopRelaxations} rejects a relaxation with. The
 * worker is replaced to stop it, and the calculation it was holding goes with
 * it - but every accepted geometry has already crossed the boundary as a
 * `step`, so the last of them is still here to keep. Not a failure: the
 * structure it reached is a real, partly relaxed one, and only the numbers of
 * it are lost.
 */
export class RelaxationStopped extends Error {
  /** The last geometry the optimiser accepted, or null if none had arrived. */
  readonly last: OptimizationStep | null;

  constructor(last: OptimizationStep | null) {
    super(last === null ? 'stopped before the first step' : `stopped after step ${last.step}`);
    this.name = 'RelaxationStopped';
    this.last = last;
  }
}

export class DftWorkerClient {
  #worker: Worker | null = null;
  #pending = new Map<number, Pending>();
  #nextId = 1;
  #spawnWorker: SpawnWorker;

  /** Resolves once the freshly spawned worker reports its WASM module ready. */
  #ready!: Promise<void>;

  /** Set once the engine is known not to run here; every request rejects with it. */
  #unavailable: EngineUnavailableError | null = null;

  /** Whether a relaxation can be asked to stop rather than terminated. */
  readonly #stopInPlace: boolean;

  /**
   * `support` is what `checkEngineSupport()` says about this browser; the tests
   * pass it in to play one without WebAssembly SIMD. `stopInPlace` is what
   * `canStopInPlace()` says about this page, which the tests play both ways.
   */
  constructor(
    spawnWorker: SpawnWorker = spawnDftWorker,
    support: EngineProblem | null = checkEngineSupport(),
    stopInPlace: boolean = canStopInPlace(),
  ) {
    this.#spawnWorker = spawnWorker;
    this.#stopInPlace = stopInPlace;
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

  #rejectAll(error: Error | ((pending: Pending) => Error)) {
    for (const pending of this.#pending.values()) {
      pending.reject(typeof error === 'function' ? error(pending) : error);
    }
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
    relaxation?: Pending['relaxation'],
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
        relaxation,
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
   *
   * {@link stopRelaxations} ends it early the way the user does: normally
   * with `reason: 'interrupted'` where the worker can be asked to, and
   * otherwise by rejecting with a {@link RelaxationStopped} that carries the
   * last step.
   */
  async optimize(
    z: Uint8Array,
    xyz: Float64Array,
    onStep: (step: OptimizationStep) => void,
    onProgress?: (progress: CalculationProgress) => void,
    budgetMs?: number | null,
    level?: ModelLevel,
  ): Promise<ScfOutcome> {
    const relaxation: NonNullable<Pending['relaxation']> = {
      last: null,
      flag: this.#stopInPlace ? stopFlag() : null,
    };
    const response = await this.#send<Extract<WorkerResponse, { type: 'scf' }>>(
      (id) => ({ id, type: 'optimize', z, xyz, budgetMs, level, stop: relaxation.flag }),
      (partial) => {
        if (partial.type === 'step') {
          relaxation.last = partial.step;
          onStep(partial.step);
        } else if (partial.type === 'progress') onProgress?.(partial.progress);
      },
      relaxation,
    );
    return response.result;
  }

  /**
   * The orbital ladder of the last [`scf`] call, lowest rung first.
   *
   * Cheap enough to ask for whenever the section that shows it is opened: it
   * reads a calculation that is already solved and samples nothing. Rejects
   * when no calculation is loaded, as {@link isosurface} does.
   */
  async orbitals(): Promise<OrbitalLevel[]> {
    const response = await this.#send<Extract<WorkerResponse, { type: 'orbitals' }>>((id) => ({
      id,
      type: 'orbitals',
    }));
    return response.levels;
  }

  /**
   * Triangulates one channel of the last [`scf`] call's density at `isoLevel`,
   * in electrons per cubic Bohr.
   *
   * The density stays in the worker, so this is a mesh rebuild rather than a
   * new calculation. It rejects when no calculation is loaded, which happens
   * after `cancelAll` replaces the worker.
   *
   * `orbital` and `spin` belong to `channel: 'orbital'` and are ignored by the
   * others: which orbital of which spin's ladder to draw, named as an
   * {@link OrbitalLevel} names its own. Only the orbital asked for last stays
   * sampled, so going back to an earlier one costs what the first one did.
   */
  async isosurface(
    channel: DensityRequest,
    isoLevel: number,
    orbital?: number,
    spin?: SpinChannel,
  ): Promise<IsoMesh> {
    const response = await this.#send<Extract<WorkerResponse, { type: 'mesh' }>>((id) => ({
      id,
      type: 'isosurface',
      channel,
      isoLevel,
      orbital,
      spin,
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
    this.#replaceWorker(() => new Error('cancelled'));
  }

  /**
   * Stops the relaxations in flight where they are, as the user's 中止 does.
   *
   * Unlike {@link cancelAll}, which is for a molecule about to be replaced,
   * this keeps what a relaxation reached. Where the page can share memory
   * with the worker, each is asked to stop after the step it is on and
   * answers normally - numbers, record and surface included - and the worker
   * and anything else it is doing are left alone. That waits for the step to
   * finish, so it is only done for a relaxation that has a step to show for
   * it, and `immediately` skips it for a user who will not wait.
   *
   * Otherwise the worker is replaced: each relaxation rejects with a
   * {@link RelaxationStopped} carrying the last geometry it streamed, and
   * anything else in flight is cancelled as `cancelAll` would. Nothing happens
   * when no relaxation is in flight - one that has just answered keeps its
   * worker, and the density the worker is holding for it.
   */
  stopRelaxations(immediately = false): StopOutcome {
    const relaxations = [...this.#pending.values()].flatMap((pending) =>
      pending.relaxation ? [pending.relaxation] : [],
    );
    if (relaxations.length === 0) return 'idle';
    if (!immediately && relaxations.every(({ flag, last }) => flag !== null && last !== null)) {
      for (const { flag } of relaxations) if (flag) raiseStop(flag);
      return 'stopping';
    }
    this.#replaceWorker((pending) =>
      pending.relaxation ? new RelaxationStopped(pending.relaxation.last) : new Error('cancelled'),
    );
    return 'stopped';
  }

  #replaceWorker(reasonFor: (pending: Pending) => Error) {
    this.#worker?.terminate();
    this.#rejectAll(reasonFor);
    // An engine that could not start the first time will not the second.
    if (!this.#unavailable) this.#spawn();
  }

  dispose() {
    this.#worker?.terminate();
    this.#worker = null;
    this.#rejectAll(new Error('disposed'));
  }
}

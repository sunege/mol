/**
 * Runs several relaxations at once, behind the worker the screen is using.
 *
 * The front of the app owns one worker (`App`'s `clientRef`) and everything the
 * user is looking at goes through it - the animation, the measurements, the
 * isosurfaces. This pool is a second set of workers that nobody is waiting on,
 * so a class can start half a dozen shapes relaxing and carry on turning the
 * molecule while they run.
 *
 * Three measurements shaped it (`docs/dev-notes.md`, "P10-1 の実測"):
 *
 * - **The front worker is what the size has to protect.** On a machine with two
 *   physical cores, one candidate in the background costs the front worker 20%,
 *   two cost it two and a half times, three nearly four - while the candidates'
 *   own throughput stops improving after the first one or two. So the pool is
 *   sized from the cores that are there and deliberately left small
 *   ({@link poolSize}), not from what `hardwareConcurrency` reports.
 * - **A worker keeps the largest molecule it ever ran.** WebAssembly memory does
 *   not shrink, so a worker that has relaxed benzene holds 139 MiB until it is
 *   terminated. Candidates of one batch are the same molecule, so the workers
 *   are reused while work remains and dropped as soon as the queue empties.
 * - **A candidate can be stopped without losing it.** {@link CANDIDATE_BUDGET_MS}
 *   goes to the worker, which ends the relaxation between steps and answers with
 *   the structure it had reached - unlike cancelling, which terminates the
 *   worker and takes the structure with it.
 *
 * Nothing here knows about records or about the screen: it schedules
 * relaxations and says what happened to each one. What a finished candidate is
 * worth keeping as is the App's business (`records/`).
 */
import { DftWorkerClient, type SpawnWorker } from '../worker/workerClient';
import { EngineUnavailableError, type EngineProblem } from '../worker/engineSupport';
import { hasUsableStructure, type ModelLevel, type ScfOutcome } from '../worker/protocol';

/**
 * The most candidates run at once, whatever the machine reports.
 *
 * Three, because past that nothing is gained and several things are lost: the
 * candidates' total throughput was already flat at two on every molecule
 * measured, the front worker slows in proportion to the number behind it, three
 * benzene workers hold about 420 MiB between them, and the machine this is for
 * is a 15 W laptop whose two fast cores are what the front worker wants.
 */
export const MAX_CONCURRENT = 3;

/**
 * Wall-clock limit for one candidate, in milliseconds.
 *
 * Not a guess about how long an answer may take - the engine's own budget, half
 * an hour, is that - but a limit on how long one candidate may hold a slot.
 * Without it a queue behind a stuck candidate never moves, and half an hour is
 * longer than the lecture. Ten minutes is far above anything healthy: the
 * largest molecule the app supports relaxes in about half a minute on its own,
 * and a nudged one took about two, so even three-deep contention leaves room.
 *
 * A candidate stopped by it is not a failure. It comes back `'partial'`, with
 * the structure the optimiser had reached, exactly like one that ran out of
 * steps.
 */
export const CANDIDATE_BUDGET_MS = 10 * 60 * 1000;

/**
 * What every candidate is solved for - always finding the shape, whatever the
 * user has chosen for the calculations in front.
 *
 * That is what a search is for: which shapes a molecule can fall into, and the
 * minima it finds do not change when the level does (`docs/dev-notes.md`,
 * "v3-0 の実測"). Memory would decide it anyway. A worker that relaxed benzene
 * at `'measure'` holds about 250 MiB - its two-electron integrals alone are
 * 105 MiB - and {@link MAX_CONCURRENT} of them come near a gigabyte that does
 * not shrink until they are terminated.
 *
 * The pool takes no level, so nothing the front chooses can reach it. The App
 * writes its records of candidates at this level too, which keeps what was
 * asked for and what a record says it was from drifting apart.
 */
export const SEARCH_LEVEL: ModelLevel = 'shape';

/**
 * How many candidates to run at once on a machine reporting `hardwareConcurrency`.
 *
 * Halving it is a guess at how many *physical* cores there are, since what the
 * browser reports counts hyperthreads (and, on a recent laptop, slow efficiency
 * cores as equals). One more is taken off for the front worker, which is the
 * one that must not be kept waiting. A browser that will not say gets the
 * smallest answer rather than an optimistic one.
 *
 * The measured machine has two physical cores and reports four, and one
 * candidate is exactly what it could afford. The lecture machine reports twelve
 * and would get five, which {@link MAX_CONCURRENT} brings down to three.
 */
export function poolSize(hardwareConcurrency: number | undefined): number {
  const reported = Number.isFinite(hardwareConcurrency) ? (hardwareConcurrency as number) : 2;
  return Math.min(MAX_CONCURRENT, Math.max(1, Math.floor(reported / 2) - 1));
}

/** Where a candidate has got to. */
export type CandidateStatus =
  /** In the queue, waiting for a free worker. */
  | 'waiting'
  /** Being relaxed now. */
  | 'running'
  /** Came to rest: a shape to compare with the others. */
  | 'settled'
  /**
   * Stopped while still moving - out of steps, or out of this pool's budget.
   * A real, partly relaxed structure, which is why it is kept (requirement F5).
   */
  | 'partial'
  /**
   * No self-consistent density for these nuclei. There is nothing to show but
   * the molecule coming apart, and no number is worth printing (requirement F5).
   */
  | 'failed'
  /** Stopped by the user. Nothing came back. */
  | 'cancelled'
  /** The engine will not run in this browser, so this was never started. */
  | 'unavailable';

/** A shape to try, as the pool is given it. */
export interface CandidateRequest {
  id: string;
  /** Shared by every candidate started together, and kept on their records. */
  batch: string;
  z: Uint8Array;
  /**
   * The structure this candidate was made from, in Angstrom - before any nudge.
   * The pool does not use it; it is carried so a record can say what the shape
   * came out of.
   */
  built: Float64Array;
  /** What is actually submitted, in Angstrom: the nudged structure, or `built`. */
  start: Float64Array;
  /**
   * The charge on each atom, in the order of `z` (v7). A nudge moves atoms, never
   * their charges, so every candidate of a batch carries the structure's own.
   */
  charges: Int8Array;
}

/** A shape being tried, with everything known about it so far. */
export interface Candidate extends CandidateRequest {
  status: CandidateStatus;
  /** On the injected clock, or null while it waits. */
  startedAt: number | null;
  finishedAt: number | null;
  /** Moves the optimiser has accepted so far. */
  steps: number;
  /** The calculation at the end, for a candidate that produced one. */
  outcome: ScfOutcome | null;
  /** Every accepted geometry, in Angstrom - what a record replays. */
  trajectory: number[][];
  /** The energy at each geometry of `trajectory`, in Hartree. */
  stepEnergies: number[];
}

export interface SearchPoolOptions {
  /** How many run at once. {@link poolSize} is where the App gets it. */
  size: number;
  /** Called whenever any candidate changes, with all of them in the order added. */
  onChange: (candidates: Candidate[]) => void;
  /**
   * Called once for each candidate that ends with a structure worth keeping -
   * `'settled'` or `'partial'`. The App turns these into records.
   */
  onFinished?: (candidate: Candidate) => void;
  /** Overridden by the tests to play a worker; production uses the real one. */
  spawnWorker?: SpawnWorker;
  /**
   * What this browser can run, as {@link checkEngineSupport} says. Only given by
   * the tests, which are not in a browser and play one directly.
   */
  support?: EngineProblem | null;
  /** Milliseconds a candidate may run, or null for the engine's budget alone. */
  budgetMs?: number | null;
  /**
   * The clock the candidates' start and finish times are on. It has to be the
   * one the panel reads them against, which is `performance.now()` like the
   * progress card's.
   */
  now?: () => number;
}

/** A worker of the pool, and the candidate it is on. */
interface Slot {
  client: DftWorkerClient;
  candidate: Candidate | null;
}

export class SearchPool {
  readonly #size: number;
  readonly #onChange: (candidates: Candidate[]) => void;
  readonly #onFinished?: (candidate: Candidate) => void;
  readonly #spawnWorker?: SpawnWorker;
  readonly #support?: EngineProblem | null;
  readonly #budgetMs: number | null;
  readonly #now: () => number;

  #candidates: Candidate[] = [];
  #slots: Slot[] = [];
  #disposed = false;
  /** Set once a client has said the engine cannot run here. */
  #unavailable: EngineUnavailableError | null = null;

  constructor(options: SearchPoolOptions) {
    this.#size = Math.max(1, Math.floor(options.size));
    this.#onChange = options.onChange;
    this.#onFinished = options.onFinished;
    this.#spawnWorker = options.spawnWorker;
    this.#support = options.support;
    this.#budgetMs = options.budgetMs === undefined ? CANDIDATE_BUDGET_MS : options.budgetMs;
    this.#now = options.now ?? (() => performance.now());
  }

  /** Every candidate this pool has been given, in the order it was given them. */
  get candidates(): Candidate[] {
    return this.#candidates;
  }

  /** Whether anything is still waiting or running. */
  get busy(): boolean {
    return this.#candidates.some(
      (candidate) => candidate.status === 'waiting' || candidate.status === 'running',
    );
  }

  /** Why the engine cannot run here, once a worker has said so. */
  get unavailable(): EngineUnavailableError | null {
    return this.#unavailable;
  }

  /** Queues shapes to try, and starts as many as there is room for. */
  add(requests: readonly CandidateRequest[]) {
    if (this.#disposed || requests.length === 0) return;
    for (const request of requests) {
      this.#candidates.push({
        ...request,
        status: this.#unavailable ? 'unavailable' : 'waiting',
        startedAt: null,
        finishedAt: null,
        steps: 0,
        outcome: null,
        trajectory: [],
        stepEnergies: [],
      });
    }
    this.#pump();
    this.#changed();
  }

  /**
   * Stops one candidate.
   *
   * A running one takes its worker with it - a single-threaded WebAssembly
   * computation cannot be interrupted from outside - and the replacement picks
   * up the next candidate in the queue.
   */
  cancel(id: string) {
    const candidate = this.#candidates.find((each) => each.id === id);
    if (!candidate) return;
    if (candidate.status === 'waiting') {
      this.#finish(candidate, 'cancelled');
      this.#changed();
      return;
    }
    if (candidate.status !== 'running') return;
    const slot = this.#slots.find((each) => each.candidate === candidate);
    // Marked before the worker is replaced, so the rejection that follows knows
    // it was asked for.
    this.#finish(candidate, 'cancelled');
    if (slot) {
      slot.candidate = null;
      slot.client.cancelAll();
    }
    this.#pump();
    this.#changed();
  }

  /** Stops everything, queue included, and gives the workers back. */
  cancelAll() {
    let touched = false;
    for (const candidate of this.#candidates) {
      if (candidate.status === 'waiting' || candidate.status === 'running') {
        this.#finish(candidate, 'cancelled');
        touched = true;
      }
    }
    this.#releaseWorkers();
    if (touched) this.#changed();
  }

  /** Forgets every candidate that has finished, leaving the running ones. */
  clearFinished() {
    const before = this.#candidates.length;
    this.#candidates = this.#candidates.filter(
      (candidate) => candidate.status === 'waiting' || candidate.status === 'running',
    );
    if (this.#candidates.length !== before) this.#changed();
  }

  /**
   * Stops everything and releases the workers for good.
   *
   * Deliberately silent: this is what the App calls as it unmounts, and
   * `onChange` there is a `setState` on a component that is going away.
   * {@link candidates} still says what happened to each one.
   */
  dispose() {
    this.#disposed = true;
    for (const candidate of this.#candidates) {
      if (candidate.status === 'waiting' || candidate.status === 'running') {
        this.#finish(candidate, 'cancelled');
      }
    }
    this.#releaseWorkers();
  }

  // --- internals -----------------------------------------------------------

  #changed() {
    // A new array of new objects each time. The candidates themselves are
    // mutated in place as steps arrive, and React would not notice a row whose
    // object it has already seen; the copies are shallow, so the trajectory
    // being collected is shared rather than copied on every step.
    this.#onChange(this.#candidates.map((candidate) => ({ ...candidate })));
  }

  #finish(candidate: Candidate, status: CandidateStatus, outcome: ScfOutcome | null = null) {
    candidate.status = status;
    candidate.outcome = outcome;
    candidate.finishedAt = this.#now();
  }

  /**
   * Gives the workers back once there is nothing left to run.
   *
   * This is where the memory goes: a worker that relaxed benzene holds its high
   * water mark until it is terminated, and nothing shrinks it.
   */
  #releaseWorkers() {
    for (const slot of this.#slots) {
      slot.candidate = null;
      slot.client.dispose();
    }
    this.#slots = [];
  }

  /** Starts waiting candidates until the workers are all busy. */
  #pump() {
    if (this.#disposed || this.#unavailable) return;
    for (;;) {
      const next = this.#candidates.find((candidate) => candidate.status === 'waiting');
      if (!next) break;
      const slot = this.#freeSlot();
      if (!slot) break;
      this.#start(slot, next);
    }
    // Nothing left to do: stop holding a few hundred megabytes of WebAssembly.
    if (!this.busy) this.#releaseWorkers();
  }

  /** A worker with nothing on it, spawning one if the pool is not full yet. */
  #freeSlot(): Slot | null {
    const idle = this.#slots.find((slot) => slot.candidate === null);
    if (idle) return idle;
    if (this.#slots.length >= this.#size) return null;
    const slot: Slot = { client: this.#createClient(), candidate: null };
    this.#slots.push(slot);
    return slot;
  }

  /** A client over a real module worker, or over whatever the tests handed in. */
  #createClient(): DftWorkerClient {
    if (!this.#spawnWorker) return new DftWorkerClient();
    if (this.#support === undefined) return new DftWorkerClient(this.#spawnWorker);
    return new DftWorkerClient(this.#spawnWorker, this.#support);
  }

  #start(slot: Slot, candidate: Candidate) {
    slot.candidate = candidate;
    candidate.status = 'running';
    candidate.startedAt = this.#now();

    slot.client
      .optimize(
        candidate.z,
        candidate.start,
        (step) => {
          // A candidate that was cancelled has already been answered for.
          if (candidate.status !== 'running') return;
          candidate.steps = step.step;
          candidate.trajectory.push(Array.from(step.xyz));
          candidate.stepEnergies.push(step.energy);
          this.#changed();
        },
        undefined,
        this.#budgetMs,
        // Never the front's level: at 'measure' three workers would hold ~750 MiB.
        SEARCH_LEVEL,
        candidate.charges,
      )
      .then((outcome) => {
        if (this.#disposed || candidate.status !== 'running') return;
        const relaxed = outcome.optimization;
        if (!outcome.converged || !relaxed || !hasUsableStructure(relaxed)) {
          // Nothing to keep and nothing to say: requirement F5 leaves this to
          // the divergence animation, which the App plays if it is opened.
          this.#finish(candidate, 'failed', outcome);
        } else {
          this.#finish(candidate, relaxed.reason === 'converged' ? 'settled' : 'partial', outcome);
          this.#onFinished?.(candidate);
        }
        slot.candidate = null;
        this.#pump();
        this.#changed();
      })
      .catch((error: Error) => {
        if (this.#disposed) return;
        if (error instanceof EngineUnavailableError) {
          this.#giveUp(error);
          return;
        }
        // A cancel replaced this worker and has already said so; the rejection
        // that follows is the one it caused.
        if (candidate.status === 'running') {
          this.#finish(candidate, 'failed');
          slot.candidate = null;
        }
        this.#pump();
        this.#changed();
      });
  }

  /** The engine will not run in this browser: nothing queued can ever start. */
  #giveUp(error: EngineUnavailableError) {
    this.#unavailable = error;
    for (const candidate of this.#candidates) {
      if (candidate.status === 'waiting' || candidate.status === 'running') {
        this.#finish(candidate, 'unavailable');
      }
    }
    this.#releaseWorkers();
    this.#changed();
  }
}

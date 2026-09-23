import { describe, expect, it, vi } from 'vitest';
import {
  CANDIDATE_BUDGET_MS,
  MAX_CONCURRENT,
  SEARCH_LEVEL,
  SearchPool,
  poolSize,
  type Candidate,
  type CandidateRequest,
} from './pool';
import type { ScfOutcome, WorkerRequest, WorkerResponse } from '../worker/protocol';

/**
 * A stand-in for the DFT worker, the same way `workerClient.test.ts` does it:
 * messages go through `structuredClone` and arrive on a later task, so the pool
 * is tested over the real {@link DftWorkerClient} and a real worker boundary,
 * with only the WebAssembly replaced.
 */
class FakeWorker {
  onmessage: ((event: MessageEvent<WorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  received: WorkerRequest[] = [];
  terminated = false;

  constructor(opening: WorkerResponse | null = { id: 0, type: 'ready' }) {
    if (opening) this.reply(opening);
  }

  postMessage(request: WorkerRequest) {
    this.received.push(structuredClone(request));
  }

  terminate() {
    this.terminated = true;
  }

  reply(...responses: WorkerResponse[]) {
    for (const response of responses) {
      const copy = structuredClone(response);
      setTimeout(() => {
        if (!this.terminated) this.onmessage?.({ data: copy } as MessageEvent<WorkerResponse>);
      }, 0);
    }
  }

  /** The optimise request this worker was given, once it has arrived. */
  async optimizeRequest(): Promise<Extract<WorkerRequest, { type: 'optimize' }>> {
    await vi.waitFor(() => expect(this.received.length).toBeGreaterThan(0));
    const request = this.received[0];
    if (request.type !== 'optimize') throw new Error(`expected optimize, got ${request.type}`);
    return request;
  }
}

function outcome(
  energy: number,
  reason: 'converged' | 'maxSteps' | 'interrupted' | 'scf',
): ScfOutcome {
  return {
    converged: reason !== 'scf',
    iterations: 7,
    multiplicity: 1,
    charge: 0,
    attempts: 1,
    energy,
    components: { core: -1, coulomb: 1, exchangeCorrelation: -1, nuclearRepulsion: 1 },
    homoLumoGap: 0.2,
    basisFunctions: 7,
    electronsOnGrid: 10,
    hasPi: false,
    elapsedMs: 1000,
    optimization: {
      converged: reason === 'converged',
      reason,
      steps: 2,
      xyz: [0, 0, 0.1, 0, 0.75, -0.47, 0, -0.75, -0.47],
      maxForce: 1e-5,
    },
  };
}

const WATER = new Float64Array([0, 0, 0.1173, 0, 0.7572, -0.4693, 0, -0.7572, -0.4693]);

function request(id: string, batch = 'batch-1'): CandidateRequest {
  return {
    id,
    batch,
    z: new Uint8Array([8, 1, 1]),
    built: WATER,
    start: WATER,
  };
}

/** A pool over fake workers, with every worker it has spawned. */
function setUp(size = 2, options: { budgetMs?: number | null } = {}) {
  const workers: FakeWorker[] = [];
  const changes: Candidate[][] = [];
  const finished: Candidate[] = [];
  let clock = 1000;
  const pool = new SearchPool({
    size,
    onChange: (candidates) => changes.push(candidates),
    onFinished: (candidate) => finished.push(candidate),
    spawnWorker: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker as unknown as Worker;
    },
    support: null,
    now: () => (clock += 10),
    ...options,
  });
  return { pool, workers, changes, finished, latest: () => changes[changes.length - 1] };
}

/** The candidate of `id` as the pool last reported it. */
const find = (candidates: Candidate[], id: string) => candidates.find((each) => each.id === id)!;

describe('how many candidates run at once', () => {
  it('leaves the front worker a core of its own', () => {
    // The machine the measurements came from: two physical cores, four reported,
    // and one candidate was all it could run without the front worker suffering
    // ("P10-1 の実測").
    expect(poolSize(4)).toBe(1);
  });

  it('does not take a browser that reports a crowd at its word', () => {
    // The lecture machine reports twelve threads, of which two are fast.
    expect(poolSize(12)).toBe(MAX_CONCURRENT);
    expect(poolSize(128)).toBe(MAX_CONCURRENT);
  });

  it('always runs at least one, however small or silent the machine', () => {
    for (const reported of [undefined, Number.NaN, 0, 1, 2, 3]) {
      expect(poolSize(reported as number | undefined)).toBe(1);
    }
  });
});

describe('the queue', () => {
  it('starts as many as it has room for and holds the rest back', async () => {
    const { pool, workers, latest } = setUp(2);
    pool.add([request('a'), request('b'), request('c')]);

    await vi.waitFor(() => expect(workers.length).toBe(2));
    const states = latest();
    expect(states.map((c) => c.status)).toEqual(['running', 'running', 'waiting']);
    // Two workers for three candidates, not one each.
    expect(workers.length).toBe(2);
  });

  it('gives a freed worker to the next candidate', async () => {
    const { pool, workers, latest } = setUp(1);
    pool.add([request('a'), request('b')]);

    await vi.waitFor(() => expect(workers.length).toBe(1));
    const first = await workers[0].optimizeRequest();
    workers[0].reply({ id: first.id, type: 'scf', result: outcome(-74.1, 'converged') });

    await vi.waitFor(() => expect(find(latest(), 'b').status).toBe('running'));
    // The same worker, reused: it already holds this molecule's memory.
    expect(workers.length).toBe(1);
    expect(workers[0].received.length).toBe(2);
  });

  it('gives the workers back once there is nothing left to run', async () => {
    const { pool, workers, latest } = setUp(1);
    pool.add([request('a')]);
    await vi.waitFor(() => expect(workers.length).toBe(1));
    const first = await workers[0].optimizeRequest();
    workers[0].reply({ id: first.id, type: 'scf', result: outcome(-74.1, 'converged') });

    // WebAssembly memory does not shrink, so an idle worker is a few hundred
    // megabytes held for nothing ("P10-1 の実測").
    await vi.waitFor(() => expect(find(latest(), 'a').status).toBe('settled'));
    expect(workers[0].terminated).toBe(true);
    expect(pool.busy).toBe(false);
  });
});

describe('what a candidate comes back as', () => {
  it('settles when the optimiser came to rest', async () => {
    const { pool, workers, latest, finished } = setUp(1);
    pool.add([request('a')]);
    await vi.waitFor(() => expect(workers.length).toBe(1));
    const sent = await workers[0].optimizeRequest();
    workers[0].reply({ id: sent.id, type: 'scf', result: outcome(-74.74, 'converged') });

    await vi.waitFor(() => expect(find(latest(), 'a').status).toBe('settled'));
    expect(finished.map((c) => c.id)).toEqual(['a']);
    expect(finished[0].outcome?.energy).toBe(-74.74);
  });

  it.each(['maxSteps', 'interrupted'] as const)(
    'keeps a structure that ran out of %s as a partial one',
    async (reason) => {
      const { pool, workers, latest, finished } = setUp(1);
      pool.add([request('a')]);
      await vi.waitFor(() => expect(workers.length).toBe(1));
      const sent = await workers[0].optimizeRequest();
      workers[0].reply({ id: sent.id, type: 'scf', result: outcome(-74.7, reason) });

      // The electrons were solved at every geometry it passed through, so the
      // structure is real - it is just not a minimum (requirement F5).
      await vi.waitFor(() => expect(find(latest(), 'a').status).toBe('partial'));
      expect(finished.map((c) => c.id)).toEqual(['a']);
    },
  );

  it('keeps nothing from a structure with no self-consistent density', async () => {
    const { pool, workers, latest, finished } = setUp(1);
    pool.add([request('a')]);
    await vi.waitFor(() => expect(workers.length).toBe(1));
    const sent = await workers[0].optimizeRequest();
    workers[0].reply({ id: sent.id, type: 'scf', result: outcome(-70, 'scf') });

    await vi.waitFor(() => expect(find(latest(), 'a').status).toBe('failed'));
    // Nothing is offered for the log: there is no shape and no number to show.
    expect(finished).toEqual([]);
  });

  it('collects the geometries as they arrive, for the replay', async () => {
    const { pool, workers, latest } = setUp(1);
    pool.add([request('a')]);
    await vi.waitFor(() => expect(workers.length).toBe(1));
    const sent = await workers[0].optimizeRequest();
    workers[0].reply(
      {
        id: sent.id,
        type: 'step',
        step: { step: 0, xyz: new Float32Array(WATER), energy: -74.1, maxForce: 0.1 },
      },
      {
        id: sent.id,
        type: 'step',
        step: { step: 1, xyz: new Float32Array(WATER), energy: -74.5, maxForce: 0.01 },
      },
    );

    await vi.waitFor(() => expect(find(latest(), 'a').trajectory.length).toBe(2));
    const candidate = find(latest(), 'a');
    expect(candidate.steps).toBe(1);
    expect(candidate.stepEnergies).toEqual([-74.1, -74.5]);
    expect(candidate.trajectory[0]).toHaveLength(WATER.length);
  });
});

describe('the budget a candidate gets', () => {
  it('goes to the worker with the request', async () => {
    const { pool, workers } = setUp(1);
    pool.add([request('a')]);
    await vi.waitFor(() => expect(workers.length).toBe(1));
    // The engine's own budget is half an hour, which is longer than a lecture:
    // this is what stops one stuck candidate holding a slot ("P10-1 の実測").
    expect((await workers[0].optimizeRequest()).budgetMs).toBe(CANDIDATE_BUDGET_MS);
  });

  it('can be turned off', async () => {
    const { pool, workers } = setUp(1, { budgetMs: null });
    pool.add([request('a')]);
    await vi.waitFor(() => expect(workers.length).toBe(1));
    expect((await workers[0].optimizeRequest()).budgetMs).toBeNull();
  });
});

describe('the level a candidate is solved at', () => {
  /** Every optimise request the workers have been given, in order. */
  const optimizeRequests = (workers: FakeWorker[]) =>
    workers.flatMap((worker) => worker.received).filter((each) => each.type === 'optimize');

  it('is always finding the shape, on every worker and for every candidate', async () => {
    const { pool, workers, latest } = setUp(1);
    pool.add([request('a'), request('b'), request('c')]);

    // `a` finishes and its worker is reused for `b`; stopping `b` replaces the
    // worker, and `c` goes to the new one. Every way a request can be sent.
    await vi.waitFor(() => expect(workers.length).toBe(1));
    const first = await workers[0].optimizeRequest();
    workers[0].reply({ id: first.id, type: 'scf', result: outcome(-74.1, 'converged') });
    await vi.waitFor(() => expect(find(latest(), 'b').status).toBe('running'));
    pool.cancel('b');
    await vi.waitFor(() => expect(find(latest(), 'c').status).toBe('running'));

    // The new worker sends once it has said it is ready.
    await vi.waitFor(() => expect(optimizeRequests(workers)).toHaveLength(3));
    const sent = optimizeRequests(workers);
    expect(workers).toHaveLength(2);
    // Written out rather than read from the constant: this is what fixes it.
    // Measuring would hold about 250 MiB a worker, and never shrink.
    for (const each of sent) expect(each.level).toBe('shape');
    expect(SEARCH_LEVEL).toBe('shape');
  });

  it('cannot be told another, whatever the calculations in front are for', async () => {
    // The front's choice lives in the App, and the pool has nowhere to take it:
    // there is no such option, and one smuggled in anyway changes nothing.
    const workers: FakeWorker[] = [];
    const pool = new SearchPool({
      size: 1,
      onChange: () => {},
      spawnWorker: () => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker as unknown as Worker;
      },
      support: null,
      // @ts-expect-error - the search takes no level.
      level: 'measure',
    });
    pool.add([request('a')]);

    await vi.waitFor(() => expect(workers.length).toBe(1));
    expect((await workers[0].optimizeRequest()).level).toBe('shape');
    pool.dispose();
  });
});

describe('stopping candidates', () => {
  it('drops one that has not started without touching the workers', async () => {
    const { pool, workers, latest } = setUp(1);
    pool.add([request('a'), request('b')]);
    await vi.waitFor(() => expect(workers.length).toBe(1));

    pool.cancel('b');
    expect(find(latest(), 'b').status).toBe('cancelled');
    expect(find(latest(), 'a').status).toBe('running');
    expect(workers[0].terminated).toBe(false);
  });

  it('replaces the worker of one that is running, and starts the next', async () => {
    const { pool, workers, latest } = setUp(1);
    pool.add([request('a'), request('b')]);
    await vi.waitFor(() => expect(workers.length).toBe(1));

    pool.cancel('a');
    expect(find(latest(), 'a').status).toBe('cancelled');
    // A single-threaded WebAssembly computation cannot be interrupted from
    // outside, so the worker goes and a fresh one takes the next candidate.
    expect(workers[0].terminated).toBe(true);
    await vi.waitFor(() => expect(find(latest(), 'b').status).toBe('running'));
  });

  it('does not report a cancelled candidate as failed when its worker answers', async () => {
    const { pool, workers, latest } = setUp(1);
    pool.add([request('a')]);
    await vi.waitFor(() => expect(workers.length).toBe(1));
    pool.cancel('a');

    // `cancelAll` rejects the pending request; that rejection is the cancel's
    // own and must not turn into a second, different answer.
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(find(latest(), 'a').status).toBe('cancelled');
  });

  it('stops everything at once and gives the workers back', async () => {
    const { pool, workers, latest } = setUp(2);
    pool.add([request('a'), request('b'), request('c')]);
    await vi.waitFor(() => expect(workers.length).toBe(2));

    pool.cancelAll();
    expect(latest().map((c) => c.status)).toEqual(['cancelled', 'cancelled', 'cancelled']);
    expect(workers.every((worker) => worker.terminated)).toBe(true);
    expect(pool.busy).toBe(false);
  });

  it('leaves finished candidates alone when it clears the list', async () => {
    const { pool, workers, latest } = setUp(1);
    pool.add([request('a'), request('b')]);
    await vi.waitFor(() => expect(workers.length).toBe(1));
    const sent = await workers[0].optimizeRequest();
    workers[0].reply({ id: sent.id, type: 'scf', result: outcome(-74.1, 'converged') });
    await vi.waitFor(() => expect(find(latest(), 'b').status).toBe('running'));

    pool.clearFinished();
    expect(latest().map((c) => c.id)).toEqual(['b']);
  });
});

describe('a browser the engine will not run in', () => {
  it('marks the candidates rather than waiting on workers that cannot answer', async () => {
    const workers: FakeWorker[] = [];
    const changes: Candidate[][] = [];
    const pool = new SearchPool({
      size: 2,
      onChange: (candidates) => changes.push(candidates),
      spawnWorker: () => {
        const worker = new FakeWorker(null);
        workers.push(worker);
        return worker as unknown as Worker;
      },
      // What `checkEngineSupport()` says on a browser without WebAssembly SIMD.
      support: 'no-simd',
    });

    pool.add([request('a'), request('b')]);
    await vi.waitFor(() => {
      const latest = changes[changes.length - 1];
      expect(latest.every((candidate) => candidate.status === 'unavailable')).toBe(true);
    });
    expect(pool.unavailable?.problem).toBe('no-simd');
    expect(pool.busy).toBe(false);
  });
});

describe('disposal', () => {
  it('stops the running candidates and releases the workers', async () => {
    const { pool, workers } = setUp(2);
    pool.add([request('a'), request('b')]);
    await vi.waitFor(() => expect(workers.length).toBe(2));

    pool.dispose();
    // Read from the pool rather than from `onChange`: disposal does not notify,
    // because the App is unmounting when it calls this.
    expect(pool.candidates.every((candidate) => candidate.status === 'cancelled')).toBe(true);
    expect(workers.every((worker) => worker.terminated)).toBe(true);

    // Nothing starts after it: the App unmounted.
    pool.add([request('c')]);
    expect(workers.length).toBe(2);
  });
});

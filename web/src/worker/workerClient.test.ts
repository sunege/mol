import { describe, expect, it, vi } from 'vitest';
import { DftWorkerClient } from './workerClient';
import { EngineUnavailableError } from './engineSupport';
import type {
  CalculationProgress,
  OptimizationStep,
  ScfOutcome,
  WorkerRequest,
  WorkerResponse,
} from './protocol';

/**
 * A stand-in for the DFT worker that answers from the test rather than from
 * WebAssembly.
 *
 * Everything crossing it goes through `structuredClone` and arrives on a later
 * task, which is what a real worker boundary does to a message - so what the
 * client sees here is what it would see in the browser, down to typed arrays
 * staying typed and replies never arriving synchronously.
 */
class FakeWorker {
  onmessage: ((event: MessageEvent<WorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  received: WorkerRequest[] = [];
  terminated = false;

  /**
   * A real worker announces itself once its WASM module is loaded - `ready`,
   * or `unavailable` if it could not be - and one that never started says
   * nothing at all.
   */
  constructor(opening: WorkerResponse | null = { id: 0, type: 'ready' }) {
    if (opening) this.reply(opening);
  }

  postMessage(request: WorkerRequest) {
    this.received.push(structuredClone(request));
  }

  terminate() {
    this.terminated = true;
  }

  /** Sends responses in order, as the worker would post them. */
  reply(...responses: WorkerResponse[]) {
    for (const response of responses) {
      const copy = structuredClone(response);
      setTimeout(() => {
        if (!this.terminated) this.onmessage?.({ data: copy } as MessageEvent<WorkerResponse>);
      }, 0);
    }
  }

  /** The worker failing outside any request, as a script that cannot load does. */
  crash(message: string) {
    setTimeout(() => {
      if (!this.terminated) this.onerror?.({ message } as ErrorEvent);
    }, 0);
  }

  /** The request the client sent `index`th, once it has arrived. */
  async request(index: number): Promise<WorkerRequest> {
    await vi.waitFor(() => expect(this.received.length).toBeGreaterThan(index));
    return this.received[index];
  }
}

/** A client over fake workers, with every worker it has spawned. */
function setUp(opening?: WorkerResponse | null) {
  const workers: FakeWorker[] = [];
  const client = new DftWorkerClient(() => {
    const worker = new FakeWorker(opening);
    workers.push(worker);
    return worker as unknown as Worker;
  }, null);
  return { client, workers };
}

const WATER = {
  z: new Uint8Array([8, 1, 1]),
  xyz: new Float64Array([0, 0, 0.1173, 0, 0.7572, -0.4693, 0, -0.7572, -0.4693]),
};

function outcome(extra: Partial<ScfOutcome> = {}): ScfOutcome {
  return {
    converged: true,
    iterations: 7,
    multiplicity: 1,
    charge: 0,
    attempts: 2,
    energy: -74.743110,
    components: { core: -122.4, coulomb: 47.4, exchangeCorrelation: -8.9, nuclearRepulsion: 9.2 },
    homoLumoGap: 0.25,
    basisFunctions: 7,
    electronsOnGrid: 9.99999,
    elapsedMs: 880,
    ...extra,
  };
}

function step(index: number): OptimizationStep {
  return {
    step: index,
    xyz: new Float32Array(WATER.xyz.map((value) => value * (1 + index / 100))),
    energy: -74.74 - index / 1000,
    maxForce: 0.05 / (index + 1),
  };
}

describe('the worker client', () => {
  it('streams an optimisation in the order the worker sent it, then resolves once', async () => {
    const { client, workers } = setUp();
    const log: string[] = [];
    const steps: OptimizationStep[] = [];
    const pending = client.optimize(
      WATER.z,
      WATER.xyz,
      (received) => {
        steps.push(received);
        log.push(`step ${received.step}`);
      },
      (progress) => log.push(label(progress)),
    );

    const request = await workers[0].request(0);
    expect(request.type).toBe('optimize');
    if (request.type !== 'optimize') throw new Error('unreachable');
    // The geometry arrives as sent: typed, and at full precision.
    expect(request.xyz).toBeInstanceOf(Float64Array);
    expect([...request.xyz]).toEqual([...WATER.xyz]);

    const { id } = request;
    workers[0].reply(
      { id, type: 'progress', progress: { stage: 'preparing' } },
      { id, type: 'progress', progress: { stage: 'searching' } },
      { id, type: 'progress', progress: { stage: 'forces', step: 0 } },
      { id, type: 'step', step: step(0) },
      { id, type: 'progress', progress: { stage: 'solving', step: 1 } },
      { id, type: 'progress', progress: { stage: 'forces', step: 1 } },
      { id, type: 'step', step: step(1) },
      {
        id,
        type: 'scf',
        result: outcome({
          optimization: {
            converged: true,
            reason: 'converged',
            steps: 1,
            xyz: [...WATER.xyz],
            maxForce: 1e-4,
          },
        }),
      },
    );

    const result = await pending;
    // Everything intermediate had arrived, in order, before the promise settled.
    expect(log).toEqual([
      'preparing',
      'searching',
      'forces 0',
      'step 0',
      'solving 1',
      'forces 1',
      'step 1',
    ]);
    expect(steps[1].xyz).toBeInstanceOf(Float32Array);
    expect(result.optimization?.reason).toBe('converged');
  });

  it('reports the progress of a single point', async () => {
    const { client, workers } = setUp();
    const heard: CalculationProgress[] = [];
    const pending = client.scf(WATER.z, WATER.xyz, (progress) => heard.push(progress));

    const { id } = await workers[0].request(0);
    workers[0].reply(
      { id, type: 'progress', progress: { stage: 'preparing' } },
      { id, type: 'progress', progress: { stage: 'searching' } },
      { id, type: 'scf', result: outcome() },
    );

    expect((await pending).energy).toBe(-74.74311);
    expect(heard).toEqual([{ stage: 'preparing' }, { stage: 'searching' }]);
  });

  it('does not settle a request on a progress report', async () => {
    const { client, workers } = setUp();
    let settled = false;
    const heard: CalculationProgress[] = [];
    const pending = client.scf(WATER.z, WATER.xyz, (progress) => heard.push(progress));
    void pending.finally(() => {
      settled = true;
    });

    const { id } = await workers[0].request(0);
    workers[0].reply({ id, type: 'progress', progress: { stage: 'searching' } });
    await vi.waitFor(() => expect(heard).toHaveLength(1));
    // Give anything that might wrongly settle it a chance to run.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);

    workers[0].reply({ id, type: 'scf', result: outcome() });
    await pending;
    expect(settled).toBe(true);
  });

  it('keeps the reports of two requests apart', async () => {
    const { client, workers } = setUp();
    const first: string[] = [];
    const second: string[] = [];
    const a = client.scf(WATER.z, WATER.xyz, (progress) => first.push(label(progress)));
    const b = client.optimize(
      WATER.z,
      WATER.xyz,
      () => {},
      (progress) => second.push(label(progress)),
    );

    const idA = (await workers[0].request(0)).id;
    const idB = (await workers[0].request(1)).id;
    expect(idA).not.toBe(idB);
    workers[0].reply(
      { id: idB, type: 'progress', progress: { stage: 'preparing' } },
      { id: idA, type: 'progress', progress: { stage: 'searching' } },
      { id: idB, type: 'progress', progress: { stage: 'forces', step: 0 } },
      { id: idA, type: 'scf', result: outcome() },
      { id: idB, type: 'scf', result: outcome() },
    );
    await Promise.all([a, b]);
    expect(first).toEqual(['searching']);
    expect(second).toEqual(['preparing', 'forces 0']);
  });

  it('sends the level a calculation is asked for, and none when it is not', async () => {
    const { client, workers } = setUp();
    const pending = [
      client.scf(WATER.z, WATER.xyz, undefined, 'measure'),
      client.optimize(WATER.z, WATER.xyz, () => {}, undefined, null, 'measure'),
      client.scf(WATER.z, WATER.xyz),
      client.optimize(WATER.z, WATER.xyz, () => {}),
    ];

    const sent: WorkerRequest[] = [];
    for (let i = 0; i < pending.length; i++) sent.push(await workers[0].request(i));
    // Left out, the worker hands the engine nothing and the engine solves at
    // 'shape' - the one place that default is spelled (`engine.test.ts` pins
    // it). The client does not fill it in, so the two cannot disagree.
    expect(sent.map((request) => ('level' in request ? request.level : 'no level'))).toEqual([
      'measure',
      'measure',
      undefined,
      undefined,
    ]);

    workers[0].reply(...sent.map(({ id }) => ({ id, type: 'scf' as const, result: outcome() })));
    await Promise.all(pending);
  });

  it('ends a request on an error, whatever it reported before', async () => {
    const { client, workers } = setUp();
    const heard: CalculationProgress[] = [];
    const pending = client.scf(WATER.z, WATER.xyz, (progress) => heard.push(progress));

    const { id } = await workers[0].request(0);
    workers[0].reply(
      { id, type: 'progress', progress: { stage: 'preparing' } },
      { id, type: 'error', message: 'CoincidentAtoms' },
    );
    await expect(pending).rejects.toThrow('CoincidentAtoms');
    expect(heard).toEqual([{ stage: 'preparing' }]);
  });

  it('cancels by replacing the worker, and hears nothing more from the old one', async () => {
    const { client, workers } = setUp();
    const heard: string[] = [];
    const pending = client.optimize(
      WATER.z,
      WATER.xyz,
      (received) => heard.push(`step ${received.step}`),
      (progress) => heard.push(label(progress)),
    );
    const { id } = await workers[0].request(0);
    workers[0].reply({ id, type: 'progress', progress: { stage: 'searching' } });
    await vi.waitFor(() => expect(heard).toEqual(['searching']));

    client.cancelAll();
    await expect(pending).rejects.toThrow('cancelled');
    expect(workers[0].terminated).toBe(true);
    expect(workers).toHaveLength(2);

    // Even if something from the old worker were still delivered, the request
    // it belongs to is gone, so none of it reaches the callbacks.
    const late: WorkerResponse[] = [
      { id, type: 'progress', progress: { stage: 'forces', step: 0 } },
      { id, type: 'step', step: step(0) },
      { id, type: 'scf', result: outcome() },
    ];
    for (const response of late) {
      workers[0].onmessage?.({ data: response } as MessageEvent<WorkerResponse>);
    }
    expect(heard).toEqual(['searching']);

    // And the new worker serves new requests under new ids.
    const next = client.scf(WATER.z, WATER.xyz);
    const request = await workers[1].request(0);
    expect(request.id).not.toBe(id);
    workers[1].reply({ id: request.id, type: 'scf', result: outcome() });
    expect((await next).converged).toBe(true);
  });
});

/**
 * A browser that cannot run the engine. Before the check, every request here
 * waited for a `ready` that never came, and the app sat silently on an empty
 * periodic table.
 */
describe('an engine that cannot start', () => {
  it('refuses at once in a browser without SIMD, without starting a worker', async () => {
    let spawned = 0;
    const client = new DftWorkerClient(() => {
      spawned += 1;
      return new FakeWorker() as unknown as Worker;
    }, 'no-simd');

    await expect(client.elements()).rejects.toBeInstanceOf(EngineUnavailableError);
    await expect(client.scf(WATER.z, WATER.xyz)).rejects.toMatchObject({ problem: 'no-simd' });
    expect(client.unavailable?.problem).toBe('no-simd');
    // Cancelling does not try again: the answer would be the same.
    client.cancelAll();
    expect(spawned).toBe(0);
  });

  it('fails what is waiting when the worker cannot load its module', async () => {
    const { client, workers } = setUp({
      id: 0,
      type: 'unavailable',
      message: 'CompileError: WebAssembly.instantiate(): invalid opcode 0xfd',
    });
    const waiting = client.elements();

    const error = await waiting.then(
      () => null,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(EngineUnavailableError);
    expect((error as EngineUnavailableError).problem).toBe('failed-to-load');
    expect((error as Error).message).toContain('invalid opcode 0xfd');
    // Nothing was ever sent to it, and it has been shut down.
    expect(workers[0].received).toHaveLength(0);
    expect(workers[0].terminated).toBe(true);
    // Later requests do not wait either.
    await expect(client.optimize(WATER.z, WATER.xyz, () => {})).rejects.toBeInstanceOf(
      EngineUnavailableError,
    );
    client.cancelAll();
    expect(workers).toHaveLength(1);
  });

  it('treats a worker that dies before it is ready the same way', async () => {
    // What a browser without module workers, or a script that fails to load,
    // looks like from here: an error, and never a word from the worker itself.
    const { client, workers } = setUp(null);
    const waiting = client.elements();
    workers[0].crash('SyntaxError: import declarations may only appear at top level');
    await expect(waiting).rejects.toMatchObject({ problem: 'failed-to-load' });
    expect(client.unavailable).not.toBeNull();
  });

  it('keeps an error after the engine has started about the requests, not the engine', async () => {
    const { client, workers } = setUp();
    const pending = client.scf(WATER.z, WATER.xyz);
    await workers[0].request(0);
    workers[0].crash('out of memory');
    await expect(pending).rejects.toThrow('out of memory');
    expect(client.unavailable).toBeNull();
  });
});

function label(progress: CalculationProgress): string {
  return 'step' in progress ? `${progress.stage} ${progress.step}` : progress.stage;
}

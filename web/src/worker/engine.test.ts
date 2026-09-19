/// <reference types="node" />
/**
 * The committed WebAssembly engine, called the way the worker calls it.
 *
 * The protocol tests check the messages; this checks what produces them. The
 * stage names are spelled twice - in `crates/dft-wasm` and in
 * `progressFromEngine` - and nothing but running the real module can tell
 * whether the two still agree. A name the protocol does not know is dropped
 * silently by design, so a mismatch would not fail anywhere else: the progress
 * card would just stop moving.
 *
 * This runs the artifact in `web/src/wasm/`, which CI checks is current with
 * the Rust source, and needs WebAssembly SIMD (Node has had it since 16.4).
 */
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { initSync, optimize, scf } from '../wasm/dft_wasm.js';
import { progressFromEngine, type CalculationProgress } from './protocol';

beforeAll(() => {
  initSync({ module: readFileSync(new URL('../wasm/dft_wasm_bg.wasm', import.meta.url)) });
});

const WATER = {
  z: new Uint8Array([8, 1, 1]),
  xyz: new Float64Array([0, 0, 0.1173, 0, 0.7572, -0.4693, 0, -0.7572, -0.4693]),
};

type Heard = { progress: CalculationProgress } | { step: number };

/** Records what the engine reports, reading each stage the way the worker does. */
function listener(heard: Heard[]) {
  return (stage: string, step: number) => {
    const progress = progressFromEngine(stage, step);
    if (progress === null) throw new Error(`the protocol does not know stage ${stage}/${step}`);
    heard.push({ progress });
  };
}

// Real calculations: about a second for water on its own, several times that
// while the other test files are competing for the same cores.
describe('the engine as the worker calls it', { timeout: 60_000 }, () => {
  it('reports a single point as preparation and then the search', () => {
    const heard: Heard[] = [];
    const calculation = scf(WATER.z, WATER.xyz, listener(heard));
    const summary = calculation.summary() as { converged: boolean };
    calculation.free();
    expect(summary.converged).toBe(true);
    expect(heard).toEqual([
      { progress: { stage: 'preparing' } },
      { progress: { stage: 'searching' } },
    ]);
  });

  it('announces every part of a relaxation before the step it leads to', () => {
    const heard: Heard[] = [];
    const calculation = optimize(
      WATER.z,
      WATER.xyz,
      (raw: { step: number }) => {
        heard.push({ step: raw.step });
        return undefined;
      },
      listener(heard),
    );
    const summary = calculation.summary() as {
      optimization: { reason: string; steps: number };
    };
    calculation.free();
    expect(summary.optimization.reason).toBe('converged');

    expect(heard.slice(0, 4)).toEqual([
      { progress: { stage: 'preparing' } },
      { progress: { stage: 'searching' } },
      { progress: { stage: 'forces', step: 0 } },
      { step: 0 },
    ]);
    const steps = heard.flatMap((entry) => ('step' in entry ? [entry.step] : []));
    expect(steps).toEqual([...Array(summary.optimization.steps + 1).keys()]);
    // Each later step was solved and then had its forces computed, in that
    // order, immediately before it went out.
    for (let i = 4; i < heard.length; i++) {
      const entry = heard[i];
      if (!('step' in entry)) continue;
      expect(heard[i - 1]).toEqual({ progress: { stage: 'forces', step: entry.step } });
      expect(heard[i - 2]).toEqual({ progress: { stage: 'solving', step: entry.step } });
    }
  });

  it('still calculates when nobody is listening', () => {
    // The listener is optional on the Rust side, so a caller that predates it
    // - or a benchmark script - gets the same answer without one.
    const calculation = scf(WATER.z, WATER.xyz);
    const summary = calculation.summary() as { converged: boolean; energy: number };
    calculation.free();
    expect(summary.converged).toBe(true);
    expect(summary.energy).toBeLessThan(-74);
  });
});

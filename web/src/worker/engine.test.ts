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
import {
  hasUsableStructure,
  progressFromEngine,
  type CalculationProgress,
  type OptimizationOutcome,
} from './protocol';
import { isFlat, perturb, PERTURB_AMPLITUDE } from '../records/perturb';

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

  it('stops where it is when the step callback throws', () => {
    // How the candidate pool gives itself a budget shorter than the engine's own
    // (`web/src/search/pool.ts`), which is a Rust constant of half an hour. The
    // engine treats a callback that threw as "there is nobody left to send steps
    // to" and ends the relaxation - and, unlike terminating the worker, hands
    // back the structure it had reached.
    let seen = -1;
    const calculation = optimize(
      WATER.z,
      WATER.xyz,
      (raw: { step: number }) => {
        seen = raw.step;
        if (raw.step >= 1) throw new Error('candidate budget');
      },
      undefined,
    );
    const summary = calculation.summary() as {
      converged: boolean;
      optimization: { reason: string; converged: boolean; steps: number; xyz: number[] };
    };
    calculation.free();

    expect(seen).toBe(1);
    // Out of time, not unsolvable: the electrons converged at every geometry it
    // passed through, so `hasUsableStructure` holds and the structure is kept.
    expect(summary.optimization.reason).toBe('interrupted');
    expect(summary.optimization.converged).toBe(false);
    expect(summary.converged).toBe(true);
    expect(hasUsableStructure(summary.optimization as OptimizationOutcome)).toBe(true);
    expect(summary.optimization.xyz).toHaveLength(WATER.z.length * 3);
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

/**
 * Ammonia with its three hydrogens in a plane through the nitrogen, which is
 * the shape a user builds by clicking without turning the camera.
 *
 * Built from the angle rather than copied from anywhere: three hydrogens evenly
 * around a circle, at a bond length near enough for the optimiser to take it
 * from there.
 */
const PLANAR_AMMONIA = {
  z: new Uint8Array([7, 1, 1, 1]),
  xyz: new Float64Array([
    0,
    0,
    0,
    ...[0, 1, 2].flatMap((i) => {
      const angle = (2 * Math.PI * i) / 3;
      return [1.05 * Math.cos(angle), 1.05 * Math.sin(angle), 0];
    }),
  ]),
};

/** How far the first atom sits off the plane through the other three, in Angstrom. */
function heightOverBase(xyz: number[] | Float64Array): number {
  const at = (i: number) => [xyz[3 * i], xyz[3 * i + 1], xyz[3 * i + 2]] as const;
  const [apex, a, b, c] = [0, 1, 2, 3].map(at);
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const normal = [
    u[1] * v[2] - u[2] * v[1],
    u[2] * v[0] - u[0] * v[2],
    u[0] * v[1] - u[1] * v[0],
  ];
  const length = Math.hypot(...normal);
  const d = [apex[0] - a[0], apex[1] - a[1], apex[2] - a[2]];
  return Math.abs(d[0] * normal[0] + d[1] * normal[1] + d[2] * normal[2]) / length;
}

function relaxed(z: Uint8Array, xyz: Float64Array) {
  const calculation = optimize(z, xyz, () => undefined);
  const summary = calculation.summary() as {
    energy: number;
    optimization: { reason: string; xyz: number[] };
  };
  calculation.free();
  return summary;
}

// Why every relaxation starts from a nudged structure (`records/perturb.ts`).
describe('a structure built in a plane', { timeout: 120_000 }, () => {
  it('stays in its plane, and leaves it once it is nudged', () => {
    // The shape the app nudges, and why it has to.
    expect(isFlat(PLANAR_AMMONIA.xyz)).toBe(true);
    const flat = relaxed(PLANAR_AMMONIA.z, PLANAR_AMMONIA.xyz);
    expect(flat.optimization.reason).toBe('converged');
    // The forces on a symmetric structure keep its symmetry, so the optimiser
    // reports a flat ammonia settled - to the last digit the plane it was
    // handed.
    expect(heightOverBase(flat.optimization.xyz)).toBeLessThan(1e-9);

    // The same structure, moved a twentieth of an Angstrom per atom.
    const nudged = relaxed(
      PLANAR_AMMONIA.z,
      perturb(PLANAR_AMMONIA.xyz, PERTURB_AMPLITUDE, 7),
    );
    expect(nudged.optimization.reason).toBe('converged');
    expect(heightOverBase(nudged.optimization.xyz)).toBeGreaterThan(0.3);
    // And it is a real minimum below the plane, not a different way of sitting
    // in it: 0.0147 Hartree lower, which is 39 kJ/mol.
    expect(nudged.energy).toBeLessThan(flat.energy - 0.01);
  });
});

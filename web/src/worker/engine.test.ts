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
 * The level names (`ModelLevel`) are spelled twice in the same way. A mismatch
 * there is loud - the engine refuses a name it does not know - but only the
 * real module can say that each name reaches the basis it is meant to. So are
 * the density channels (`DensityRequest`), where the engine also decides which
 * of them a molecule is offered at all.
 *
 * This runs the artifact in `web/src/wasm/`, which CI checks is current with
 * the Rust source, and needs WebAssembly SIMD (Node has had it since 16.4).
 */
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { initSync, optimize, scf, type Calculation } from '../wasm/dft_wasm.js';
import { PRESETS, toWorkerArrays } from '../molecules/presets';
import type { SceneAtom } from '../scene/viewer';
import {
  hasUsableStructure,
  progressFromEngine,
  raiseStop,
  stopFlag,
  stopRequested,
  type CalculationProgress,
  type ModelLevel,
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

/** A shape the panel offers, so the molecules here are the ones a user picks. */
function preset(id: string): SceneAtom[] {
  const found = PRESETS.find((each) => each.id === id);
  if (!found) throw new Error(`no preset ${id}`);
  return found.atoms;
}

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

  it('stops at the step after the page raises its flag, and keeps the calculation', () => {
    // The user's 中止 on a page that shares memory with its worker: the flag is
    // raised from outside while a step is being solved, and the worker's step
    // callback reads it afterwards the way it reads the budget
    // (`dft.worker.ts`). Here the raising happens on the same thread, from the
    // progress report that says step 1 is being solved.
    const flag = stopFlag();
    const seen: number[] = [];
    const calculation = optimize(
      WATER.z,
      WATER.xyz,
      (raw: { step: number }) => {
        seen.push(raw.step);
        if (stopRequested(flag)) throw new Error('stopped by the user');
      },
      (stage: string, step: number) => {
        if (stage === 'solving' && step === 1) raiseStop(flag);
      },
    );
    const summary = calculation.summary() as {
      converged: boolean;
      energy: number;
      optimization: { reason: string; converged: boolean; steps: number; xyz: number[] };
    };

    // Step 1 was finished and sent, and nothing after it was started.
    expect(seen).toEqual([0, 1]);
    // The reason is the budget's: to the user, both are "not finished".
    expect(summary.optimization.reason).toBe('interrupted');
    expect(summary.optimization.steps).toBe(1);
    expect(summary.converged).toBe(true);
    expect(summary.energy).toBeLessThan(-74);
    expect(hasUsableStructure(summary.optimization as OptimizationOutcome)).toBe(true);
    expect(summary.optimization.xyz).toHaveLength(WATER.z.length * 3);

    // And the calculation it ended on still has its density, which is what
    // lets the surface be drawn without solving the electrons again.
    const iso = calculation.isosurface('total', 0.05);
    const faces = iso.positiveIndices.length / 3;
    iso.free();
    calculation.free();
    expect(faces).toBeGreaterThan(0);
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
 * Basis functions water is solved with at each level, counted from the shells
 * rather than copied from anywhere.
 *
 * `shape` is STO-3G: one function per occupied atomic orbital - oxygen's 1s, 2s
 * and three 2p, and one 1s on each hydrogen. `measure` is 6-31G*: the valence
 * is split in two - oxygen's 1s, two 2s and two sets of three 2p - oxygen gets
 * six Cartesian d functions, and each hydrogen two s. The second is also `nbf`
 * in `crates/dft-core/tests/data/scf_h2o_631gs.json`.
 *
 * The count is a diagnostic in `ScfOutcome` and never reaches the screen
 * (requirement F4); here it is simply the one number that says which level
 * the engine actually solved at.
 */
const WATER_FUNCTIONS: Record<ModelLevel, number> = {
  shape: 1 + 1 + 3 + 2 * 1,
  measure: 1 + 2 + 2 * 3 + 6 + 2 * 2,
};

// The level travels from the request to the basis as one string, and this is
// the only place that string meets the engine it names.
describe('the level a calculation is asked for', { timeout: 60_000 }, () => {
  it('reaches the engine, and leaving it out is exactly the shape level', () => {
    const solve = (level?: ModelLevel) => {
      const calculation = scf(WATER.z, WATER.xyz, undefined, level);
      const summary = calculation.summary() as {
        converged: boolean;
        energy: number;
        basisFunctions: number;
      };
      calculation.free();
      expect(summary.converged).toBe(true);
      return summary;
    };
    const omitted = solve();
    const shape = solve('shape');
    const measure = solve('measure');

    expect(shape.basisFunctions).toBe(WATER_FUNCTIONS.shape);
    expect(measure.basisFunctions).toBe(WATER_FUNCTIONS.measure);
    // Not merely close: every caller that predates levels - the app until
    // levels are offered, the benchmark scripts - must get the answer it
    // always got, to the last bit.
    expect(omitted).toEqual(shape);
  });

  it('holds for every step of a relaxation, which reports as it always does', () => {
    const heard: Heard[] = [];
    const calculation = optimize(
      WATER.z,
      WATER.xyz,
      (raw: { step: number }) => {
        heard.push({ step: raw.step });
      },
      listener(heard),
      'measure',
    );
    const summary = calculation.summary() as {
      basisFunctions: number;
      optimization: { reason: string; steps: number };
    };
    calculation.free();

    expect(summary.optimization.reason).toBe('converged');
    expect(summary.optimization.steps).toBeGreaterThan(0);
    // The summary describes the last geometry, which the optimiser built
    // afresh from the one before it: the level survived every step.
    expect(summary.basisFunctions).toBe(WATER_FUNCTIONS.measure);
    // Every stage it reported is one the protocol knows (`listener` throws
    // otherwise), in the same order as at the default level.
    expect(heard.slice(0, 4)).toEqual([
      { progress: { stage: 'preparing' } },
      { progress: { stage: 'searching' } },
      { progress: { stage: 'forces', step: 0 } },
      { step: 0 },
    ]);
  });

  it('refuses a level it does not know rather than solving at the default', () => {
    // Solving in a smaller basis than was asked for would put numbers on the
    // screen that claim an accuracy they do not have, so a misspelt level is
    // an error - and one raised before any work starts or is reported.
    const heard: Heard[] = [];
    // The engine throws a string rather than an Error, which the worker posts as
    // the `error` response's message.
    for (const level of ['fast', 'Shape', '']) {
      expect(() => scf(WATER.z, WATER.xyz, listener(heard), level)).toThrow(
        'unknown model level',
      );
      expect(() => optimize(WATER.z, WATER.xyz, () => undefined, listener(heard), level)).toThrow(
        'unknown model level',
      );
    }
    expect(heard).toEqual([]);
  });
});

/**
 * The three density channels, which are spelled in `crates/dft-wasm` and in
 * `DensityRequest` and meet only here.
 *
 * Two of them name what comes back. `"bonding"` is a question, and `hasPi` is
 * how the interface knows in advance which way the engine will answer it: it
 * offers the button only where there is a pi system, so the two must agree
 * about every molecule.
 */
describe('the electrons a surface is asked for', { timeout: 120_000 }, () => {
  const solve = (atoms: SceneAtom[]) => {
    const { z, xyz } = toWorkerArrays(atoms);
    const calculation = scf(z, xyz);
    const summary = calculation.summary() as { converged: boolean; hasPi: boolean };
    expect(summary.converged).toBe(true);
    return { calculation, summary };
  };

  /** What the engine drew, and how many faces each side of it came to. */
  const cut = (calculation: Calculation, channel: string) => {
    const iso = calculation.isosurface(channel, 0.02);
    const drawn = {
      channel: iso.channel,
      positive: iso.positiveIndices.length / 3,
      negative: iso.negativeIndices.length / 3,
    };
    iso.free();
    return drawn;
  };

  it('answers a flat ring with its pi system, and its deformation density by name', () => {
    const { calculation, summary } = solve(preset('c6h6'));
    expect(summary.hasPi).toBe(true);

    // The sharper picture, which is the one the bonding button exists for.
    expect(cut(calculation, 'bonding').channel).toBe('pi');
    // And the other one, which a flat molecule could not otherwise reach: it is
    // signed, so it has a surface on each side of zero - electrons gained in
    // the bonds, electrons lost from around the atoms.
    const deformation = cut(calculation, 'deformation');
    expect(deformation.channel).toBe('deformation');
    expect(deformation.positive).toBeGreaterThan(0);
    expect(deformation.negative).toBeGreaterThan(0);
    calculation.free();
  });

  it('has no pi system to offer for a tetrahedron, and says so before it is asked', () => {
    const { calculation, summary } = solve(preset('ch4'));
    expect(summary.hasPi).toBe(false);
    // Asked anyway, it answers with the picture any molecule has - the same one
    // the deformation button asks for by name.
    expect(cut(calculation, 'bonding')).toEqual(cut(calculation, 'deformation'));
    calculation.free();
  });

  it('refuses a channel it does not know', () => {
    const { calculation } = solve(preset('h2o'));
    expect(() => calculation.isosurface('pi', 0.02)).toThrow('unknown density channel');
    calculation.free();
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

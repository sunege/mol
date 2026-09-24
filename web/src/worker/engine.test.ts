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
import {
  atomLevels,
  initSync,
  optimize,
  scan,
  scf,
  supportedElements,
  type Calculation,
} from '../wasm/dft_wasm.js';
import { PRESETS, toWorkerArrays } from '../molecules/presets';
import { findBonds } from '../scene/bonds';
import { countNodes } from '../components/orbital';
import type { SceneAtom } from '../scene/viewer';
import {
  hasUsableStructure,
  progressFromEngine,
  raiseStop,
  stopFlag,
  stopRequested,
  type CalculationProgress,
  type ElementInfo,
  type ModelLevel,
  type OptimizationOutcome,
  type OrbitalLevel,
  type ScanPoint,
  type SpinChannel,
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
 * The orbital ladder, which is the one thing about a calculation that crosses
 * as a list rather than a number.
 *
 * Everything in `OrbitalLevel` is decided at the boundary rather than in
 * `dft-core`: which orbitals share a rung, which side of the plane a rung is on
 * as a label rather than a measurement, and which rung of one spin is which rung
 * of the other. Only the real module can say that those decisions come out as
 * the contract describes, so this is where they are checked.
 */
describe('the ladder of orbital levels', { timeout: 180_000 }, () => {
  const ladder = (calculation: Calculation) => calculation.orbitals() as OrbitalLevel[];

  it('gives water one rung per orbital, five of them full and two empty', () => {
    // Ten electrons in seven STO-3G functions, none of the levels degenerate.
    const calculation = scf(WATER.z, WATER.xyz);
    const levels = ladder(calculation);

    expect(levels).toHaveLength(WATER_FUNCTIONS.shape);
    expect(levels.filter((level) => level.occupation === 2)).toHaveLength(5);
    expect(levels.filter((level) => level.occupation === 0)).toHaveLength(2);
    // A closed shell has one set of orbitals holding both spins, so there is no
    // second ladder and nothing to pair with.
    expect(levels.every((level) => level.spin === 'both')).toBe(true);
    expect(levels.every((level) => level.partner === null)).toBe(true);
    // Every rung is one orbital, and they arrive lowest first.
    expect(levels.map((level) => level.count)).toEqual(Array(levels.length).fill(1));
    expect(levels.map((level) => level.first)).toEqual([...levels.keys()]);
    expect(levels.map((level) => level.energy)).toEqual(
      [...levels.map((level) => level.energy)].sort((a, b) => a - b),
    );
    // Three atoms lie in some plane whatever they do, so sorting water's
    // orbitals by a reflection would claim a symmetry it does not have.
    expect(levels.every((level) => level.parity === null)).toBe(true);
    // And water is not two like atoms, so it has no inversion either.
    expect(levels.every((level) => level.inversion === null)).toBe(true);
    calculation.free();
  });

  it('draws one orbital with a surface of each sign, and counts its lobes', () => {
    // Water's highest occupied orbital is the oxygen lone pair: one 2p, so one
    // lobe of each sign, and the clearest thing a phase drawing can show.
    const calculation = scf(WATER.z, WATER.xyz);
    const levels = ladder(calculation);
    const homo = levels.filter((level) => level.occupation > 0).pop()!;

    const iso = calculation.isosurface('orbital', 0.05, homo.first);
    const drawn = {
      channel: iso.channel,
      positive: iso.positiveIndices.length / 3,
      negative: iso.negativeIndices.length / 3,
      lobes: { positive: iso.lobesPositive, negative: iso.lobesNegative },
    };
    iso.free();

    expect(drawn.channel).toBe('orbital');
    expect(drawn.positive).toBeGreaterThan(0);
    // The sign is what an orbital drawing is for, and a density channel would
    // have thrown it away by squaring.
    expect(drawn.negative).toBeGreaterThan(0);
    expect(drawn.lobes).toEqual({ positive: 1, negative: 1 });

    // A spin this calculation has no orbitals for, and an orbital past the end
    // of the ladder, are errors rather than a picture of something else.
    expect(() => calculation.isosurface('orbital', 0.05, homo.first, 'up')).toThrow(
      'no up orbitals',
    );
    expect(() => calculation.isosurface('orbital', 0.05, levels.length)).toThrow('is past the');
    expect(() => calculation.isosurface('orbital', 0.05)).toThrow('needs the index');
    calculation.free();
  });

  it('counts the lobes of a density channel too, at the level it was cut at', () => {
    // `lobes` is on every mesh, not only an orbital's: the same flood fill over
    // the same lattice at the same threshold.
    const calculation = scf(WATER.z, WATER.xyz);
    const lobes = (channel: string, level: number) => {
      const iso = calculation.isosurface(channel, level);
      const counted = { positive: iso.lobesPositive, negative: iso.lobesNegative };
      iso.free();
      return counted;
    };

    // A molecule is one connected region of electrons, and a density has nothing
    // below zero for a second surface to be made of.
    expect(lobes('total', 0.05)).toEqual({ positive: 1, negative: 0 });
    // The deformation density does: electrons gathered into the bonds as one
    // region, and thinned around each of the three nuclei.
    expect(lobes('deformation', 0.02)).toEqual({ positive: 1, negative: 3 });
    // Above the whole density there is nothing left to count.
    expect(lobes('total', 100)).toEqual({ positive: 0, negative: 0 });
    calculation.free();
  });

  it('says what an orbital does to each pair of nuclei, and what it is above them', () => {
    // Water's highest occupied orbital is the lone pair standing out of the
    // plane of the molecule: none of it lies between the nuclei, so it holds
    // neither O-H together and neither apart. The lowest empty one is the
    // opposite, and it has a population at all only because an empty orbital is
    // weighted as if an electron had been put in it.
    const calculation = scf(WATER.z, WATER.xyz);
    const levels = ladder(calculation);
    const occupied = levels.filter((level) => level.occupation > 0);
    const homo = occupied[occupied.length - 1];
    const lumo = levels[levels.indexOf(homo) + 1];

    const lone = calculation.orbitalCharacter(homo.first);
    // Three atoms, so `populations` is three by three; the two O-H entries are
    // the ones the interface has bonds for.
    expect(lone.populations).toHaveLength(9);
    expect(lone.populations[1]).toBeCloseTo(0, 3);
    expect(lone.populations[2]).toBeCloseTo(0, 3);
    // Symmetric, as an overlap population is: the pair is not an arrow.
    expect(lone.populations[3]).toBeCloseTo(lone.populations[1], 12);
    // Any three atoms lie in some plane, so there is none to probe above here
    // and no row of signs to count nodes along.
    expect(lone.amplitudes).toBeUndefined();
    lone.free();

    const empty = calculation.orbitalCharacter(lumo.first);
    expect(empty.populations[1]).toBeLessThan(-0.5);
    expect(empty.populations[2]).toBeCloseTo(empty.populations[1], 12);
    empty.free();

    // The same refusals as an orbital surface: an index past the end of the
    // ladder, and a spin this calculation has no orbitals for.
    expect(() => calculation.orbitalCharacter(levels.length)).toThrow('is past the');
    expect(() => calculation.orbitalCharacter(0, 'up')).toThrow('no up orbitals');
    calculation.free();
  });

  it('gives both halves of benzene’s highest occupied pair one node', () => {
    // The decisive case for the count (`components/orbital.ts`). The two
    // orbitals of a degenerate pair are an arbitrary rotation of it, and these
    // two do not even look alike - one has a lobe on every carbon, the other
    // has nothing on two of them - but they are one rung of the ladder and the
    // molecule has one answer, so the count has to agree across them.
    const { z, xyz } = toWorkerArrays(preset('c6h6'));
    const calculation = scf(z, xyz);
    const levels = ladder(calculation);
    const occupied = levels.filter((level) => level.occupation > 0);
    const homo = occupied[occupied.length - 1];
    expect(homo.count).toBe(2);

    // The bonds are the interface's own guess from the geometry, which is what
    // the words are read along; the engine has never seen them.
    const table = supportedElements() as ElementInfo[];
    const bonds = findBonds(preset('c6h6'), (element) => {
      const found = table.find((each) => each.z === element);
      if (!found) throw new Error(`no element ${element}`);
      return found.covalentRadius;
    });

    for (let member = 0; member < homo.count; member++) {
      const character = calculation.orbitalCharacter(homo.first + member);
      // One probe per atom, hydrogens included.
      expect(character.amplitudes).toHaveLength(12);
      expect(countNodes(character.amplitudes ?? null, bonds)).toBe(1);
      character.free();
    }
    calculation.free();
  });

  it('keeps a degenerate pair on one rung, which is benzene’s highest occupied', () => {
    // Two orbitals at the same energy are not two things the molecule has: what
    // the diagonalisation returns inside the pair is an arbitrary rotation of
    // it, so the pair is the smallest thing worth showing.
    const { z, xyz } = toWorkerArrays(preset('c6h6'));
    const calculation = scf(z, xyz);
    const levels = ladder(calculation);
    const occupied = levels.filter((level) => level.occupation > 0);
    const homo = occupied[occupied.length - 1];

    expect(homo.count).toBe(2);
    // And the empty rung above it, which is the pair that would break the ring.
    expect(levels[levels.indexOf(homo) + 1].count).toBe(2);
    // Twelve atoms in a plane, so here the reflection really does sort them: the
    // pi orbitals are the ones it turns inside out.
    expect(homo.parity).toBe(-1);
    expect(levels.some((level) => level.parity === 1)).toBe(true);
    // Every rung accounts for its orbitals exactly once.
    expect(levels.reduce((sum, level) => sum + level.count, 0)).toBe(
      (calculation.summary() as { basisFunctions: number }).basisFunctions,
    );
    calculation.free();
  });

  it('keeps oxygen’s two spins apart, and says which rung of one is which of the other', () => {
    // What makes O2 a triplet: nine electrons with their spins one way and seven
    // the other, so two orbitals are occupied in one ladder and empty in the
    // matching rung of the other. Folding the two together would lose it - and
    // so would pairing them up by index, because they do not come in the same
    // order.
    const { z, xyz } = toWorkerArrays(preset('o2'));
    const calculation = scf(z, xyz);
    const levels = ladder(calculation);

    const spins = [...new Set(levels.map((level) => level.spin))];
    expect(spins).toEqual(['up', 'down']);
    const electrons = (spin: SpinChannel) =>
      levels
        .filter((level) => level.spin === spin && level.occupation > 0)
        .reduce((sum, level) => sum + level.count * level.occupation, 0);
    expect(electrons('up')).toBe(9);
    expect(electrons('down')).toBe(7);
    // One spin at a time, each orbital holding at most one electron.
    expect(levels.every((level) => level.occupation === 1 || level.occupation === 0)).toBe(true);
    // A diatomic has no plane it is not in, so no rung is labelled by one: the
    // sigma and pi of O2 are told apart by their degeneracy instead.
    expect(levels.every((level) => level.parity === null)).toBe(true);
    // What it does have is an inversion, which sorts every rung (V4-10): the
    // unpaired electrons' pi* pair is gerade - antibonding, for a pi - in both
    // spins, and the empty sigma* at the top of each ladder is ungerade.
    expect(levels.every((level) => level.inversion !== null)).toBe(true);
    for (const spin of ['up', 'down'] as const) {
      const own = levels.filter((level) => level.spin === spin);
      const piStar = own.filter((level) => level.count === 2).at(-1)!;
      expect(piStar.inversion).toBe(1);
      expect(own.at(-1)!.inversion).toBe(-1);
    }

    // Every rung names one of the other spin, and the naming agrees both ways.
    for (const [index, level] of levels.entries()) {
      expect(level.partner).not.toBeNull();
      const partner = levels[level.partner!];
      expect(partner.spin).not.toBe(level.spin);
      expect(partner.partner).toBe(index);
    }
    // Not the identity: the orbitals of the two spins come out in a different
    // order, which is the whole reason `partner` exists.
    expect(levels.map((level) => level.partner)).not.toEqual([...levels.keys()]);

    // And the two spins' orbitals really are different orbitals, so asking for
    // one index in each ladder must not answer with the same surface.
    const up = calculation.isosurface('orbital', 0.05, 4, 'up');
    const down = calculation.isosurface('orbital', 0.05, 4, 'down');
    const differ = up.positiveIndices.length !== down.positiveIndices.length;
    up.free();
    down.free();
    expect(differ).toBe(true);
    // Omitting the spin on a calculation that solved the two separately is an
    // error rather than a guess at which was meant.
    expect(() => calculation.isosurface('orbital', 0.05, 4)).toThrow('no both orbitals');
    calculation.free();
  });
});

/**
 * The distance scan, which is the only request that is a calculation per
 * answer rather than one calculation read several ways.
 *
 * What the real module has to show here is the thing the figure is for: two
 * atoms far apart have two levels at the same height, and bringing them
 * together splits those into a bonding and an antibonding one. The numbers it
 * is checked against are in `docs/v4/V4-7.md`, measured before any of this was
 * written.
 */
describe('a distance scan', { timeout: 180_000 }, () => {
  /** Collects the points, optionally throwing out of the callback part way. */
  const walk = (z: Uint8Array, from: number, to: number, points: number, stopAfter = Infinity) => {
    const collected: ScanPoint[] = [];
    scan(z, from, to, points, (point: ScanPoint) => {
      collected.push(point);
      if (collected.length >= stopAfter) throw new Error('enough');
    });
    return collected;
  };

  it('walks hydrogen out to three Angstrom and closes the gap as it goes', () => {
    const points = walk(new Uint8Array([1, 1]), 0.4, 3.0, 27);
    expect(points).toHaveLength(27);
    expect(points.every((point) => point.converged)).toBe(true);
    // Angstrom on this side of the boundary, as every length is. Only to about
    // a ten-billionth of one: the two conversion constants are separately
    // rounded CODATA values, so a round trip through Bohr does not land on the
    // same double it left from.
    expect(points[0].distance).toBeCloseTo(0.4, 8);
    expect(points[26].distance).toBeCloseTo(3.0, 8);

    // Two orbitals in the smallest basis, neither degenerate, and both in the
    // single set of orbitals a closed shell is solved as: no sign anywhere of
    // the triplet a stretched hydrogen would otherwise fall into.
    for (const point of points) {
      expect(point.levels).toHaveLength(2);
      expect(point.levels.map((level) => level.count)).toEqual([1, 1]);
      expect(point.levels.map((level) => level.spin)).toEqual([0, 0]);
      expect(point.levels.map((level) => level.occupation)).toEqual([2, 0]);
    }

    // Bonding and antibonding, by symmetry and by the electrons between the
    // nuclei, and a missing inversion would be `null` rather than `undefined`.
    for (const point of points) {
      expect(point.levels.map((level) => level.inversion)).toEqual([1, -1]);
      expect(point.levels[0].overlap).toBeGreaterThan(0);
      expect(point.levels[1].overlap).toBeLessThan(0);
    }
    const unlike = walk(new Uint8Array([1, 9]), 0.9, 1.0, 2);
    expect(unlike.every((point) => point.levels.every((level) => level.inversion === null))).toBe(
      true,
    );

    // The measured gaps are 1.34 Hartree at 0.4 Angstrom and 0.019 at 3.0.
    const gap = (point: ScanPoint) => point.levels[1].energy - point.levels[0].energy;
    expect(gap(points[0])).toBeGreaterThan(1.3);
    expect(gap(points[26])).toBeLessThan(0.03);
  });

  it('stops where the callback throws, keeping the points already sent', () => {
    // How the worker gives a scan a budget, the same way it gives a relaxation
    // one: the engine takes a callback that threw as "there is nobody left to
    // send points to" and ends the scan, and what already crossed stands.
    expect(walk(new Uint8Array([1, 1]), 0.4, 3.0, 27, 3)).toHaveLength(3);
  });

  it('refuses anything but two atoms, and an element it does not have', () => {
    expect(() => scan(new Uint8Array([1]), 0.4, 3.0, 5, () => undefined)).toThrow('two atoms');
    expect(() => scan(new Uint8Array([1, 30]), 0.4, 3.0, 5, () => undefined)).toThrow(
      'unsupported element',
    );
  });

  it('gives each element the levels of the free atom, one per orbital', () => {
    const levels = atomLevels(new Uint8Array([1, 8])) as number[][];
    expect(levels).toHaveLength(2);
    // STO-3G, so one function on hydrogen and five on oxygen: 1s, 2s and three
    // 2p. Counted from the shells, as `WATER_FUNCTIONS` is.
    expect(levels[0]).toHaveLength(1);
    expect(levels[1]).toHaveLength(1 + 1 + 3);
    // Lowest first, and oxygen's three 2p levels are one level: a free atom is
    // solved with its shells spread evenly, so it has no direction to prefer.
    expect([...levels[1]]).toEqual([...levels[1]].sort((a, b) => a - b));
    expect(levels[1][3]).toBeCloseTo(levels[1][2], 10);
    expect(levels[1][4]).toBeCloseTo(levels[1][2], 10);
    expect(() => atomLevels(new Uint8Array([30]))).toThrow('unsupported element');
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

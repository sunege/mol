import { describe, expect, it } from 'vitest';
import { PRESETS, toWorkerArrays } from '../molecules/presets';
import { hasUsableStructure, isTerminal, progressFromEngine } from './protocol';
import type {
  CalculationProgress,
  DensityRequest,
  IsoMesh,
  OptimizationOutcome,
  OptimizationReason,
  ScfOutcome,
  WorkerRequest,
  WorkerResponse,
} from './protocol';

/**
 * Messages cross the worker boundary through the structured clone algorithm, so
 * anything the protocol carries has to survive it. Typed arrays are the part
 * that could silently degrade - a plain array would still "work" but would make
 * every geometry a copy of numbers rather than a buffer.
 */
const emptySurface = () => ({
  positions: new Float32Array(0),
  normals: new Float32Array(0),
  indices: new Uint32Array(0),
});

describe('worker protocol', () => {
  it('keeps geometry as typed arrays through a structured clone', () => {
    const water = PRESETS.find((p) => p.id === 'h2o')!;
    const { z, xyz } = toWorkerArrays(water.atoms);
    const request: WorkerRequest = { id: 7, type: 'scf', z, xyz };

    const cloned = structuredClone(request);
    expect(cloned.type).toBe('scf');
    if (cloned.type !== 'scf') throw new Error('unreachable');
    expect(cloned.id).toBe(7);
    expect(cloned.z).toBeInstanceOf(Uint8Array);
    expect(cloned.xyz).toBeInstanceOf(Float64Array);
    expect([...cloned.z]).toEqual([8, 1, 1]);
    expect(cloned.xyz.length).toBe(9);
    // Coordinates must survive at full double precision: the engine works in
    // Bohr and a single-precision round trip would move the nuclei.
    expect(cloned.xyz[2]).toBe(water.atoms[0].pos[2]);
  });

  it('round-trips a converged result', () => {
    const outcome: ScfOutcome = {
      converged: true,
      iterations: 8,
      multiplicity: 1,
      charge: 0,
      attempts: 2,
      energy: -74.73205936,
      components: {
        core: -122.39740918,
        coulomb: 47.35230686,
        exchangeCorrelation: -8.87592562,
        nuclearRepulsion: 9.18896857,
      },
      homoLumoGap: 0.2515,
      basisFunctions: 7,
      electronsOnGrid: 9.999991,
      hasPi: false,
      elapsedMs: 312.5,
    };
    const response: WorkerResponse = { id: 3, type: 'scf', result: outcome };
    const cloned = structuredClone(response);
    expect(cloned).toEqual(response);
    if (cloned.type !== 'scf') throw new Error('unreachable');
    // The terms must still add up to the total after the trip.
    const { core, coulomb, exchangeCorrelation, nuclearRepulsion } = cloned.result.components;
    expect(core + coulomb + exchangeCorrelation + nuclearRepulsion).toBeCloseTo(
      cloned.result.energy,
      7,
    );
  });

  it('keeps a mesh in the layout a vertex buffer wants', () => {
    // One triangle, which is enough to pin the element types down. Anything but
    // a Float32Array here would mean a copy on every upload to the GPU, and
    // anything but a Uint32Array would cap a surface at 65536 vertices - well
    // under what benzene needs at a low threshold.
    const mesh: IsoMesh = {
      channel: 'total',
      isoLevel: 0.05,
      positive: {
        positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
        normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
        indices: new Uint32Array([0, 1, 2]),
      },
      negative: emptySurface(),
      densityMax: 27.54,
      densityMin: 0,
      lobes: { positive: 1, negative: 0 },
      elapsedMs: 3.5,
    };
    const cloned = structuredClone({ id: 9, type: 'mesh', mesh } as WorkerResponse);
    if (cloned.type !== 'mesh') throw new Error('unreachable');
    expect(cloned.mesh.positive.positions).toBeInstanceOf(Float32Array);
    expect(cloned.mesh.positive.normals).toBeInstanceOf(Float32Array);
    expect(cloned.mesh.positive.indices).toBeInstanceOf(Uint32Array);
    expect([...cloned.mesh.positive.indices]).toEqual([0, 1, 2]);
    expect(cloned.mesh.isoLevel).toBe(0.05);
    // An unsigned channel leaves the second surface empty rather than absent,
    // so the viewer has one shape to handle rather than two.
    expect(cloned.mesh.negative.indices.length).toBe(0);
  });

  it('carries both halves of a signed density', () => {
    // Only the deformation density has a negative side, and losing it would
    // silently turn "electrons left here" into nothing at all.
    const mesh: IsoMesh = {
      channel: 'deformation',
      isoLevel: 0.02,
      positive: {
        positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
        normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
        indices: new Uint32Array([0, 1, 2]),
      },
      negative: {
        positions: new Float32Array([0, 0, 2, 1, 0, 2, 0, 1, 2]),
        normals: new Float32Array([0, 0, -1, 0, 0, -1, 0, 0, -1]),
        indices: new Uint32Array([0, 2, 1]),
      },
      densityMax: 0.31,
      densityMin: -0.25,
      lobes: { positive: 1, negative: 1 },
      elapsedMs: 6,
    };
    const cloned = structuredClone({ id: 11, type: 'mesh', mesh } as WorkerResponse);
    if (cloned.type !== 'mesh') throw new Error('unreachable');
    expect(cloned.mesh.channel).toBe('deformation');
    expect(cloned.mesh.densityMin).toBeLessThan(0);
    expect([...cloned.mesh.negative.indices]).toEqual([0, 2, 1]);
    expect(cloned.mesh.negative.positions[2]).toBe(2);
  });

  it('treats a threshold above the whole density as an empty mesh, not an error', () => {
    const mesh: IsoMesh = {
      channel: 'total',
      isoLevel: 0.5,
      positive: emptySurface(),
      negative: emptySurface(),
      densityMax: 0.27,
      densityMin: 0,
      lobes: { positive: 0, negative: 0 },
      elapsedMs: 1,
    };
    const cloned = structuredClone({ id: 10, type: 'mesh', mesh } as WorkerResponse);
    if (cloned.type !== 'mesh') throw new Error('unreachable');
    expect(cloned.mesh.positive.indices.length).toBe(0);
    expect(cloned.mesh.isoLevel).toBeGreaterThan(cloned.mesh.densityMax);
  });

  it('asks for a channel and a threshold without resending the geometry', () => {
    // The point of keeping the density in the worker: a threshold change is a
    // number, not a molecule. One of the three densities is a request rather
    // than an answer - only the engine knows whether this molecule has a pi
    // system - and the other two name what comes back.
    for (const channel of ['total', 'bonding', 'deformation'] as DensityRequest[]) {
      const request: WorkerRequest = { id: 8, type: 'isosurface', channel, isoLevel: 0.02 };
      expect(structuredClone(request)).toEqual(request);
    }
    // One orbital travels the same way, with two more numbers: which orbital,
    // and whose ladder the index counts along.
    const orbital: WorkerRequest = {
      id: 9,
      type: 'isosurface',
      channel: 'orbital',
      isoLevel: 0.03,
      orbital: 4,
      spin: 'up',
    };
    expect(structuredClone(orbital)).toEqual(orbital);
  });

  it('reports a failed geometry as an error response, not a thrown value', () => {
    const response: WorkerResponse = { id: 4, type: 'error', message: 'CoincidentAtoms' };
    expect(structuredClone(response)).toEqual(response);
  });

  it('reports non-convergence as an ordinary result', () => {
    // Requirement F5: the engine never throws for a molecule it cannot converge.
    const response: WorkerResponse = {
      id: 5,
      type: 'scf',
      result: {
        converged: false,
        iterations: 100,
        multiplicity: 1,
        charge: 0,
        attempts: 6,
        energy: -1.5,
        components: { core: -3, coulomb: 1, exchangeCorrelation: -0.5, nuclearRepulsion: 1 },
        homoLumoGap: null,
        basisFunctions: 2,
        electronsOnGrid: 2,
        hasPi: false,
        elapsedMs: 10,
      },
    };
    const cloned = structuredClone(response);
    if (cloned.type !== 'scf') throw new Error('unreachable');
    expect(cloned.result.converged).toBe(false);
    expect(cloned.result.homoLumoGap).toBeNull();
    // Every state the driver had was tried before it gave up, which is what
    // makes this a real answer rather than an early exit.
    expect(cloned.result.attempts).toBeGreaterThan(1);
  });

  it('carries the spin state the engine chose for itself', () => {
    // Requirement F4 keeps this off the screen, but it has to cross the worker
    // boundary: phase 5 holds the state fixed while the geometry moves, and
    // there is otherwise no way to confirm that O2 was solved as a triplet.
    const response: WorkerResponse = {
      id: 6,
      type: 'scf',
      result: {
        converged: true,
        iterations: 7,
        multiplicity: 3,
        charge: 0,
        attempts: 2,
        energy: -147.194,
        components: {
          core: -260.293,
          coulomb: 101.117,
          exchangeCorrelation: -16.054,
          nuclearRepulsion: 28.036,
        },
        homoLumoGap: 0.08,
        basisFunctions: 10,
        electronsOnGrid: 16.0,
        hasPi: false,
        elapsedMs: 250,
      },
    };
    const cloned = structuredClone(response);
    if (cloned.type !== 'scf') throw new Error('unreachable');
    expect(cloned.result.multiplicity).toBe(3);
    expect(cloned.result.charge).toBe(0);
  });
});

/**
 * A geometry optimisation is the one request that answers more than once. The
 * client keeps it pending until a terminal response arrives, so which responses
 * count as terminal is part of the contract rather than an implementation
 * detail.
 */
describe('streaming a geometry optimisation', () => {
  it('treats a step as intermediate and everything else as final', () => {
    const step: WorkerResponse = {
      id: 4,
      type: 'step',
      step: { step: 2, xyz: new Float32Array([0, 0, 0]), energy: -74.7, maxForce: 0.03 },
    };
    expect(isTerminal(step)).toBe(false);

    const finals: WorkerResponse[] = [
      { id: 4, type: 'scf', result: convergedOutcome() },
      { id: 4, type: 'error', message: 'nope' },
      { id: 4, type: 'elements', elements: [] },
      { id: 4, type: 'orbitals', levels: [] },
    ];
    for (const response of finals) expect(isTerminal(response)).toBe(true);
  });

  it('carries a step as a transferable frame the player can use directly', () => {
    const xyz = new Float32Array([0, 0, 0.117, 0, 0.757, -0.469, 0, -0.757, -0.469]);
    const response: WorkerResponse = {
      id: 9,
      type: 'step',
      step: { step: 5, xyz, energy: -74.7318, maxForce: 0.0412 },
    };
    const cloned = structuredClone(response);
    if (cloned.type !== 'step') throw new Error('unreachable');
    // Float32Array is what FramePlayer takes, so no conversion happens on the
    // UI thread between arrival and display.
    expect(cloned.step.xyz).toBeInstanceOf(Float32Array);
    expect(cloned.step.xyz.length).toBe(9);
    expect(cloned.step.step).toBe(5);
  });

  it('separates "no bound electrons" from "the computer was too slow"', () => {
    // The whole of the interface's decision. Only a failed SCF means the nuclei
    // cannot hold electrons where they are, and only that is shown as the
    // molecule coming apart; the other two are facts about the clock, and the
    // structure they end on is a real, partly relaxed one to keep.
    const ended = (reason: OptimizationReason): OptimizationOutcome => ({
      converged: reason === 'converged',
      reason,
      steps: 3,
      xyz: [0, 0, 0],
      maxForce: 0.004,
    });
    expect(hasUsableStructure(ended('converged'))).toBe(true);
    expect(hasUsableStructure(ended('interrupted'))).toBe(true);
    expect(hasUsableStructure(ended('maxSteps'))).toBe(true);
    expect(hasUsableStructure(ended('scf'))).toBe(false);
  });

  it('reports a structure that would not settle as an ordinary result', () => {
    // Requirement F5 again, now for the geometry rather than the electrons:
    // running out of steps is a value with a reason attached, not an error.
    const outcome: ScfOutcome = {
      ...convergedOutcome(),
      optimization: {
        converged: false,
        reason: 'maxSteps',
        steps: 100,
        // Real coordinates even so: the electrons were solved at every geometry
        // on the way, so this is a structure, just not a settled one.
        xyz: [0, 0, 0.121, 0, 0.771, -0.487, 0, -0.769, -0.489],
        maxForce: 0.0071,
      },
    };
    const response: WorkerResponse = { id: 11, type: 'scf', result: outcome };
    const cloned = structuredClone(response);
    if (cloned.type !== 'scf') throw new Error('unreachable');
    expect(cloned.result.optimization?.converged).toBe(false);
    expect(cloned.result.optimization?.reason).toBe('maxSteps');
    // The electrons were fine; it is the structure that did not settle, and the
    // two are reported separately so the interface can tell them apart.
    expect(cloned.result.converged).toBe(true);
    expect(hasUsableStructure(cloned.result.optimization!)).toBe(true);
  });

  it('hands back the relaxed geometry in Angstrom, atom for atom', () => {
    const outcome: ScfOutcome = {
      ...convergedOutcome(),
      optimization: {
        converged: true,
        reason: 'converged',
        steps: 11,
        xyz: [0, 0, 0.1246, 0, 0.7761, -0.4946, 0, -0.7761, -0.4946],
        maxForce: 1.2e-4,
      },
    };
    const cloned = structuredClone(outcome);
    expect(cloned.optimization?.xyz.length).toBe(9);
    // Three coordinates per atom, so the UI can zip it against the elements it
    // already has without being told the atom count again.
    expect((cloned.optimization?.xyz.length ?? 0) % 3).toBe(0);
    expect(cloned.optimization?.converged).toBe(true);
  });
});

/**
 * Progress is the second kind of intermediate answer, and both calculations
 * send it. Getting it wrong in either direction is visible: treated as terminal,
 * it would resolve a calculation with a progress report in place of its result;
 * dropped, the screen stands still for the seconds it exists to fill.
 */
describe('progress reports', () => {
  const reports: CalculationProgress[] = [
    { stage: 'preparing' },
    { stage: 'searching' },
    { stage: 'forces', step: 0 },
    { stage: 'solving', step: 1 },
  ];

  it('is intermediate, like a step', () => {
    for (const progress of reports) {
      expect(isTerminal({ id: 3, type: 'progress', progress })).toBe(false);
    }
  });

  it('survives the worker boundary as it was sent', () => {
    for (const progress of reports) {
      const response: WorkerResponse = { id: 12, type: 'progress', progress };
      expect(structuredClone(response)).toEqual(response);
    }
  });

  it('reads the names the engine uses', () => {
    expect(progressFromEngine('preparing', 0)).toEqual({ stage: 'preparing' });
    expect(progressFromEngine('searching', 0)).toEqual({ stage: 'searching' });
    expect(progressFromEngine('forces', 0)).toEqual({ stage: 'forces', step: 0 });
    expect(progressFromEngine('solving', 7)).toEqual({ stage: 'solving', step: 7 });
  });

  it('drops what it does not understand rather than guess', () => {
    expect(progressFromEngine('triplet', 0)).toBeNull();
    expect(progressFromEngine('', 0)).toBeNull();
    expect(progressFromEngine('solving', -1)).toBeNull();
    expect(progressFromEngine('forces', 1.5)).toBeNull();
    expect(progressFromEngine('forces', Number.NaN)).toBeNull();
  });

  it('carries no spin state, charge or attempt count', () => {
    // Requirement F4 at the boundary: the only fields a report has are the
    // stage and, for the optimiser's two stages, which geometry it is on.
    for (const progress of reports) {
      for (const key of Object.keys(progress)) expect(['stage', 'step']).toContain(key);
    }
  });
});

/** A plausible converged single point, for the cases above to build on. */
function convergedOutcome(): ScfOutcome {
  return {
    converged: true,
    iterations: 8,
    multiplicity: 1,
    charge: 0,
    attempts: 2,
    energy: -74.73205936,
    components: {
      core: -122.39740918,
      coulomb: 47.35230686,
      exchangeCorrelation: -8.87592562,
      nuclearRepulsion: 9.18896857,
    },
    homoLumoGap: 0.2515,
    basisFunctions: 7,
    electronsOnGrid: 9.999991,
    // Water: three atoms lie in a plane whatever they do, so there is no pi
    // system to be had.
    hasPi: false,
    elapsedMs: 312.5,
  };
}

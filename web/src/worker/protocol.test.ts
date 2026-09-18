import { describe, expect, it } from 'vitest';
import { PRESETS, toWorkerArrays } from '../molecules/presets';
import type { IsoMesh, ScfOutcome, WorkerRequest, WorkerResponse } from './protocol';

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
      elapsedMs: 1,
    };
    const cloned = structuredClone({ id: 10, type: 'mesh', mesh } as WorkerResponse);
    if (cloned.type !== 'mesh') throw new Error('unreachable');
    expect(cloned.mesh.positive.indices.length).toBe(0);
    expect(cloned.mesh.isoLevel).toBeGreaterThan(cloned.mesh.densityMax);
  });

  it('asks for a channel and a threshold without resending the geometry', () => {
    // The point of keeping the density in the worker: a threshold change is a
    // number, not a molecule. The channel is a request rather than an answer -
    // only the engine knows whether this molecule has a pi system.
    const request: WorkerRequest = { id: 8, type: 'isosurface', channel: 'bonding', isoLevel: 0.02 };
    expect(structuredClone(request)).toEqual(request);
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
        elapsedMs: 250,
      },
    };
    const cloned = structuredClone(response);
    if (cloned.type !== 'scf') throw new Error('unreachable');
    expect(cloned.result.multiplicity).toBe(3);
    expect(cloned.result.charge).toBe(0);
  });
});

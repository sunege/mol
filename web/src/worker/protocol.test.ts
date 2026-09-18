import { describe, expect, it } from 'vitest';
import { PRESETS, toWorkerArrays } from '../molecules/presets';
import type { ScfOutcome, WorkerRequest, WorkerResponse } from './protocol';

/**
 * Messages cross the worker boundary through the structured clone algorithm, so
 * anything the protocol carries has to survive it. Typed arrays are the part
 * that could silently degrade - a plain array would still "work" but would make
 * every geometry a copy of numbers rather than a buffer.
 */
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
  });
});

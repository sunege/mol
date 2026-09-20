/**
 * Records to test the log with, built rather than copied.
 *
 * Only a few fields carry meaning for what the log does - the energy, how the
 * optimisation ended, the atoms, when it was saved. The rest is filled in so
 * that a record is a whole one, because the file reader checks that it is.
 */
import type { OptimizationReason, ScfOutcome } from '../worker/protocol';
import { createRecord, type StructureRecord } from './record';

/** The engine's element symbols, for the few elements the tests use. */
export const SYMBOLS = new Map([
  [1, 'H'],
  [6, 'C'],
  [7, 'N'],
  [8, 'O'],
]);

export const symbolOf = (z: number): string => SYMBOLS.get(z) ?? `#${z}`;

export const isSupportedElement = (z: number): boolean => SYMBOLS.has(z);

export interface FakeRelaxation {
  /** Water unless a test is about the formula or the comparison key. */
  z?: number[];
  energy: number;
  /** How the optimiser stopped; it settled unless the test says otherwise. */
  reason?: OptimizationReason;
  /** The charge the engine had to choose, which splits comparable sets. */
  charge?: number;
  savedAt?: string;
  id?: string;
}

export function fakeOutcome(relaxation: FakeRelaxation, xyz: number[]): ScfOutcome {
  const reason = relaxation.reason ?? 'converged';
  return {
    converged: true,
    iterations: 7,
    multiplicity: 1,
    charge: relaxation.charge ?? 0,
    attempts: 1,
    energy: relaxation.energy,
    components: { core: -1, coulomb: 1, exchangeCorrelation: -1, nuclearRepulsion: 1 },
    homoLumoGap: 0.2,
    basisFunctions: 7,
    electronsOnGrid: 10,
    elapsedMs: 1000,
    optimization: {
      converged: reason === 'converged',
      reason,
      steps: 3,
      xyz,
      maxForce: 1e-5,
    },
  };
}

/** A record of a relaxation that never happened. */
export function fakeRecord(relaxation: FakeRelaxation): StructureRecord {
  const z = relaxation.z ?? [8, 1, 1];
  const xyz = Array.from({ length: z.length * 3 }, (_, i) => i * 0.1);
  return createRecord(
    {
      z,
      built: xyz,
      trajectory: [xyz, xyz],
      stepEnergies: [relaxation.energy + 0.01, relaxation.energy],
      outcome: fakeOutcome(relaxation, xyz),
    },
    symbolOf,
    new Date(relaxation.savedAt ?? '2026-09-20T09:00:00.000Z'),
    relaxation.id ?? `id-${relaxation.energy}-${relaxation.reason ?? 'converged'}`,
  );
}

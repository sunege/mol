import { describe, expect, it } from 'vitest';
import {
  MINIMUM_SEPARATION_FRACTION,
  SEARCH_AMPLITUDE,
  candidateAsBuilt,
  drawApart,
  nudgedCandidates,
  overlaps,
  type CandidateSource,
} from './candidates';
import { PERTURB_AMPLITUDE } from '../records/perturb';

/** The engine's radii for the elements these tests use. */
const RADII = new Map([
  [1, 0.31],
  [6, 0.76],
  [8, 0.66],
]);
const covalentRadius = (z: number) => RADII.get(z) ?? 0.8;

/** Tetrahedral methane, as the preset places it. */
const METHANE: { z: Uint8Array; xyz: Float64Array } = {
  z: new Uint8Array([6, 1, 1, 1, 1]),
  xyz: new Float64Array([
    0, 0, 0, 0.6276, 0.6276, 0.6276, -0.6276, -0.6276, 0.6276, -0.6276, 0.6276, -0.6276, 0.6276,
    -0.6276, -0.6276,
  ]),
};

function source(overrides: Partial<CandidateSource> = {}): CandidateSource {
  let next = 0;
  return {
    z: METHANE.z,
    xyz: METHANE.xyz,
    covalentRadius,
    batch: 'batch-1',
    id: () => `id-${next++}`,
    ...overrides,
  };
}

/** The closest two atoms of a structure, in Angstrom. */
function closest(xyz: Float64Array): number {
  let best = Infinity;
  const count = Math.floor(xyz.length / 3);
  for (let i = 0; i < count; i++) {
    for (let j = i + 1; j < count; j++) {
      best = Math.min(
        best,
        Math.hypot(
          xyz[3 * i] - xyz[3 * j],
          xyz[3 * i + 1] - xyz[3 * j + 1],
          xyz[3 * i + 2] - xyz[3 * j + 2],
        ),
      );
    }
  }
  return best;
}

/** How far each atom moved between two structures. */
function shifts(from: Float64Array, to: Float64Array): number[] {
  const out: number[] = [];
  for (let i = 0; i + 2 < from.length; i += 3) {
    out.push(Math.hypot(to[i] - from[i], to[i + 1] - from[i + 1], to[i + 2] - from[i + 2]));
  }
  return out;
}

describe('the amplitude a candidate is nudged by', () => {
  it('is bigger than the one a single relaxation gets, and not by a little', () => {
    // They are different jobs: PERTURB_AMPLITUDE is the smallest tremble that
    // breaks an exact symmetry, this is a visibly different starting point.
    expect(SEARCH_AMPLITUDE).toBeGreaterThan(PERTURB_AMPLITUDE * 2);
  });

  it('stays inside the range where the results still mean something', () => {
    // Past about 0.3 A candidates began settling on stationary points hundreds
    // of kJ/mol above the minimum ("P10-1 の実測").
    expect(SEARCH_AMPLITUDE).toBeLessThanOrEqual(0.3);
  });

  it('is a fraction of a bond rather than an edit to the molecule', () => {
    const drawn = drawApart({ ...METHANE, covalentRadius }, SEARCH_AMPLITUDE, 1);
    for (const moved of shifts(METHANE.xyz, drawn)) {
      expect(moved).toBeCloseTo(SEARCH_AMPLITUDE, 12);
    }
  });
});

describe('the structure as it is', () => {
  it('is submitted unchanged', () => {
    const candidate = candidateAsBuilt(source());
    // No nudge: the question is what *this* shape relaxes to.
    expect(candidate.start).toBe(candidate.built);
    expect(Array.from(candidate.start)).toEqual(Array.from(METHANE.xyz));
    expect(candidate.batch).toBe('batch-1');
  });
});

describe('a set of nudged candidates', () => {
  it('makes as many as asked, each from a different draw', () => {
    const candidates = nudgedCandidates(source(), 4, 12345);
    expect(candidates).toHaveLength(4);
    expect(candidates.map((candidate) => candidate.id)).toEqual(['id-0', 'id-1', 'id-2', 'id-3']);

    const starts = candidates.map((candidate) => Array.from(candidate.start).join(','));
    expect(new Set(starts).size).toBe(4);
  });

  it('keeps the structure they came from, for the record to compare against', () => {
    for (const candidate of nudgedCandidates(source(), 3, 7)) {
      expect(Array.from(candidate.built)).toEqual(Array.from(METHANE.xyz));
      expect(candidate.batch).toBe('batch-1');
    }
  });

  it('gives the same set for the same seed and a different one otherwise', () => {
    const asText = (seed: number) =>
      nudgedCandidates(source(), 3, seed)
        .map((candidate) => Array.from(candidate.start).join(','))
        .join('|');
    expect(asText(99)).toBe(asText(99));
    expect(asText(99)).not.toBe(asText(100));
  });

  it('makes nothing from a count of nothing', () => {
    expect(nudgedCandidates(source(), 0, 1)).toEqual([]);
    expect(nudgedCandidates(source(), -3, 1)).toEqual([]);
  });

  it('leaves the structure it was given alone', () => {
    const before = Array.from(METHANE.xyz);
    nudgedCandidates(source(), 5, 3);
    expect(Array.from(METHANE.xyz)).toEqual(before);
  });
});

describe('the overlap check', () => {
  it('measures against the elements rather than one distance for all', () => {
    // Two hydrogens bond at 0.74 A and two carbons at 1.5, so "too close"
    // cannot be a single number.
    const hydrogens = { z: new Uint8Array([1, 1]), covalentRadius };
    const carbons = { z: new Uint8Array([6, 6]), covalentRadius };
    const apart = (d: number) => new Float64Array([0, 0, 0, d, 0, 0]);

    expect(overlaps(hydrogens, apart(0.5))).toBe(false);
    expect(overlaps(carbons, apart(0.5))).toBe(true);
  });

  it('draws the line below any real bond', () => {
    const methane = { z: METHANE.z, covalentRadius };
    // A C-H bond is 1.09 A; the limit is 0.6 x (0.76 + 0.31).
    const limit = (0.76 + 0.31) * MINIMUM_SEPARATION_FRACTION;
    expect(limit).toBeLessThan(1.0);
    expect(overlaps(methane, METHANE.xyz)).toBe(false);
  });

  it('sees a pair wherever it is in the structure', () => {
    const crowded = new Float64Array(METHANE.xyz);
    // Put the last hydrogen on top of the third.
    crowded[12] = crowded[9];
    crowded[13] = crowded[10];
    crowded[14] = crowded[11];
    expect(overlaps({ z: METHANE.z, covalentRadius }, crowded)).toBe(true);
  });

  it('says nothing about a structure with one atom or none', () => {
    expect(overlaps({ z: new Uint8Array([6]), covalentRadius }, new Float64Array([0, 0, 0]))).toBe(
      false,
    );
    expect(overlaps({ z: new Uint8Array([]), covalentRadius }, new Float64Array([]))).toBe(false);
  });
});

describe('drawing a candidate that is still a molecule', () => {
  it('draws again when the first one put two atoms inside each other', () => {
    // A methane squeezed until its bonds are 0.75 A - still a molecule by the
    // check, but with only a tenth of an Angstrom to spare, so a nudge of this
    // size often takes a pair under the line.
    const squeezed = new Float64Array(Array.from(METHANE.xyz, (value) => value * 0.69));
    const crowded = { z: METHANE.z, xyz: squeezed, covalentRadius };
    expect(overlaps(crowded, squeezed)).toBe(false);

    const seeds = Array.from({ length: 40 }, (_, i) => i + 1);
    // The same draws with the check switched off, so the numbers are comparable.
    const firstDraws = seeds.filter((seed) =>
      overlaps(crowded, drawApart({ ...crowded, covalentRadius: () => 0 }, SEARCH_AMPLITUDE, seed)),
    ).length;
    const kept = seeds.filter((seed) =>
      overlaps(crowded, drawApart(crowded, SEARCH_AMPLITUDE, seed)),
    ).length;

    expect(firstDraws).toBeGreaterThan(5);
    expect(kept).toBe(0);
  });

  it('still produces a structure when every draw is crowded', () => {
    // A structure built with the atoms already on top of each other: refusing
    // to start would be a worse answer than relaxing what is on screen.
    const stacked = new Float64Array([0, 0, 0, 0.1, 0, 0, 0, 0.1, 0, 0, 0, 0.1, 0.1, 0.1, 0]);
    const drawn = drawApart({ z: METHANE.z, xyz: stacked, covalentRadius }, SEARCH_AMPLITUDE, 5);
    expect(drawn).toHaveLength(stacked.length);
    expect(Number.isFinite(closest(drawn))).toBe(true);
  });
});

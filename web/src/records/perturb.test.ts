import { describe, expect, it } from 'vitest';
import {
  isFlat,
  needsNudge,
  perturb,
  randomSeed,
  FLATNESS_TOLERANCE,
  PERTURB_AMPLITUDE,
} from './perturb';

const AMPLITUDE = 0.05;

/** How far each atom moved, which the nudge fixes and only the direction varies. */
function displacements(before: Float64Array, after: Float64Array) {
  const out: [number, number, number][] = [];
  for (let i = 0; i + 2 < before.length; i += 3) {
    out.push([after[i] - before[i], after[i + 1] - before[i + 1], after[i + 2] - before[i + 2]]);
  }
  return out;
}

const WATER = new Float64Array([0, 0, 0.1173, 0, 0.7572, -0.4693, 0, -0.7572, -0.4693]);

describe('the nudge', () => {
  it('moves every atom exactly the amplitude', () => {
    for (const seed of [1, 7, 12345, 0]) {
      for (const d of displacements(WATER, perturb(WATER, AMPLITUDE, seed))) {
        expect(Math.hypot(...d)).toBeCloseTo(AMPLITUDE, 12);
      }
    }
  });

  it('gives the same structure for the same seed and a different one otherwise', () => {
    expect(Array.from(perturb(WATER, AMPLITUDE, 4))).toEqual(
      Array.from(perturb(WATER, AMPLITUDE, 4)),
    );
    expect(Array.from(perturb(WATER, AMPLITUDE, 4))).not.toEqual(
      Array.from(perturb(WATER, AMPLITUDE, 5)),
    );
  });

  it('moves the atoms of one structure in different directions', () => {
    // A nudge that moved them all the same way would be a translation, and
    // would leave every symmetry it is meant to break exactly where it was.
    const [a, b, c] = displacements(WATER, perturb(WATER, AMPLITUDE, 9));
    expect(a).not.toEqual(b);
    expect(b).not.toEqual(c);
  });

  it('leaves the structure it was given alone', () => {
    const before = Array.from(WATER);
    perturb(WATER, AMPLITUDE, 3);
    expect(Array.from(WATER)).toEqual(before);
  });

  it('takes a structure out of its plane', () => {
    // The whole point: a molecule built by clicking is exactly planar (all the
    // z here), and after the nudge no atom is still in that plane.
    const planar = new Float64Array([0, 0, 0, 1.1, 0, 0, 0, 1.1, 0, -1.1, 0, 0, 0, -1.1, 0]);
    for (let seed = 0; seed < 50; seed++) {
      const moved = perturb(planar, AMPLITUDE, seed);
      const out = Math.max(...displacements(planar, moved).map((d) => Math.abs(d[2])));
      expect(out).toBeGreaterThan(0);
    }
  });

  it('handles a structure with no atoms', () => {
    expect(Array.from(perturb(new Float64Array(0), AMPLITUDE, 1))).toEqual([]);
  });
});

describe('the directions', () => {
  const N = 3000;
  const origin = new Float64Array(3 * N);
  const directions = displacements(origin, perturb(origin, 1, 2024)).map(
    (d) => d as [number, number, number],
  );

  it('are spread over the whole sphere rather than a part of it', () => {
    const mean = directions
      .reduce((sum, d) => [sum[0] + d[0], sum[1] + d[1], sum[2] + d[2]], [0, 0, 0])
      .map((v) => v / N);
    // A biased set of directions would leave a long mean vector; an even one
    // leaves about 1/sqrt(N) of a unit vector, which is 0.018 here.
    expect(Math.hypot(...mean)).toBeLessThan(0.1);

    const octants = new Map<string, number>();
    for (const d of directions) {
      const key = d.map((v) => (v >= 0 ? '+' : '-')).join('');
      octants.set(key, (octants.get(key) ?? 0) + 1);
    }
    expect(octants.size).toBe(8);
    for (const count of octants.values()) expect(count / N).toBeGreaterThan(0.08);
  });

  it('are even over the sphere, not over the polar angle', () => {
    // The difference between drawing the height uniformly and drawing the angle
    // uniformly: the second piles the directions up at the poles. Half of an
    // even sphere lies in the band |z| < 1/2.
    const band = directions.filter((d) => Math.abs(d[2]) < 0.5).length / N;
    expect(band).toBeGreaterThan(0.45);
    expect(band).toBeLessThan(0.55);
  });
});

describe('the seed a relaxation takes', () => {
  it('is a whole number that differs from press to press', () => {
    const seeds = new Set(Array.from({ length: 20 }, randomSeed));
    expect(seeds.size).toBeGreaterThan(15);
    for (const seed of seeds) expect(Number.isInteger(seed)).toBe(true);
  });
});

describe('the amplitude', () => {
  it('is a fraction of a bond, not an edit to the structure', () => {
    expect(PERTURB_AMPLITUDE).toBeGreaterThan(0);
    expect(PERTURB_AMPLITUDE).toBeLessThan(0.1);
  });
});

/** `count` points evenly around a circle of radius `r` in the z = 0 plane. */
function ring(count: number, r: number, heights: number[] = []): number[] {
  return Array.from({ length: count }, (_, i) => {
    const angle = (2 * Math.PI * i) / count;
    return [r * Math.cos(angle), r * Math.sin(angle), heights[i] ?? 0];
  }).flat();
}

/**
 * Turns a structure, so that a test cannot pass by accident on a plane that
 * happens to be a coordinate plane. Rodrigues about an axis nothing lines up
 * with.
 */
function turned(xyz: number[]): Float64Array {
  const axis = [1, 2, 3].map((v) => v / Math.hypot(1, 2, 3));
  const angle = 0.7;
  const [c, s] = [Math.cos(angle), Math.sin(angle)];
  const out = new Float64Array(xyz.length);
  for (let i = 0; i + 2 < xyz.length; i += 3) {
    const v = [xyz[i], xyz[i + 1], xyz[i + 2]];
    const d = axis[0] * v[0] + axis[1] * v[1] + axis[2] * v[2];
    const cr = [
      axis[1] * v[2] - axis[2] * v[1],
      axis[2] * v[0] - axis[0] * v[2],
      axis[0] * v[1] - axis[1] * v[0],
    ];
    for (let k = 0; k < 3; k++) out[i + k] = v[k] * c + cr[k] * s + axis[k] * d * (1 - c);
  }
  return out;
}

describe('recognising the structures a click builds', () => {
  // A methane built by clicking: the carbon and all four hydrogens on the plane
  // the pointer crossed.
  const FLAT_METHANE = [0, 0, 0, ...ring(4, 1.1)];
  const TETRAHEDRAL_METHANE = [
    0, 0, 0, 0.63, 0.63, 0.63, -0.63, -0.63, 0.63, -0.63, 0.63, -0.63, 0.63, -0.63, -0.63,
  ];

  it('sees the plane whichever way the structure is turned', () => {
    expect(isFlat(new Float64Array(FLAT_METHANE))).toBe(true);
    expect(isFlat(turned(FLAT_METHANE))).toBe(true);
  });

  it('does not see one in a structure with depth', () => {
    expect(isFlat(new Float64Array(TETRAHEDRAL_METHANE))).toBe(false);
    expect(isFlat(turned(TETRAHEDRAL_METHANE))).toBe(false);
  });

  it('needs four atoms before a plane means anything', () => {
    // Any three atoms lie in a plane, so nothing is hidden by one.
    expect(isFlat(new Float64Array([0, 0, 0, 1, 0, 0, 0.3, 0.9, 0]))).toBe(false);
    expect(isFlat(WATER)).toBe(false);
    expect(isFlat(new Float64Array([0, 0, 0, 0, 0, 1.1]))).toBe(false);
    expect(isFlat(new Float64Array(0))).toBe(false);
  });

  it('does not call a straight line a plane', () => {
    // Four atoms in a row lie in every plane through the line, and none of them
    // is a symmetry to be nudged out of.
    const line = [0, 0, 0, 1.2, 0, 0, 2.4, 0, 0, 3.6, 0, 0];
    expect(isFlat(new Float64Array(line))).toBe(false);
    expect(isFlat(turned(line))).toBe(false);
  });

  it('allows a structure that is nearly flat, and no more', () => {
    // Where the optimiser could stop before the force out of the plane shows.
    const nearly = ring(6, 1.39, [0, FLATNESS_TOLERANCE * 0.9, 0, 0, 0, 0]);
    expect(isFlat(new Float64Array(nearly))).toBe(true);
    const clearly = ring(6, 1.39, [0, FLATNESS_TOLERANCE * 2, 0, 0, 0, 0]);
    expect(isFlat(new Float64Array(clearly))).toBe(false);
  });

  it('sees the plane of a ring with atoms hung off it', () => {
    // Benzene as the preset builds it, which is flat and really is.
    const benzene = new Float64Array([...ring(6, 1.39), ...ring(6, 1.39 + 1.09)]);
    expect(isFlat(benzene)).toBe(true);
  });
});

describe('deciding whether to nudge at all', () => {
  const FLAT_BENZENE = new Float64Array([...ring(6, 1.39), ...ring(6, 1.39 + 1.09)]);
  const TETRAHEDRAL_METHANE = new Float64Array([
    0, 0, 0, 0.63, 0.63, 0.63, -0.63, -0.63, 0.63, -0.63, 0.63, -0.63, 0.63, -0.63, -0.63,
  ]);

  it('nudges a flat structure the user built', () => {
    expect(needsNudge(FLAT_BENZENE, true)).toBe(true);
  });

  it('leaves a structure the app supplied alone, flat or not', () => {
    // A preset, one opened from the log, and above all the shape a relaxation
    // has just found: nudging that one would walk the optimiser back down a
    // valley it is already at the bottom of, which is what makes measuring a
    // found shape twice as long as it needs to be.
    expect(needsNudge(FLAT_BENZENE, false)).toBe(false);
    expect(needsNudge(TETRAHEDRAL_METHANE, false)).toBe(false);
  });

  it('leaves a structure with depth alone even when the user built it', () => {
    expect(needsNudge(TETRAHEDRAL_METHANE, true)).toBe(false);
  });
});

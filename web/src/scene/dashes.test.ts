import { describe, expect, it } from 'vitest';
import { dashLayout } from './dashes';

describe('dashLayout', () => {
  it('fits as many whole dashes as the segment holds, spaced by the gap', () => {
    const { length, centers } = dashLayout(1.5, 0.14, 0.1);
    expect(length).toBe(0.14);
    // n dashes and n - 1 gaps must fit, and one more dash must not.
    const n = centers.length;
    expect(n * 0.14 + (n - 1) * 0.1).toBeLessThanOrEqual(1.5);
    expect((n + 1) * 0.14 + n * 0.1).toBeGreaterThan(1.5);
    for (let k = 1; k < n; k++) expect(centers[k] - centers[k - 1]).toBeCloseTo(0.24, 12);
  });

  it('centres the pattern, keeping every dash inside the segment', () => {
    for (const span of [0.3, 0.96, 1.09, 1.54, 2.8, 7.3]) {
      const { length, centers } = dashLayout(span, 0.14, 0.1);
      const startGap = centers[0] - length / 2;
      const endGap = span - (centers.at(-1)! + length / 2);
      expect(startGap).toBeGreaterThanOrEqual(0);
      expect(endGap).toBeGreaterThanOrEqual(-1e-12);
      expect(startGap).toBeCloseTo(endGap, 12);
    }
  });

  it('joins atoms closer than one dash with a single dash the whole way', () => {
    expect(dashLayout(0.05, 0.14, 0.1)).toEqual({ length: 0.05, centers: [0.025] });
  });

  it('draws nothing between coincident points', () => {
    expect(dashLayout(0, 0.14, 0.1)).toEqual({ length: 0, centers: [] });
    expect(dashLayout(Number.NaN, 0.14, 0.1)).toEqual({ length: 0, centers: [] });
  });
});

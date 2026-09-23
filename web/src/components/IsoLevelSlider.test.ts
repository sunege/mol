import { describe, expect, it } from 'vitest';
import { ISO_RANGES, ISO_STEPS, levelAt, positionOf, type IsoRange } from './IsoLevelSlider';

const RANGES: [string, IsoRange][] = Object.entries(ISO_RANGES);

describe('isosurface threshold scale', () => {
  it.each(RANGES)('spans the whole %s range end to end', (_name, range) => {
    expect(levelAt(0, range)).toBeCloseTo(range.min, 12);
    expect(levelAt(ISO_STEPS, range)).toBeCloseTo(range.max, 12);
  });

  it.each(RANGES)('round-trips a %s level through its slider position', (_name, range) => {
    for (const fraction of [0, 0.15, 0.4, 0.73, 1]) {
      const level = levelAt(Math.round(fraction * ISO_STEPS), range);
      // One step of rounding is allowed; the slider only has so many stops.
      expect(levelAt(positionOf(level, range), range)).toBeCloseTo(level, 6);
    }
  });

  it.each(RANGES)('starts inside the %s range it offers', (_name, range) => {
    expect(range.initial).toBeGreaterThan(range.min);
    expect(range.initial).toBeLessThan(range.max);
  });

  it.each(RANGES)('is logarithmic over %s, so every step is the same factor', (_name, range) => {
    const ratio = levelAt(1, range) / levelAt(0, range);
    for (const position of [40, 100, 199]) {
      expect(levelAt(position + 1, range) / levelAt(position, range)).toBeCloseTo(ratio, 10);
    }
    // And that factor really does cover the range.
    expect(Math.pow(ratio, ISO_STEPS)).toBeCloseTo(range.max / range.min, 6);
  });

  it.each(RANGES)('clamps rather than extrapolating past either end of %s', (_name, range) => {
    expect(levelAt(-50, range)).toBeCloseTo(range.min, 12);
    expect(levelAt(ISO_STEPS + 50, range)).toBeCloseTo(range.max, 12);
    expect(positionOf(1e-9, range)).toBe(0);
    expect(positionOf(1000, range)).toBe(ISO_STEPS);
  });

  it.each(RANGES)('moves monotonically over %s', (_name, range) => {
    let previous = 0;
    for (let position = 0; position <= ISO_STEPS; position++) {
      const level = levelAt(position, range);
      expect(level).toBeGreaterThan(previous);
      previous = level;
    }
  });

  it('gives the bonding channels a finer range than the total density', () => {
    // A pi density peaks near 0.19 and a deformation density lower still, so a
    // slider that ran to the total density's top end would be dead over most of
    // its travel.
    for (const channel of ['bonding', 'deformation'] as const) {
      expect(ISO_RANGES[channel].max).toBeLessThan(ISO_RANGES.total.max);
      expect(ISO_RANGES[channel].initial).toBeLessThan(ISO_RANGES.total.initial);
    }
    // And the two are the same range, because a bonding request is answered
    // with one of these two densities.
    expect(ISO_RANGES.deformation).toEqual(ISO_RANGES.bonding);
  });
});

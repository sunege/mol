import { describe, expect, it } from 'vitest';
import { HARTREE_TO_KJ_PER_MOL, UNITS_SOURCE, kilojoulesPerMole } from './units';

describe('the energy unit', () => {
  it('comes from the generated table, not from memory', () => {
    // The value itself is not repeated here - that would be the same mistake as
    // typing it into the source. What a test can say is where it came from and
    // that it is the size a chemical energy has: a mole of Hartrees is a few
    // thousand kJ, far above a bond (hundreds) and far below nothing at all.
    expect(UNITS_SOURCE).toContain('scipy.constants');
    expect(HARTREE_TO_KJ_PER_MOL).toBeGreaterThan(1e3);
    expect(HARTREE_TO_KJ_PER_MOL).toBeLessThan(1e4);
  });

  it('converts a difference, keeping its sign', () => {
    expect(kilojoulesPerMole(0)).toBe(0);
    expect(kilojoulesPerMole(1)).toBe(HARTREE_TO_KJ_PER_MOL);
    expect(kilojoulesPerMole(-2)).toBe(-2 * HARTREE_TO_KJ_PER_MOL);
    // The inversion barrier of ammonia, as this engine finds it: tens of
    // kJ/mol, which is the range the log has to tell apart.
    expect(kilojoulesPerMole(0.014743)).toBeGreaterThan(30);
    expect(kilojoulesPerMole(0.014743)).toBeLessThan(50);
  });
});

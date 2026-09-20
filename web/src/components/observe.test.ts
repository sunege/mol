import { describe, expect, it } from 'vitest';
import { atomPath, pickingHint, readout, undefinedReason } from './observe';

describe('readout', () => {
  it('shows the value alone when there is nothing to compare with', () => {
    expect(readout({ kind: 'distance', value: 1.5123 }, null)).toBe('1.512 Å');
    expect(readout({ kind: 'angle', value: 104.52 }, null)).toBe('104.5°');
    expect(readout(null, null)).toBe('—');
    expect(readout(null, { kind: 'distance', value: 1.54 })).toBe('—');
  });

  it('shows before and after with the unit once', () => {
    expect(
      readout({ kind: 'distance', value: 1.5123 }, { kind: 'distance', value: 1.54 }),
    ).toBe('1.540 → 1.512 Å');
    expect(readout({ kind: 'angle', value: 109.47 }, { kind: 'angle', value: 90 })).toBe(
      '90.0 → 109.5°',
    );
  });

  it('writes an undefined side as a dash, each side with its own unit', () => {
    expect(readout({ kind: 'dihedral', value: 12.34 }, { kind: 'dihedral', value: null })).toBe(
      '— → 12.3°',
    );
    expect(readout({ kind: 'dihedral', value: null }, { kind: 'dihedral', value: 60 })).toBe(
      '60.0° → —',
    );
  });

  it('ignores a before value of another kind', () => {
    // Picking a third atom turns a distance into an angle; the old distance
    // says nothing about it.
    expect(readout({ kind: 'angle', value: 104.5 }, { kind: 'distance', value: 0.96 })).toBe(
      '104.5°',
    );
  });
});

describe('panel wording', () => {
  it('joins the picked atoms in order', () => {
    expect(atomPath(['H', 'C', 'H'])).toBe('H–C–H');
    expect(atomPath([])).toBe('');
  });

  it('says what the next click will do, for every count', () => {
    const hints = [0, 1, 2, 3, 4].map(pickingHint);
    expect(new Set(hints).size).toBe(5);
    expect(hints[2]).toContain('頂点');
    expect(hints[3]).toContain('二面角');
  });

  it('explains a dash, and only a dash', () => {
    expect(undefinedReason({ kind: 'dihedral', value: null })).toContain('一直線');
    expect(undefinedReason({ kind: 'dihedral', value: 30 })).toBeNull();
    expect(undefinedReason(null)).toBeNull();
  });
});

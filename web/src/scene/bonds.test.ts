import { describe, expect, it } from 'vitest';
import { findBonds } from './bonds';
import { PRESETS } from '../molecules/presets';

/** Covalent radii in Angstrom for the elements used here (Cordero 2008). */
const RADII: Record<number, number> = { 1: 0.31, 6: 0.76, 7: 0.71, 8: 0.66 };
const radiusOf = (z: number) => RADII[z] ?? 0.8;

describe('findBonds', () => {
  it('bonds both O-H pairs in water but not the two hydrogens', () => {
    const water = PRESETS.find((p) => p.id === 'h2o')!;
    const bonds = findBonds(water.atoms, radiusOf);
    expect(bonds).toEqual([
      [0, 1],
      [0, 2],
    ]);
  });

  it('gives benzene six C-C and six C-H bonds', () => {
    const benzene = PRESETS.find((p) => p.id === 'c6h6')!;
    const bonds = findBonds(benzene.atoms, radiusOf);
    const kinds = bonds.map(([i, j]) => [benzene.atoms[i].z, benzene.atoms[j].z].sort().join('-'));
    expect(kinds.filter((k) => k === '6-6')).toHaveLength(6);
    expect(kinds.filter((k) => k === '1-6')).toHaveLength(6);
    expect(bonds).toHaveLength(12);
  });

  it('gives methane four C-H bonds and no H-H bonds', () => {
    const methane = PRESETS.find((p) => p.id === 'ch4')!;
    const bonds = findBonds(methane.atoms, radiusOf);
    expect(bonds).toHaveLength(4);
    expect(bonds.every(([i]) => i === 0)).toBe(true);
  });

  it('drops a bond once the atoms are pulled apart', () => {
    const near: Parameters<typeof findBonds>[0] = [
      { z: 8, pos: [0, 0, 0] },
      { z: 1, pos: [0, 0, 0.96] },
    ];
    expect(findBonds(near, radiusOf)).toHaveLength(1);
    near[1].pos = [0, 0, 3.0];
    expect(findBonds(near, radiusOf)).toHaveLength(0);
  });

  it('returns nothing for zero or one atom', () => {
    expect(findBonds([], radiusOf)).toEqual([]);
    expect(findBonds([{ z: 6, pos: [0, 0, 0] }], radiusOf)).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import { PRESETS, toWorkerArrays } from './presets';

describe('toWorkerArrays', () => {
  it('flattens atoms into parallel typed arrays', () => {
    const { z, xyz } = toWorkerArrays([
      { z: 8, pos: [0, 0, 0.1173] },
      { z: 1, pos: [0, 0.7572, -0.4693] },
    ]);
    expect(Array.from(z)).toEqual([8, 1]);
    expect(Array.from(xyz)).toEqual([0, 0, 0.1173, 0, 0.7572, -0.4693]);
  });

  it('always sends a charge per atom, zero where none was put', () => {
    const { charges } = toWorkerArrays([
      { z: 8, pos: [0, 0, 0] },
      { z: 1, pos: [0, 0.76, -0.47], charge: 1 },
      { z: 1, pos: [0, -0.76, -0.47], charge: 0 },
      { z: 17, pos: [2, 0, 0], charge: -1 },
    ]);
    expect(charges).toBeInstanceOf(Int8Array);
    expect(Array.from(charges)).toEqual([0, 1, 0, -1]);
    for (const preset of PRESETS) {
      expect(Array.from(toWorkerArrays(preset.atoms).charges)).toEqual(
        preset.atoms.map(() => 0),
      );
    }
  });

  it('produces a coordinate array three times the atom count', () => {
    for (const preset of PRESETS) {
      const { z, xyz } = toWorkerArrays(preset.atoms);
      expect(z.length).toBe(preset.atoms.length);
      expect(xyz.length).toBe(preset.atoms.length * 3);
    }
  });
});

describe('presets', () => {
  it('only use elements the engine supports (H-Ar)', () => {
    for (const preset of PRESETS) {
      for (const atom of preset.atoms) {
        expect(atom.z).toBeGreaterThanOrEqual(1);
        expect(atom.z).toBeLessThanOrEqual(18);
      }
    }
  });

  it('never place two nuclei on top of each other', () => {
    for (const preset of PRESETS) {
      for (let i = 0; i < preset.atoms.length; i++) {
        for (let j = i + 1; j < preset.atoms.length; j++) {
          const a = preset.atoms[i].pos;
          const b = preset.atoms[j].pos;
          expect(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])).toBeGreaterThan(0.5);
        }
      }
    }
  });

  it('benzene has the expected composition', () => {
    const benzene = PRESETS.find((p) => p.id === 'c6h6')!;
    expect(benzene.atoms.filter((a) => a.z === 6)).toHaveLength(6);
    expect(benzene.atoms.filter((a) => a.z === 1)).toHaveLength(6);
  });
});

import { describe, expect, it } from 'vitest';
import { atomsFromFlat, withPositions } from './atoms';
import { toWorkerArrays } from './presets';
import type { SceneAtom } from '../scene/viewer';

/** H3O+ with the charge on one hydrogen, as a user would make it. */
const hydronium: SceneAtom[] = [
  { z: 8, pos: [0, 0, 0] },
  { z: 1, pos: [0.95, 0, 0] },
  { z: 1, pos: [-0.48, 0.82, 0] },
  { z: 1, pos: [-0.48, -0.82, 0], charge: 1 },
];

describe('withPositions', () => {
  it('moves the atoms and keeps their elements and charges', () => {
    const xyz = [0, 0, 0.1, 1, 0, 0, -0.5, 0.9, 0, -0.5, -0.9, 0];
    const moved = withPositions(hydronium, xyz);
    expect(moved.map((a) => a.z)).toEqual([8, 1, 1, 1]);
    expect(moved.map((a) => a.charge ?? 0)).toEqual([0, 0, 0, 1]);
    expect(moved[3].pos).toEqual([-0.5, -0.9, 0]);
    expect(moved[0].pos).toEqual([0, 0, 0.1]);
  });

  it('leaves a neutral atom without a charge field, as it was before v7', () => {
    expect(withPositions([{ z: 1, pos: [0, 0, 0] }], [1, 2, 3])).toEqual([
      { z: 1, pos: [1, 2, 3] },
    ]);
  });

  it('does not touch the atoms it was given', () => {
    const before = JSON.stringify(hydronium);
    withPositions(hydronium, new Float64Array(12));
    expect(JSON.stringify(hydronium)).toBe(before);
  });
});

describe('atomsFromFlat', () => {
  it('reads every atom as neutral when there are no charges', () => {
    expect(atomsFromFlat([8, 1], [0, 0, 0, 1, 0, 0])).toEqual([
      { z: 8, pos: [0, 0, 0] },
      { z: 1, pos: [1, 0, 0] },
    ]);
  });

  it('is the inverse of the arrays sent to the worker, charges included', () => {
    const { z, xyz, charges } = toWorkerArrays(hydronium);
    expect(atomsFromFlat(z, xyz, charges)).toEqual(hydronium);
  });
});

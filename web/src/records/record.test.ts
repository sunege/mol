import { describe, expect, it } from 'vitest';
import {
  comparisonKey,
  createRecord,
  defaultRecordName,
  hillFormula,
  isSettled,
  ENGINE_MODEL,
  TRAJECTORY_DECIMALS,
} from './record';
import { fakeOutcome, fakeRecord, symbolOf } from './fixtures';

describe('the formula a group is called by', () => {
  it('puts carbon first, then hydrogen, then the rest alphabetically', () => {
    // Ethanol and dimethyl ether: different molecules, one formula, which is
    // exactly the pair the log exists to compare.
    const ethanol = [6, 6, 8, 1, 1, 1, 1, 1, 1];
    expect(hillFormula(ethanol, symbolOf)).toBe('C₂H₆O');
    expect(hillFormula([8, 6, 1, 1, 1, 6, 1, 1, 1], symbolOf)).toBe('C₂H₆O');
    expect(hillFormula([6, 1, 1, 1, 1, 7, 8], symbolOf)).toBe('CH₄NO');
  });

  it('sorts everything alphabetically when there is no carbon', () => {
    expect(hillFormula([8, 1, 1], symbolOf)).toBe('H₂O');
    expect(hillFormula([7, 1, 1, 1], symbolOf)).toBe('H₃N');
    expect(hillFormula([8, 8], symbolOf)).toBe('O₂');
  });

  it('leaves out the digit one', () => {
    expect(hillFormula([6, 8], symbolOf)).toBe('CO');
  });

  it('counts atoms rather than the order they were placed in', () => {
    expect(hillFormula([1, 8, 1], symbolOf)).toBe(hillFormula([8, 1, 1], symbolOf));
  });
});

describe('which records may be compared', () => {
  it('separates different molecules', () => {
    expect(comparisonKey(fakeRecord({ energy: -1 }))).not.toBe(
      comparisonKey(fakeRecord({ energy: -1, z: [6, 1, 1, 1, 1] })),
    );
  });

  it('separates the same atoms the engine had to give different charges', () => {
    // Never shown (requirement F4), but two different numbers of electrons are
    // not two shapes of one molecule.
    expect(comparisonKey(fakeRecord({ energy: -1 }))).not.toBe(
      comparisonKey(fakeRecord({ energy: -1, charge: 1 })),
    );
  });

  it('separates records made by a different engine', () => {
    const record = fakeRecord({ energy: -1 });
    const older = { ...record, model: 'sto-3g/lda-vwn5/medium' };
    expect(comparisonKey(record)).not.toBe(comparisonKey(older));
    expect(record.model).toBe(ENGINE_MODEL);
  });

  it('puts two shapes of the same molecule together', () => {
    expect(comparisonKey(fakeRecord({ energy: -1 }))).toBe(
      comparisonKey(fakeRecord({ energy: -2, id: 'other' })),
    );
  });
});

describe('turning a finished relaxation into a record', () => {
  const xyz = [0, 0, 0, 0, 0, 0.96124312, 0.9, 0, -0.24];
  const draft = {
    z: [8, 1, 1],
    built: xyz,
    trajectory: [new Float32Array(xyz), new Float32Array(xyz)],
    stepEnergies: [-74.7, -74.74311011],
    outcome: fakeOutcome({ energy: -74.74311011 }, xyz),
  };

  it('names it after the molecule and the time of day', () => {
    const at = new Date(2026, 8, 20, 14, 32);
    const record = createRecord(draft, symbolOf, at, 'id');
    expect(record.name).toBe('H₂O · 14:32');
    expect(record.name).toBe(defaultRecordName(record.formula, at));
    expect(record.savedAt).toBe(at.toISOString());
  });

  it('rounds the trajectory but not the structure it ended on', () => {
    const record = createRecord(draft, symbolOf, new Date(), 'id');
    const step = 10 ** -TRAJECTORY_DECIMALS;
    for (const frame of record.trajectory) {
      for (const value of frame) expect(Math.abs(value / step - Math.round(value / step))).toBeLessThan(1e-6);
    }
    expect(record.trajectory[0][5]).toBe(0.9612);
    // What gets restored on screen keeps every digit the engine gave.
    expect(record.final).toEqual(xyz);
  });

  it('copies what it was given, so later edits cannot reach into it', () => {
    const mutable = { ...draft, z: [...draft.z], built: [...draft.built] };
    const record = createRecord(mutable, symbolOf, new Date(), 'id');
    mutable.z[0] = 6;
    mutable.built[0] = 99;
    expect(record.z).toEqual([8, 1, 1]);
    expect(record.built[0]).toBe(0);
  });

  it('is a manual one unless a search made it', () => {
    expect(createRecord(draft, symbolOf, new Date(), 'id').source).toBe('manual');
    expect(createRecord({ ...draft, source: 'search', batch: 'b1' }, symbolOf, new Date(), 'id'))
      .toMatchObject({ source: 'search', batch: 'b1' });
  });
});

describe('a structure that came to rest', () => {
  it('is the one that converged, and not the one that ran out', () => {
    expect(isSettled(fakeRecord({ energy: -1 }))).toBe(true);
    expect(isSettled(fakeRecord({ energy: -1, reason: 'interrupted' }))).toBe(false);
    expect(isSettled(fakeRecord({ energy: -1, reason: 'maxSteps' }))).toBe(false);
  });
});

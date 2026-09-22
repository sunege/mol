import { describe, expect, it } from 'vitest';
import { entryFor, groupRecords, groupFor, SAME_VALLEY_KJ_PER_MOL } from './log';
import { comparisonKey } from './record';
import { fakeRecord } from './fixtures';
import { HARTREE_TO_KJ_PER_MOL } from './units';

/** An energy difference of `kj` kJ/mol, in the Hartree records are kept in. */
const hartree = (kj: number) => kj / HARTREE_TO_KJ_PER_MOL;

const BOTTOM = -74.74311011;

describe('gathering records into what may be compared', () => {
  it('keeps different molecules, charges and engines apart', () => {
    const groups = groupRecords([
      fakeRecord({ energy: BOTTOM, id: 'water' }),
      fakeRecord({ energy: -40, z: [6, 1, 1, 1, 1], id: 'methane' }),
      fakeRecord({ energy: -74, charge: 1, id: 'ion' }),
    ]);
    expect(groups).toHaveLength(3);
    expect(groups.map((group) => group.formula).sort()).toEqual(['CH₄', 'H₂O', 'H₂O']);
  });

  it('keeps the two levels of one molecule apart, and says which each is', () => {
    // The same water at each level: -74.74 and -75.84 Ha. In one group the
    // second would be the deepest shape by 2900 kJ/mol.
    const groups = groupRecords([
      fakeRecord({ energy: BOTTOM, id: 'shape' }),
      fakeRecord({ energy: -75.84498516, level: 'measure', id: 'measure' }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.level).sort()).toEqual(['measure', 'shape']);
    for (const group of groups) {
      expect(group.formula).toBe('H₂O');
      expect(group.entries[0].relative).toBe(0);
    }
  });

  it('puts a record kept before levels existed in the group of finding the shape', () => {
    // What is in the browser's database from before V3-5: nothing says a
    // level, and the model is the only string records were written with then.
    const before = {
      ...fakeRecord({ energy: BOTTOM, id: 'before' }),
      model: 'sto-3g/lda-vwn5/fine',
    };
    const groups = groupRecords([before, fakeRecord({ energy: BOTTOM - 0.001, id: 'now' })]);
    expect(groups).toHaveLength(1);
    expect(groups[0].level).toBe('shape');
    expect(groups[0].entries.map((entry) => entry.record.id)).toEqual(['now', 'before']);
  });

  it('gives a group of a model it does not know no level rather than a guess', () => {
    const odd = { ...fakeRecord({ energy: BOTTOM }), model: 'sto-3g/lda-vwn5/medium' };
    expect(groupRecords([odd])[0].level).toBeNull();
  });

  it('puts the group with the newest record first', () => {
    const groups = groupRecords([
      fakeRecord({ energy: BOTTOM, savedAt: '2026-09-20T09:00:00.000Z', id: 'a' }),
      fakeRecord({
        energy: -40,
        z: [6, 1, 1, 1, 1],
        savedAt: '2026-09-20T10:00:00.000Z',
        id: 'b',
      }),
    ]);
    expect(groups[0].formula).toBe('CH₄');
  });

  it('finds the group a molecule on screen belongs to', () => {
    const record = fakeRecord({ energy: BOTTOM });
    const groups = groupRecords([record, fakeRecord({ energy: -40, z: [6], id: 'c' })]);
    expect(groupFor(groups, comparisonKey(record))?.formula).toBe('H₂O');
    expect(groupFor(groups, 'nothing like it')).toBeNull();
  });
});

describe('sorting a group into valleys', () => {
  it('counts two results of the same minimum as one valley', () => {
    // The same shape found twice, differing by less than the optimiser's own
    // scatter - measured at 0.03 kJ/mol at worst (dev-notes, "P9 の実測").
    const groups = groupRecords([
      fakeRecord({ energy: BOTTOM, id: 'first' }),
      fakeRecord({ energy: BOTTOM + hartree(0.03), id: 'second' }),
    ]);
    expect(groups[0].valleys).toBe(1);
    expect(groups[0].entries.map((entry) => entry.valley)).toEqual([0, 0]);
    expect(groups[0].entries.map((entry) => entry.valleySize)).toEqual([2, 2]);
  });

  it('separates minima further apart than the threshold', () => {
    const groups = groupRecords([
      fakeRecord({ energy: BOTTOM, id: 'deep' }),
      fakeRecord({ energy: BOTTOM + hartree(SAME_VALLEY_KJ_PER_MOL * 2), id: 'shallow' }),
    ]);
    expect(groups[0].valleys).toBe(2);
    expect(groups[0].entries.map((entry) => entry.record.id)).toEqual(['deep', 'shallow']);
    expect(groups[0].entries.map((entry) => entry.valley)).toEqual([0, 1]);
  });

  it('measures each valley from its own deepest record, not from the one before', () => {
    // Three records each just under the threshold apart would chain into one
    // valley if every record were compared with the one before it. The first
    // and the last are two thresholds apart and are different shapes.
    const gap = hartree(SAME_VALLEY_KJ_PER_MOL * 0.9);
    const groups = groupRecords([
      fakeRecord({ energy: BOTTOM, id: 'a' }),
      fakeRecord({ energy: BOTTOM + gap, id: 'b' }),
      fakeRecord({ energy: BOTTOM + 2 * gap, id: 'c' }),
    ]);
    expect(groups[0].entries.map((entry) => entry.valley)).toEqual([0, 0, 1]);
    expect(groups[0].valleys).toBe(2);
  });

  it('states how far above the deepest each record is, in kJ/mol', () => {
    const groups = groupRecords([
      fakeRecord({ energy: BOTTOM, id: 'deep' }),
      fakeRecord({ energy: BOTTOM + hartree(38.7), id: 'flat' }),
    ]);
    const [deep, flat] = groups[0].entries;
    expect(deep.relative).toBe(0);
    expect(flat.relative).toBeCloseTo(38.7, 9);
  });
});

describe('a structure that ran out of time or steps', () => {
  const settled = fakeRecord({ energy: BOTTOM, id: 'settled' });
  const partly = fakeRecord({ energy: BOTTOM - 1, reason: 'interrupted', id: 'partly' });

  it('is listed but takes no part in the ranking', () => {
    // It is lower than the settled one here, and still must not become the
    // bottom of the group: it was on its way somewhere when the clock ran out.
    const [group] = groupRecords([settled, partly]);
    expect(group.entries.map((entry) => entry.record.id)).toEqual(['settled', 'partly']);
    expect(group.valleys).toBe(1);
    const unfinished = group.entries[1];
    expect(unfinished.settled).toBe(false);
    expect(unfinished.valley).toBeNull();
    expect(unfinished.relative).toBeNull();
    expect(group.entries[0].relative).toBe(0);
  });

  it('leaves a group of nothing else with no valleys and no numbers', () => {
    const [group] = groupRecords([partly]);
    expect(group.valleys).toBe(0);
    expect(group.entries[0].relative).toBeNull();
  });
});

describe('the order within a valley', () => {
  it('is the order they were found in', () => {
    const [group] = groupRecords([
      fakeRecord({ energy: BOTTOM, savedAt: '2026-09-20T10:00:00.000Z', id: 'later' }),
      fakeRecord({ energy: BOTTOM, savedAt: '2026-09-20T09:00:00.000Z', id: 'earlier' }),
    ]);
    expect(group.entries.map((entry) => entry.record.id)).toEqual(['earlier', 'later']);
  });
});

describe('finding one record in the log', () => {
  it('gives the entry and the group it is compared inside', () => {
    const groups = groupRecords([
      fakeRecord({ energy: -55.3, id: 'deep' }),
      fakeRecord({ energy: -55.2, id: 'shallow' }),
    ]);
    const found = entryFor(groups, 'shallow');
    expect(found?.entry.record.id).toBe('shallow');
    expect(found?.group.entries).toHaveLength(2);
  });

  it('is null for a record the log does not have', () => {
    expect(entryFor(groupRecords([fakeRecord({ energy: -55.3 })]), 'nobody')).toBeNull();
  });
});

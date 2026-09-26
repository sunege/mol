import { describe, expect, it } from 'vitest';
import {
  LOG_FORMAT,
  LOG_VERSION,
  mergeRecords,
  readStructureLog,
  writeStructureLog,
} from './file';
import { fakeRecord, isSupportedElement } from './fixtures';
import { groupRecords } from './log';
import { chargesOf, headingOf, type StructureRecord } from './record';

const WATER = fakeRecord({ energy: -74.74311011, id: 'water' });
const METHANE = fakeRecord({ energy: -39.61713241, z: [6, 1, 1, 1, 1], id: 'methane' });
/** H₃O⁺: water with a proton put on it, the proton last. */
const HYDRONIUM = fakeRecord({ energy: -75.1, z: [8, 1, 1, 1], charge: 1, id: 'hydronium' });

/** A record as version 1 wrote it: no `charges`. */
function asVersion1(record: StructureRecord): Record<string, unknown> {
  const old: Record<string, unknown> = { ...record };
  delete old.charges;
  return old;
}

function version1FileOf(records: unknown[]) {
  return fileOf(records, { version: 1 });
}

/** A file with `records` in it, however malformed those are. */
function fileOf(records: unknown[], overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    format: LOG_FORMAT,
    version: LOG_VERSION,
    exportedAt: '2026-09-20T09:00:00.000Z',
    records,
    ...overrides,
  });
}

describe('writing and reading back', () => {
  it('returns exactly the records that went in', () => {
    const text = writeStructureLog([WATER, METHANE], new Date('2026-09-20T09:00:00.000Z'));
    const result = readStructureLog(text, isSupportedElement);
    expect(result).toEqual({ ok: true, records: [WATER, METHANE] });
  });

  it('says what it is and when it was written', () => {
    const file = JSON.parse(writeStructureLog([WATER], new Date('2026-09-20T09:00:00.000Z')));
    expect(file.format).toBe(LOG_FORMAT);
    expect(file.version).toBe(LOG_VERSION);
    expect(file.exportedAt).toBe('2026-09-20T09:00:00.000Z');
  });

  it('keeps the level each record was solved at', () => {
    const measured = fakeRecord({ energy: -75.84498516, level: 'measure', id: 'measured' });
    const result = readStructureLog(writeStructureLog([WATER, measured]), isSupportedElement);
    expect(result).toEqual({ ok: true, records: [WATER, measured] });
    if (!result.ok) return;
    expect(groupRecords(result.records).map((group) => group.level).sort()).toEqual([
      'measure',
      'shape',
    ]);
  });

  it('opens a file written before records had levels, into the groups of finding the shape', () => {
    // Files prepared for a lecture before V3-5: version 1, and every record
    // with the one model there was. Nothing about them has to change.
    const before = { ...asVersion1(WATER), model: 'sto-3g/lda-vwn5/fine' };
    const result = readStructureLog(version1FileOf([before]), isSupportedElement);
    expect(result).toEqual({ ok: true, records: [before] });
    if (!result.ok) return;
    expect(groupRecords(result.records)[0].level).toBe('shape');
  });

  it('writes an empty log rather than nothing', () => {
    expect(readStructureLog(writeStructureLog([]), isSupportedElement)).toEqual({
      ok: true,
      records: [],
    });
  });
});

describe('refusing a file, with a reason', () => {
  it('refuses what is not JSON', () => {
    expect(readStructureLog('half a file {', isSupportedElement)).toEqual({
      ok: false,
      problem: { kind: 'unreadable' },
    });
  });

  it('refuses JSON that is not one of these', () => {
    for (const text of ['{}', '[]', '"a string"', JSON.stringify({ format: 'something else' })]) {
      expect(readStructureLog(text, isSupportedElement)).toEqual({
        ok: false,
        problem: { kind: 'format' },
      });
    }
  });

  it('refuses a version it does not know, and says which', () => {
    for (const version of [0, 3]) {
      expect(readStructureLog(fileOf([WATER], { version }), isSupportedElement)).toEqual({
        ok: false,
        problem: { kind: 'version', version },
      });
    }
  });

  it('refuses the whole file for one record of a model it never wrote', () => {
    // A record that cannot be solved again at its own level would open with no
    // surface in front of a class; the ones beside it are refused with it.
    const odd = { ...METHANE, model: 'sto-3g/lda-vwn5/medium' };
    const result = readStructureLog(fileOf([WATER, odd]), isSupportedElement);
    expect(result).toEqual({
      ok: false,
      problem: { kind: 'shape', detail: 'model が違います', index: 1 },
    });
  });

  it('refuses an element this engine cannot calculate, and says which', () => {
    const iron = { ...WATER, z: [26, 1, 1] };
    expect(readStructureLog(fileOf([iron]), isSupportedElement)).toEqual({
      ok: false,
      problem: { kind: 'element', z: 26 },
    });
  });

  it('refuses coordinates that do not match the atoms, and says which record', () => {
    const short = { ...METHANE, final: METHANE.final.slice(3) };
    const result = readStructureLog(fileOf([WATER, short]), isSupportedElement);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem).toMatchObject({ kind: 'shape', index: 1 });
  });

  it('refuses a trajectory and an energy list of different lengths', () => {
    const wrong = { ...WATER, stepEnergies: [-1] };
    const result = readStructureLog(fileOf([wrong]), isSupportedElement);
    expect(result.ok).toBe(false);
  });

  it('refuses a record with pieces missing', () => {
    for (const field of ['id', 'name', 'model', 'formula', 'z', 'outcome', 'source']) {
      const without: Record<string, unknown> = { ...WATER };
      delete without[field];
      expect(readStructureLog(fileOf([without]), isSupportedElement).ok).toBe(false);
    }
  });

  it('refuses a calculation that did not converge', () => {
    // Requirement F5: a molecule with no self-consistent density has no numbers
    // to show, so it is never recorded and must not arrive in a file either.
    const diverged = { ...WATER, outcome: { ...WATER.outcome, converged: false } };
    expect(readStructureLog(fileOf([diverged]), isSupportedElement).ok).toBe(false);

    const scfStopped = {
      ...WATER,
      outcome: { ...WATER.outcome, optimization: { ...WATER.outcome.optimization, reason: 'scf' } },
    };
    expect(readStructureLog(fileOf([scfStopped]), isSupportedElement).ok).toBe(false);
  });

  it('accepts a structure that ran out of time', () => {
    // Not a minimum, but a real structure with real numbers: it belongs in the
    // log, marked as unfinished.
    const text = writeStructureLog([fakeRecord({ energy: -74, reason: 'interrupted' })]);
    expect(readStructureLog(text, isSupportedElement).ok).toBe(true);
  });

  it('leaves the records already here alone when it refuses one', () => {
    // The whole file is refused rather than the bad record dropped, so there is
    // nothing to half-apply.
    const result = readStructureLog(fileOf([WATER, { ...METHANE, z: [] }]), isSupportedElement);
    expect(result).toMatchObject({ ok: false });
    expect('records' in result).toBe(false);
  });
});

describe('the charge on each atom (version 2)', () => {
  it('writes version 2, with a charge for every atom', () => {
    const file = JSON.parse(writeStructureLog([WATER, HYDRONIUM]));
    expect(LOG_VERSION).toBe(2);
    expect(file.version).toBe(2);
    expect(file.records.map((record: StructureRecord) => record.charges)).toEqual([
      [0, 0, 0],
      [0, 0, 0, 1],
    ]);
  });

  it('brings an ion back as the ion it was, heading and all', () => {
    const result = readStructureLog(writeStructureLog([HYDRONIUM]), isSupportedElement);
    expect(result).toEqual({ ok: true, records: [HYDRONIUM] });
    if (!result.ok) return;
    expect(chargesOf(result.records[0])).toEqual([0, 0, 0, 1]);
    expect(headingOf(result.records[0])).toBe('H₃O⁺');
    expect(groupRecords(result.records)[0].formula).toBe('H₃O⁺');
  });

  it('opens a version 1 file with every atom neutral', () => {
    const result = readStructureLog(
      version1FileOf([asVersion1(WATER), asVersion1(METHANE)]),
      isSupportedElement,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.records.map((record) => record.charges)).toEqual([undefined, undefined]);
    expect(result.records.map(chargesOf)).toEqual([
      [0, 0, 0],
      [0, 0, 0, 0, 0],
    ]);
    expect(result.records.map(headingOf)).toEqual(['H₂O', 'CH₄']);
  });

  it('does not trust charges in a version 1 file, which never wrote any', () => {
    const result = readStructureLog(version1FileOf([HYDRONIUM]), isSupportedElement);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.records[0].charges).toBeUndefined();
    expect(chargesOf(result.records[0])).toEqual([0, 0, 0, 0]);
  });

  it('writes a record from before v7 with every atom neutral, and reads it back', () => {
    // Kept in the browser without `charges`: one as every record was, and one
    // the engine could only solve as an ion (before v7 it picked ±1 itself).
    const neutral = asVersion1(WATER) as unknown as StructureRecord;
    const picked = asVersion1(HYDRONIUM) as unknown as StructureRecord;
    const text = writeStructureLog([neutral, picked]);
    expect(JSON.parse(text).records.map((record: StructureRecord) => record.charges)).toEqual([
      [0, 0, 0],
      [0, 0, 0, 0],
    ]);
    const result = readStructureLog(text, isSupportedElement);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.records.map(headingOf)).toEqual(['H₂O', 'H₃O⁺']);
    expect(result.records.map(chargesOf)).toEqual([
      [0, 0, 0],
      [0, 0, 0, 0],
    ]);
  });

  it.each([
    ['no charges', asVersion1(HYDRONIUM), '原子ごとの電荷がありません'],
    [
      'one charge too few',
      { ...HYDRONIUM, charges: [0, 0, 1] },
      '原子ごとの電荷の数が原子の数と合いません',
    ],
    [
      'a charge that is not -1, 0 or +1',
      { ...HYDRONIUM, charges: [0, 0, 0, 2] },
      '原子ごとの電荷が −1・0・+1 ではありません',
    ],
    [
      'charges that do not add up to the total',
      { ...HYDRONIUM, charges: [0, 0, 1, 1] },
      '原子ごとの電荷の和が計算結果の電荷と合いません',
    ],
  ])('refuses a version 2 record with %s, and says which', (_, bad, detail) => {
    expect(readStructureLog(fileOf([WATER, bad]), isSupportedElement)).toEqual({
      ok: false,
      problem: { kind: 'shape', detail, index: 1 },
    });
  });
});

describe('merging a file into what is already here', () => {
  it('adds the new ones and keeps the copies already here', () => {
    const renamed = { ...WATER, name: '私の水' };
    const merged = mergeRecords([renamed], [WATER, METHANE]);
    expect(merged.records.map((record) => record.name)).toEqual(['私の水', METHANE.name]);
    expect(merged.added.map((record) => record.id)).toEqual(['methane']);
    expect(merged.alreadyHere).toBe(1);
  });

  it('is harmless to read the same file twice', () => {
    const once = mergeRecords([], [WATER, METHANE]).records;
    const twice = mergeRecords(once, [WATER, METHANE]);
    expect(twice.records).toEqual(once);
    expect(twice).toMatchObject({ added: [], alreadyHere: 2 });
  });
});

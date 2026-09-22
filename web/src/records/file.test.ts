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

const WATER = fakeRecord({ energy: -74.74311011, id: 'water' });
const METHANE = fakeRecord({ energy: -39.61713241, z: [6, 1, 1, 1, 1], id: 'methane' });

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
    // Files prepared for a lecture before V3-5: version 1, as now, and every
    // record with the one model there was. Nothing about them has to change.
    const before = { ...WATER, model: 'sto-3g/lda-vwn5/fine' };
    const text = JSON.stringify({
      format: LOG_FORMAT,
      version: 1,
      exportedAt: '2026-09-20T09:00:00.000Z',
      records: [before],
    });
    const result = readStructureLog(text, isSupportedElement);
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
    for (const version of [0, 2]) {
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

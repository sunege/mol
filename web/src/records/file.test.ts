import { describe, expect, it } from 'vitest';
import {
  LOG_FORMAT,
  LOG_VERSION,
  mergeRecords,
  readStructureLog,
  writeStructureLog,
} from './file';
import { fakeRecord, isSupportedElement } from './fixtures';

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
    expect(readStructureLog(fileOf([], { version: 2 }), isSupportedElement)).toEqual({
      ok: false,
      problem: { kind: 'version', version: 2 },
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

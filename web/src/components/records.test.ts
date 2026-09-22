import { describe, expect, it } from 'vitest';
import {
  ISOMER_CAVEAT,
  RECORDS_HINT,
  depthBar,
  exportFileName,
  groupHeading,
  importProblemText,
  importedText,
  relativeText,
  sameShapeText,
  savedAtText,
  settledCount,
  spreadOf,
} from './records';
import { groupRecords, SAME_VALLEY_KJ_PER_MOL } from '../records/log';
import { fakeRecord } from '../records/fixtures';
import { HARTREE_TO_KJ_PER_MOL } from '../records/units';

const hartree = (kj: number) => kj / HARTREE_TO_KJ_PER_MOL;
const BOTTOM = -55.29630150;

/** A group of ammonia-sized records at the given differences, in kJ/mol. */
function group(...above: { kj: number; reason?: 'interrupted' }[]) {
  return groupRecords(
    above.map((entry, i) =>
      fakeRecord({
        energy: BOTTOM + hartree(entry.kj),
        reason: entry.reason,
        id: `r${i}`,
        savedAt: `2026-09-20T09:0${i}:00.000Z`,
      }),
    ),
  )[0];
}

describe('what a row says about where it sits', () => {
  it('names the deepest instead of writing +0.0', () => {
    const found = group({ kj: 0 }, { kj: 38.7 });
    expect(relativeText(found.entries[0], 2)).toBe('いちばん低い');
    expect(relativeText(found.entries[1], 2)).toBe('+38.7 kJ/mol');
  });

  it('says nothing when there is nothing to compare with', () => {
    const alone = group({ kj: 0 });
    expect(relativeText(alone.entries[0], settledCount(alone))).toBe('');
  });

  it('treats a second result of the same valley as the same, not as +0.0', () => {
    const twice = group({ kj: 0 }, { kj: SAME_VALLEY_KJ_PER_MOL / 2 });
    expect(twice.valleys).toBe(1);
    expect(relativeText(twice.entries[1], 2)).toBe('いちばん低い');
    expect(sameShapeText(twice.entries[1])).toBe('同じ形 2 件');
  });

  it('says a structure that ran out of time is unfinished, and no number', () => {
    const mixed = group({ kj: 0 }, { kj: -100, reason: 'interrupted' });
    const unfinished = mixed.entries[1];
    expect(relativeText(unfinished, 1)).toBe('途中');
    expect(sameShapeText(unfinished)).toBe('');
  });
});

describe('the bar', () => {
  it('is longest for the deepest and shorter above it', () => {
    const found = group({ kj: 0 }, { kj: 20 }, { kj: 40 });
    const spread = spreadOf(found);
    const bars = found.entries.map((entry) => depthBar(entry, spread));
    expect(bars[0]).toBe(1);
    expect(bars[0]).toBeGreaterThan(bars[1]);
    expect(bars[1]).toBeGreaterThan(bars[2]);
    expect(bars[2]).toBeGreaterThan(0);
  });

  it('is full for every record when they all found the same valley', () => {
    const twice = group({ kj: 0 }, { kj: 0 });
    for (const entry of twice.entries) expect(depthBar(entry, spreadOf(twice))).toBe(1);
  });

  it('is not drawn for a structure that did not settle', () => {
    const mixed = group({ kj: 0 }, { kj: 5, reason: 'interrupted' });
    expect(depthBar(mixed.entries[1], spreadOf(mixed))).toBe(0);
  });
});

/** Everything a calculation must not be described by on screen (requirement F4). */
const FORBIDDEN = ['基底', 'STO-3G', '6-31G', '汎関数', 'LDA', 'VWN', '電荷', '多重度', 'DFT'];

describe('the heading of a group', () => {
  it('counts the records, and the shapes once there are two', () => {
    expect(groupHeading(group({ kj: 0 }))).toBe('H₂O · 形を探す · 1 件');
    expect(groupHeading(group({ kj: 0 }, { kj: 0.1 }))).toBe('H₂O · 形を探す · 2 件');
    expect(groupHeading(group({ kj: 0 }, { kj: 38.7 }))).toBe(
      'H₂O · 形を探す · 2 件（2 種類の形）',
    );
  });

  it('says which level the group is at, in the words of the choice', () => {
    const groups = groupRecords([
      fakeRecord({ energy: BOTTOM, id: 'shape' }),
      fakeRecord({ energy: BOTTOM - 1, level: 'measure', id: 'measure' }),
    ]);
    expect(groups.map(groupHeading).sort()).toEqual(['H₂O · 形を探す · 1 件', 'H₂O · 形を測る · 1 件']);
  });

  it('says no level for a model it does not know', () => {
    const odd = { ...fakeRecord({ energy: BOTTOM }), model: 'sto-3g/lda-vwn5/medium' };
    expect(groupHeading(groupRecords([odd])[0])).toBe('H₂O · 1 件');
  });

  it('names no DFT parameter, whichever the level and the charge (requirement F4)', () => {
    const groups = groupRecords(
      (['shape', 'measure'] as const).flatMap((level) =>
        [0, 1].map((charge) =>
          fakeRecord({ energy: BOTTOM, level, charge, id: `${level}-${charge}` }),
        ),
      ),
    );
    expect(groups).toHaveLength(4);
    for (const each of groups) {
      const heading = groupHeading(each).toLowerCase();
      for (const word of FORBIDDEN) expect(heading).not.toContain(word.toLowerCase());
      expect(heading).not.toContain(each.entries[0].record.model);
    }
    // The charge splits the groups and changes nothing that is shown.
    const [neutral, ion] = groups.filter((each) => each.level === 'measure');
    expect(groupHeading(neutral)).toBe(groupHeading(ion));
  });
});

describe('when a record was made', () => {
  const now = new Date(2026, 8, 20, 15, 0);

  it('is the time of day for one made today', () => {
    expect(savedAtText(new Date(2026, 8, 20, 14, 5).toISOString(), now)).toBe('14:05');
  });

  it('carries the date for an older one', () => {
    expect(savedAtText(new Date(2026, 8, 19, 14, 5).toISOString(), now)).toBe('9/19 14:05');
  });
});

describe('reading a file', () => {
  it('says why one was refused, and what to do', () => {
    expect(importProblemText({ kind: 'unreadable' })).toContain('読めません');
    expect(importProblemText({ kind: 'format' })).toContain('書き出したファイルではない');
    expect(importProblemText({ kind: 'version', version: 2 })).toContain('更新');
    expect(importProblemText({ kind: 'element', z: 26 })).toContain('元素');
    expect(importProblemText({ kind: 'shape', detail: '原子がありません', index: 1 })).toContain(
      '2 件目',
    );
  });

  it('says how many came in', () => {
    expect(importedText(3, 0)).toBe('3 件を読み込みました。');
    expect(importedText(1, 2)).toBe('1 件を読み込みました（2 件はすでにありました）。');
    expect(importedText(0, 4)).toContain('すべて入っています');
  });
});

describe('the file written out', () => {
  it('is named after the molecule and the time', () => {
    const name = exportFileName('C₂H₆O', new Date(2026, 8, 20, 9, 5));
    expect(name).toBe('C₂H₆O-記録-20260920-0905.json');
    expect(exportFileName(null, new Date(2026, 8, 20, 9, 5))).toBe('記録-20260920-0905.json');
  });
});

describe('what the section says the comparison is for', () => {
  it('says which comparisons hold and which do not', () => {
    // Both pairs of isomers measured came out the wrong way round, while the
    // same molecule in different shapes came out right (dev-notes, "異性体の
    // エネルギー順序も最小基底で逆になる"), so the hint has to say so.
    expect(RECORDS_HINT).toContain('いちばん低い形からの差');
    expect(ISOMER_CAVEAT).toContain('異性体');
    expect(ISOMER_CAVEAT).toContain('当てになりません');
  });

  it('says it without naming a single DFT parameter (requirement F4)', () => {
    for (const word of FORBIDDEN) expect(`${RECORDS_HINT}${ISOMER_CAVEAT}`).not.toContain(word);
  });
});

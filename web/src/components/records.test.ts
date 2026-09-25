import { describe, expect, it } from 'vitest';
import {
  EXPLORER_WORDS,
  ISOMER_CAVEATS,
  RECORDS_HINT,
  deleteConfirm,
  deleteWhat,
  depthBar,
  exportFileName,
  formulaMeta,
  importProblemText,
  importedText,
  isomerCaveats,
  levelHeading,
  levelMeta,
  relativeText,
  sameShapeText,
  savedAtText,
  settledCount,
  spreadOf,
  valleySizeText,
} from './records';
import { groupRecords, SAME_VALLEY_KJ_PER_MOL } from '../records/log';
import { fakeRecord } from '../records/fixtures';
import { buildRecordTree } from '../records/tree';
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

describe('the words of the tree', () => {
  const tree = buildRecordTree(
    groupRecords([
      ...[0, 0.2, 0.4, 38.7].map((kj, i) =>
        fakeRecord({ energy: BOTTOM + hartree(kj), id: `s${i}`, savedAt: `2026-09-20T09:0${i}:00.000Z` }),
      ),
      fakeRecord({ energy: BOTTOM, level: 'measure', id: 'm0' }),
      fakeRecord({ energy: BOTTOM, level: 'measure', charge: 1, id: 'm1' }),
      fakeRecord({ energy: BOTTOM + 1, reason: 'interrupted', id: 'late' }),
      { ...fakeRecord({ energy: BOTTOM, id: 'odd' }), model: 'sto-3g/lda-vwn5/medium' },
    ]),
  );
  const [water] = tree;
  const [shape, measure, ion, other] = water.children;

  it('counts the records of a molecule beside its formula', () => {
    expect(water.formula).toBe('H₂O');
    expect(formulaMeta(water)).toBe('8');
  });

  it('names a level and counts it, with the shapes once there are two', () => {
    expect(levelHeading(shape.level)).toBe('形を探す');
    expect(levelMeta(shape.group!)).toBe('5 · 2 種類の形');
    expect(levelHeading(measure.level)).toBe('形を測る');
    expect(levelMeta(measure.group!)).toBe('1');
    expect(levelHeading(other.level)).toBe('ほかの計算');
  });

  it('names a valley by its first record, how deep it is and how many found it', () => {
    const valley = shape.children[0];
    if (valley.kind !== 'valley') throw new Error('expected a valley');
    expect(relativeText(valley.head, settledCount(shape.group!))).toBe('いちばん低い');
    expect(valleySizeText(valley)).toBe('×3');
  });

  it('asks before deleting a molecule or a level, naming it and counting (V6-2)', () => {
    expect(deleteConfirm(deleteWhat(water), 8)).toBe('H₂O の記録を 8 件消します。よろしいですか？');
    expect(deleteConfirm(deleteWhat(water, shape), 5)).toBe(
      'H₂O の「形を探す」の記録を 5 件消します。よろしいですか？',
    );
    expect(deleteWhat(water, other)).toBe('H₂O の「ほかの計算」');
    // The two groups that differ by the charge are named alike.
    expect(deleteWhat(water, ion)).toBe(deleteWhat(water, measure));
  });

  it('names no DFT parameter and no group key, even with two charges (requirement F4)', () => {
    // Two groups at one level that differ by the charge read the same.
    expect(levelHeading(ion.level)).toBe(levelHeading(measure.level));
    expect(levelMeta(ion.group!)).toBe(levelMeta(measure.group!));

    const words: string[] = [];
    for (const molecule of tree) {
      words.push(molecule.formula, formulaMeta(molecule));
      for (const level of molecule.children) {
        const settled = settledCount(level.group!);
        words.push(levelHeading(level.level), levelMeta(level.group));
        for (const child of level.children) {
          if (child.kind === 'candidate') continue;
          const entries = child.kind === 'valley' ? [child.head, ...child.rest] : [child.entry];
          if (child.kind === 'valley') words.push(valleySizeText(child));
          for (const entry of entries) {
            words.push(entry.record.name, relativeText(entry, settled), sameShapeText(entry));
          }
        }
      }
    }
    words.push(...Object.values(EXPLORER_WORDS));
    words.push(deleteConfirm(deleteWhat(water), 8));
    for (const level of water.children) words.push(deleteConfirm(deleteWhat(water, level), 1));
    const text = words.join('\n').toLowerCase();
    for (const word of [...FORBIDDEN, 'STO', '6-31']) expect(text).not.toContain(word.toLowerCase());
    for (const level of water.children) expect(text).not.toContain(level.group!.key.toLowerCase());
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
  it('says which comparisons hold and which do not, level by level', () => {
    // "形を探す" put two of five isomer pairs the wrong way round, "形を測る" none
    // of them but with the gaps too small (dev-notes, "v3-0 の実測").
    expect(RECORDS_HINT).toContain('いちばん低い形からの差');
    for (const caveat of Object.values(ISOMER_CAVEATS)) expect(caveat).toContain('異性体');
    expect(ISOMER_CAVEATS.shape).toContain('逆に');
    expect(ISOMER_CAVEATS.shape).toContain('「形を探す」');
    expect(ISOMER_CAVEATS.shape).toContain('「形を測る」で計算');
    expect(ISOMER_CAVEATS.measure).toContain('合って');
    expect(ISOMER_CAVEATS.measure.startsWith('「形を測る」')).toBe(true);
  });

  it('says it for the levels the tree holds only, shape first', () => {
    expect(isomerCaveats([])).toEqual([]);
    expect(isomerCaveats([null])).toEqual([]);
    expect(isomerCaveats(['shape'])).toEqual([ISOMER_CAVEATS.shape]);
    expect(isomerCaveats(['measure', null, 'shape', 'measure'])).toEqual([
      ISOMER_CAVEATS.shape,
      ISOMER_CAVEATS.measure,
    ]);
  });

  it('says it without naming a single DFT parameter (requirement F4)', () => {
    const text = `${RECORDS_HINT}${Object.values(ISOMER_CAVEATS).join('')}`;
    for (const word of FORBIDDEN) expect(text).not.toContain(word);
  });
});

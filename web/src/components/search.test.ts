import { describe, expect, it } from 'vitest';
import {
  NUDGED_COUNT,
  SEARCH_EMPTY,
  SEARCH_HEADING,
  SEARCH_HINT,
  canCancel,
  canOpen,
  candidateName,
  depthText,
  isOver,
  searchDisabledReason,
  searchSummary,
  statusText,
} from './search';
import type { Candidate, CandidateStatus } from '../search/pool';
import { groupRecords } from '../records/log';
import { fakeRecord } from '../records/fixtures';
import { HARTREE_TO_KJ_PER_MOL } from '../records/units';
import { settledCount } from './records';
import { levelLabel } from './level';

const ALL_STATUSES: CandidateStatus[] = [
  'waiting',
  'running',
  'settled',
  'partial',
  'failed',
  'cancelled',
  'unavailable',
];

function candidate(status: CandidateStatus, extra: Partial<Candidate> = {}): Candidate {
  return {
    id: `id-${status}`,
    batch: 'batch-1',
    z: new Uint8Array([8, 1, 1]),
    built: new Float64Array(9),
    start: new Float64Array(9),
    status,
    startedAt: status === 'waiting' ? null : 1000,
    finishedAt: null,
    steps: 0,
    outcome: null,
    trajectory: [],
    stepEnergies: [],
    ...extra,
  };
}

describe('what a row says', () => {
  it('has words for every state a candidate can be in', () => {
    for (const status of ALL_STATUSES) {
      expect(statusText(candidate(status), 1000)).not.toBe('');
    }
  });

  it('counts the moves and the time while one runs', () => {
    const running = candidate('running', { startedAt: 1000, steps: 4 });
    expect(statusText(running, 13_500)).toBe('計算中 · 4 回目の移動 · 12.5 秒');
  });

  it('says nothing at all about one the engine could not solve', () => {
    // Requirement F5: no number and no word that blames the molecule. The
    // divergence animation is the whole of the answer, and it is behind 開く.
    expect(statusText(candidate('failed'), 2000)).toBe('—');
  });

  it('keeps every DFT parameter off the screen', () => {
    const forbidden = [
      '基底',
      'STO',
      'STO-3G',
      '6-31G',
      '汎関数',
      'LDA',
      'VWN',
      'DFT',
      '電荷',
      '多重度',
      'スピン',
      '一重項',
      '三重項',
      'SCF',
    ];
    const said = [
      SEARCH_HEADING,
      SEARCH_HINT,
      SEARCH_EMPTY,
      searchDisabledReason(0) ?? '',
      ...ALL_STATUSES.map((status) => statusText(candidate(status), 5000)),
      searchSummary([candidate('running'), candidate('waiting'), candidate('settled')]),
    ].join(' ');
    for (const word of forbidden) expect(said).not.toContain(word);
  });
});

describe('which level the search runs at', () => {
  it('says so by the name the choice above gives it', () => {
    // Choosing the other level for the calculations in front changes nothing
    // here, and the hint is where a class finds that out.
    expect(SEARCH_HINT).toContain(
      `上で何を選んでいても、ここで試す形は「${levelLabel('shape')}」で計算します。`,
    );
    expect(SEARCH_HINT).not.toContain(levelLabel('measure'));
  });

  it('does not call either level better or worse', () => {
    for (const word of ['精度', '正確', '正しく', '高い', '低い', '粗い', '簡易']) {
      expect(SEARCH_HINT).not.toContain(word);
    }
  });

  it('has a heading that does not sound like a level', () => {
    // "形をさがす" was read out the same as "形を探す" just above it.
    for (const word of ['探す', 'さがす', '測る', 'はかる']) {
      expect(SEARCH_HEADING).not.toContain(word);
    }
  });
});

describe('how deep the shape a candidate found is', () => {
  /** Two ammonia records, the second `kj` above the first. */
  function entriesFor(kj: number) {
    const bottom = -55.2963015;
    const groups = groupRecords([
      fakeRecord({ energy: bottom, id: 'first', savedAt: '2026-09-20T09:00:00.000Z' }),
      fakeRecord({
        energy: bottom + kj / HARTREE_TO_KJ_PER_MOL,
        id: 'second',
        savedAt: '2026-09-20T09:01:00.000Z',
      }),
    ]);
    return groups[0];
  }

  it('reads the same as the row in the log does', () => {
    const group = entriesFor(38.7);
    const settled = settledCount(group);
    const higher = group.entries.find((entry) => entry.record.id === 'second')!;
    expect(depthText(candidate('settled'), higher, settled)).toBe('+38.7 kJ/mol');
  });

  it('says nothing for a candidate that did not settle', () => {
    const group = entriesFor(38.7);
    const deepest = group.entries[0];
    for (const status of ALL_STATUSES) {
      if (status === 'settled') continue;
      expect(depthText(candidate(status), deepest, 2)).toBe('');
    }
  });

  it('says nothing before the record exists', () => {
    expect(depthText(candidate('settled'), null, 2)).toBe('');
  });
});

describe('what can be done to a candidate', () => {
  it('lets a finished one be opened, including one that came apart', () => {
    expect(ALL_STATUSES.filter((status) => canOpen(candidate(status)))).toEqual([
      'settled',
      'partial',
      'failed',
    ]);
  });

  it('lets only an unfinished one be stopped', () => {
    expect(ALL_STATUSES.filter((status) => canCancel(candidate(status)))).toEqual([
      'waiting',
      'running',
    ]);
  });

  it('knows which states the pool has finished with', () => {
    expect(ALL_STATUSES.filter(isOver)).toEqual([
      'settled',
      'partial',
      'failed',
      'cancelled',
      'unavailable',
    ]);
  });
});

describe('the line above the list', () => {
  it('is empty before anything has been tried', () => {
    expect(searchSummary([])).toBe('');
  });

  it('counts what is happening without naming any of it', () => {
    expect(
      searchSummary([
        candidate('running'),
        candidate('waiting'),
        candidate('waiting'),
        candidate('settled'),
        candidate('failed'),
      ]),
    ).toBe('1 件を計算中 · 2 件が順番待ち · 2 件が終わりました');
  });

  it('leaves out the parts that are not happening', () => {
    expect(searchSummary([candidate('settled')])).toBe('1 件が終わりました');
  });
});

describe('the rest of the words', () => {
  it('numbers the candidates from one, in the order they were started', () => {
    const all = [candidate('settled'), candidate('running'), candidate('waiting')];
    expect(all.map((each) => candidateName(all, each))).toEqual(['候補 1', '候補 2', '候補 3']);
  });

  it('explains an empty molecule rather than leaving a dead button', () => {
    expect(searchDisabledReason(0)).not.toBeNull();
    expect(searchDisabledReason(3)).toBeNull();
  });

  it('starts more shapes than the pool runs at a time, which is the point', () => {
    // What finds another shape is trying several directions, not nudging
    // harder ("P10-1 の実測"); the ones that do not fit simply wait.
    expect(NUDGED_COUNT).toBeGreaterThan(1);
  });
});

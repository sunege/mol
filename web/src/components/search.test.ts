import { describe, expect, it } from 'vitest';
import {
  NUDGED_COUNT,
  SEARCH_HEADING,
  SEARCH_HINT,
  canCancel,
  candidateName,
  isOver,
  searchDisabledReason,
  searchSummary,
  statusText,
} from './search';
import type { Candidate, CandidateStatus } from '../search/pool';
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
    expect(SEARCH_HINT).toContain(`上の選択にかかわらず裏側で「${levelLabel('shape')}」で計算し`);
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

describe('what can be done to a candidate', () => {
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

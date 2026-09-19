import { describe, expect, it } from 'vitest';
import { checklist, formatElapsed, headline, type JobKind, type JobState } from './progress';
import type { CalculationProgress } from '../worker/protocol';

const job = (
  kind: JobKind,
  engine: CalculationProgress | null,
  extra: Partial<JobState> = {},
): JobState => ({ kind, startedAt: 0, engine, drawsSurface: true, drawing: false, ...extra });

const states = (state: JobState) => checklist(state).map((item) => `${item.id}:${item.state}`);

/** Every report the engine can make, in the order a relaxation makes them. */
const RELAXATION: (CalculationProgress | null)[] = [
  null,
  { stage: 'preparing' },
  { stage: 'searching' },
  { stage: 'forces', step: 0 },
  { stage: 'solving', step: 1 },
  { stage: 'forces', step: 1 },
  { stage: 'solving', step: 2 },
  { stage: 'solving', step: 2 },
  { stage: 'forces', step: 2 },
  { stage: 'solving', step: 14 },
  { stage: 'forces', step: 14 },
];

describe('the progress checklist', () => {
  it('walks a relaxation through its parts in order', () => {
    expect(states(job('relax', null))).toEqual([
      'prepare:active',
      'search:pending',
      'forces:pending',
      'move:pending',
      'draw:pending',
    ]);
    expect(states(job('relax', { stage: 'searching' }))).toEqual([
      'prepare:done',
      'search:active',
      'forces:pending',
      'move:pending',
      'draw:pending',
    ]);
    // The forces of the structure as placed are the last thing before anything
    // moves, and have a line of their own.
    expect(states(job('relax', { stage: 'forces', step: 0 }))).toEqual([
      'prepare:done',
      'search:done',
      'forces:active',
      'move:pending',
      'draw:pending',
    ]);
    // After that every report is one of the moves, whichever half of it.
    for (const engine of [
      { stage: 'solving', step: 3 },
      { stage: 'forces', step: 3 },
    ] as CalculationProgress[]) {
      expect(states(job('relax', engine))).toEqual([
        'prepare:done',
        'search:done',
        'forces:done',
        'move:active',
        'draw:pending',
      ]);
    }
    expect(states(job('relax', { stage: 'forces', step: 3 }, { drawing: true }))).toEqual([
      'prepare:done',
      'search:done',
      'forces:done',
      'move:done',
      'draw:active',
    ]);
  });

  it('never moves backwards as the reports come in', () => {
    let previous = -1;
    for (const engine of RELAXATION) {
      const active = checklist(job('relax', engine)).findIndex((item) => item.state === 'active');
      expect(active).toBeGreaterThanOrEqual(previous);
      previous = active;
    }
  });

  it('counts the moves on the line that repeats', () => {
    const items = checklist(job('relax', { stage: 'solving', step: 4 }));
    expect(items.find((item) => item.id === 'move')?.detail).toBe('4 回目');
    expect(headline(job('relax', { stage: 'solving', step: 4 }))).toContain('4 回目');
    expect(headline(job('relax', { stage: 'forces', step: 4 }))).toContain('力を求めています');
    // Only the line under way carries a count.
    for (const item of items) if (item.id !== 'move') expect(item.detail).toBeUndefined();
  });

  it('gives a single point only the parts it has', () => {
    expect(states(job('single', { stage: 'searching' }))).toEqual([
      'prepare:done',
      'search:active',
      'draw:pending',
    ]);
    expect(states(job('single', { stage: 'searching' }, { drawing: true }))).toEqual([
      'prepare:done',
      'search:done',
      'draw:active',
    ]);
  });

  it('leaves out the surface when none will be drawn', () => {
    const ids = checklist(job('relax', null, { drawsSurface: false })).map((item) => item.id);
    expect(ids).not.toContain('draw');
    expect(checklist(job('single', null, { drawsSurface: false })).map((item) => item.id)).toEqual(
      ['prepare', 'search'],
    );
  });

  it('has exactly one part under way until the end', () => {
    for (const kind of ['single', 'relax'] as JobKind[]) {
      for (const engine of RELAXATION) {
        for (const drawing of [false, true]) {
          const items = checklist(job(kind, engine, { drawing }));
          expect(items.filter((item) => item.state === 'active')).toHaveLength(1);
        }
      }
    }
  });

  /**
   * Requirement F4, checked over every state the card can be in. The engine
   * keeps the spin search's details on its side of the worker boundary; this is
   * the guard against the words for them coming back in from this one.
   */
  it('never names a DFT parameter', () => {
    const forbidden =
      /多重度|一重項|二重項|三重項|スピン|電荷|基底|STO|LDA|VWN|汎関数|グリッド|格子|SCF|DFT|Hartree|試行|候補|[0-9]+ ?番目の状態/;
    const text: string[] = [];
    for (const kind of ['single', 'relax'] as JobKind[]) {
      for (const engine of RELAXATION) {
        for (const drawing of [false, true]) {
          for (const drawsSurface of [false, true]) {
            const state = job(kind, engine, { drawing, drawsSurface });
            text.push(headline(state));
            for (const item of checklist(state)) text.push(item.label, item.detail ?? '');
          }
        }
      }
    }
    for (const line of text) expect(line).not.toMatch(forbidden);
  });
});

describe('elapsed time', () => {
  it('shows tenths of a second for the first minute', () => {
    expect(formatElapsed(0)).toBe('0.0 秒');
    expect(formatElapsed(6390)).toBe('6.3 秒');
    expect(formatElapsed(15_980)).toBe('15.9 秒');
  });

  it('never runs ahead of the clock', () => {
    // Truncated, so 59.99 seconds is not shown as a minute early.
    expect(formatElapsed(59_990)).toBe('59.9 秒');
    expect(formatElapsed(60_000)).toBe('1 分 00 秒');
    expect(formatElapsed(125_400)).toBe('2 分 05 秒');
  });

  it('treats a clock that has not caught up yet as zero', () => {
    // The first render after a press can read a `now` from before it.
    expect(formatElapsed(-12)).toBe('0.0 秒');
  });
});

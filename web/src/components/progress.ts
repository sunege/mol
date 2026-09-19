/**
 * What the progress card says while a calculation runs.
 *
 * Benzene's "安定な形にする" spends about six seconds before its first step
 * moves anything - the integrals, the search for how the electrons arrange
 * themselves, the first forces - and every step after that is a few seconds of
 * standing still followed by a short move. The card is what fills those
 * seconds: which part of the work is under way, which parts are behind it, and
 * how long it has been.
 *
 * Kept apart from the component so the words can be checked without a DOM. The
 * rule they answer to is requirement F4: no DFT parameter reaches the screen, so
 * the stages are named for what the time is spent on ("電子の並び方を探す") and
 * never for how (which spin states, how many of them, on which grid). The engine
 * does not send that information across the worker boundary in the first place;
 * the test walks every state this module can describe and checks that nothing
 * here brings it back.
 */
import type { CalculationProgress } from '../worker/protocol';

/** Which button started the calculation. */
export type JobKind = 'single' | 'relax';

/** Everything the card needs to know about the calculation in progress. */
export interface JobState {
  kind: JobKind;
  /** When the button was pressed, on the `performance.now()` clock. */
  startedAt: number;
  /** The engine's latest report, or null before its first one arrives. */
  engine: CalculationProgress | null;
  /** Whether a density surface will be cut once the engine has answered. */
  drawsSurface: boolean;
  /** The engine has answered and the first surface is being cut. */
  drawing: boolean;
}

/** The parts of the work, in the order they happen. */
export type ChecklistId = 'prepare' | 'search' | 'forces' | 'move' | 'draw';

export type ChecklistState = 'done' | 'active' | 'pending';

export interface ChecklistItem {
  id: ChecklistId;
  label: string;
  state: ChecklistState;
  /** Which move the optimiser is on, for the item that repeats. */
  detail?: string;
}

const LABELS: Record<ChecklistId, string> = {
  prepare: '下準備',
  search: '電子の並び方を探す',
  forces: '原子にかかる力を求める',
  move: '形を少しずつ動かす',
  draw: '電子の雲を描く',
};

/** The parts a calculation of this kind goes through. */
function itemsFor(job: JobState): ChecklistId[] {
  const engine: ChecklistId[] =
    job.kind === 'relax' ? ['prepare', 'search', 'forces', 'move'] : ['prepare', 'search'];
  return job.drawsSurface ? [...engine, 'draw'] : engine;
}

/**
 * The part a report belongs to.
 *
 * The forces of the structure as placed are their own line - they are the last
 * thing before anything moves - and every later report belongs to the moves.
 * Nothing reported yet means the worker is still starting, which is part of the
 * preparation as far as anyone watching can tell.
 */
function currentId(job: JobState): ChecklistId {
  if (job.drawing) return 'draw';
  const engine = job.engine;
  if (engine === null) return 'prepare';
  switch (engine.stage) {
    case 'preparing':
      return 'prepare';
    case 'searching':
      return 'search';
    case 'forces':
      return engine.step === 0 ? 'forces' : 'move';
    case 'solving':
      return engine.step === 0 ? 'search' : 'move';
  }
}

/** Every part of the calculation, with the one under way marked. */
export function checklist(job: JobState): ChecklistItem[] {
  const ids = itemsFor(job);
  // A report that does not fit this kind of calculation (a single point never
  // moves anything) leaves the card on the last part it does have, rather than
  // pretending to be further along.
  let current = ids.indexOf(currentId(job));
  if (current < 0) current = job.drawing ? ids.length : ids.length - 1;
  const engine = job.engine;
  return ids.map((id, index) => {
    const state: ChecklistState =
      index < current ? 'done' : index === current ? 'active' : 'pending';
    const item: ChecklistItem = { id, label: LABELS[id], state };
    if (id === 'move' && state === 'active' && engine && 'step' in engine) {
      item.detail = `${engine.step} 回目`;
    }
    return item;
  });
}

/** One sentence for what is happening now. */
export function headline(job: JobState): string {
  const id = currentId(job);
  const engine = job.engine;
  switch (id) {
    case 'prepare':
      return '計算の下準備をしています';
    case 'search':
      return '電子の並び方を探しています';
    case 'forces':
      return '原子にかかる力を求めています';
    case 'move': {
      const step = engine && 'step' in engine ? engine.step : 0;
      const what =
        engine?.stage === 'forces' ? '力を求めています' : '新しい形で電子を解いています';
      return `${step} 回目の移動 · ${what}`;
    }
    case 'draw':
      return '電子の雲を描いています';
  }
}

/**
 * Elapsed time as the card shows it: tenths of a second for the first minute,
 * which is where every supported molecule finishes, and minutes after that.
 *
 * Truncated rather than rounded, so the display never runs ahead of the clock
 * and never shows "60.0 秒" for a moment before turning into a minute.
 */
export function formatElapsed(ms: number): string {
  const tenths = Math.floor(Math.max(0, ms) / 100);
  if (tenths < 600) return `${(tenths / 10).toFixed(1)} 秒`;
  const seconds = Math.floor(tenths / 10);
  return `${Math.floor(seconds / 60)} 分 ${String(seconds % 60).padStart(2, '0')} 秒`;
}

/**
 * The words and numbers of the search section of the panel.
 *
 * What a class sees of a candidate is what it is doing, how long it has been
 * doing it, and - once it has settled - how deep the shape it found is compared
 * with the others of the same molecule. Nothing about the calculation itself
 * reaches this file (requirement F4), and a candidate the engine could not solve
 * gets no number and no word for it (requirement F5): the row is a dash, and
 * opening it plays the molecule coming apart, which is the whole answer.
 */
import { SEARCH_LEVEL, type Candidate, type CandidateStatus } from '../search/pool';
import type { LogEntry } from '../records/log';
import { levelLabel } from './level';
import { formatElapsed } from './progress';
import { relativeText } from './records';

/**
 * How many shapes "ゆらして試す" starts at once.
 *
 * More than the pool runs at a time on purpose: what finds another shape is
 * trying several directions, not nudging harder (`docs/dev-notes.md`,
 * "P10-1 の実測"), and the ones that do not fit simply wait. Three is a number a
 * lecture can watch finish.
 */
export const NUDGED_COUNT = 3;

/**
 * The heading of the section.
 *
 * Its verb is the buttons' own, and deliberately not "探す": that word belongs
 * to the level the calculation section offers just above, and the search once
 * had a heading that sounded the same when read out in a lecture.
 */
export const SEARCH_HEADING = 'いろいろな形を試す';

/**
 * The line under the buttons.
 *
 * It names the level the search always runs at, by the name the choice above
 * gives it, because choosing the other one up there does nothing down here - and
 * it is also why the records of these candidates sit in that level's group.
 */
export const SEARCH_HINT =
  '押すと裏側で計算します。そのあいだも画面は動かせますし、「安定な形にする」も今までどおり使えます。' +
  `上で何を選んでいても、ここで試す形は「${levelLabel(SEARCH_LEVEL)}」で計算します。` +
  '落ち着いた形は記録に入ります。';

export const SEARCH_EMPTY =
  'まだ何も試していません。「今の形を試す」で今の形を、「ゆらして試す」で少しずらした形をいくつか試します。';

/**
 * Why the buttons are off, or null when they are not.
 *
 * An engine that will not run here is said once, by the app, so this only has
 * to explain the ordinary reason.
 */
export function searchDisabledReason(atomCount: number): string | null {
  return atomCount === 0 ? '原子を置くと試せます。' : null;
}

/** What one candidate is doing, in the plainest words that are true. */
export function statusText(candidate: Candidate, now: number): string {
  switch (candidate.status) {
    case 'waiting':
      return '順番待ち';
    case 'running': {
      const elapsed = candidate.startedAt === null ? 0 : now - candidate.startedAt;
      // The step count is the only thing moving for the first several seconds,
      // and zero of them is honest: nothing has been accepted yet.
      return `計算中 · ${candidate.steps} 回目の移動 · ${formatElapsed(elapsed)}`;
    }
    case 'settled':
      return '落ち着きました';
    case 'partial':
      // The same distinction the rest of the app makes: the electrons were
      // solved at every geometry, the shape simply had not stopped moving.
      return '途中で止まりました';
    case 'failed':
      // Requirement F5: no number, and no word that reads as a failure of the
      // molecule. Opening it shows what happened.
      return '—';
    case 'cancelled':
      return '中止しました';
    case 'unavailable':
      return '計算できませんでした';
  }
}

/**
 * How deep the shape this candidate found is, against the others of its
 * molecule - or an empty string when there is nothing to compare or nothing to
 * say.
 *
 * `entry` is the log entry of the record this candidate became, which is where
 * the comparison lives; the wording is the log's own, so a row here and a row
 * there never disagree.
 */
export function depthText(
  candidate: Candidate,
  entry: LogEntry | null,
  settledInGroup: number,
): string {
  if (candidate.status !== 'settled' || entry === null) return '';
  return relativeText(entry, settledInGroup);
}

/** Whether this candidate has something to put on screen. */
export function canOpen(candidate: Candidate): boolean {
  return candidate.status === 'settled' || candidate.status === 'partial' ||
    candidate.status === 'failed';
}

/** Whether stopping this candidate would do anything. */
export function canCancel(candidate: Candidate): boolean {
  return candidate.status === 'waiting' || candidate.status === 'running';
}

/** The statuses that mean the pool has finished with a candidate. */
export function isOver(status: CandidateStatus): boolean {
  return status !== 'waiting' && status !== 'running';
}

/**
 * The line above the list: what is happening to the set as a whole.
 *
 * Counts only, because the interesting numbers are in the records - this is
 * here so that someone who has looked away knows whether to wait.
 */
export function searchSummary(candidates: readonly Candidate[]): string {
  if (candidates.length === 0) return '';
  const running = candidates.filter((c) => c.status === 'running').length;
  const waiting = candidates.filter((c) => c.status === 'waiting').length;
  const done = candidates.filter((c) => isOver(c.status)).length;
  const parts: string[] = [];
  if (running > 0) parts.push(`${running} 件を計算中`);
  if (waiting > 0) parts.push(`${waiting} 件が順番待ち`);
  if (done > 0) parts.push(`${done} 件が終わりました`);
  return parts.join(' · ');
}

/** What each candidate is called in the list: its place in the batch. */
export function candidateName(candidates: readonly Candidate[], candidate: Candidate): string {
  const index = candidates.indexOf(candidate);
  return `候補 ${index + 1}`;
}

/**
 * The words and numbers of the records section of the panel.
 *
 * What a class sees of a record is its name, when it was made, and how it
 * compares with the others of the same molecule - a difference in kJ/mol and a
 * bar for how deep the valley is. Nothing about the calculation itself reaches
 * this file (requirement F4): the charge that separates one comparable set from
 * another is in the key, not on the screen.
 */
import type { LogEntry, LogGroup } from '../records/log';
import { SAME_VALLEY_KJ_PER_MOL } from '../records/log';
import type { ImportProblem } from '../records/file';

export const NO_RECORDS =
  'まだ記録がありません。「安定な形にする」を押すと、落ち着いた形がここに残ります。';

export const RECORDS_HINT =
  '同じ分子の記録どうしを、いちばん低い形からの差で並べています。棒が長いほど低い（安定な）形です。';

export const NOT_KEPT_NOTICE =
  'このブラウザには記録が残りません（タブを閉じると消えます）。必要ならファイルに書き出してください。';

/** The bar is this wide at its shortest, so that a row is never a blank line. */
const MINIMUM_BAR = 0.08;

/**
 * How far above the deepest structure of its group this one is.
 *
 * The deepest says so in words rather than as `+0.0`, and so does everything
 * that found the same valley - a difference in the second decimal between two
 * results of one minimum is the optimiser stopping in slightly different
 * places, not a shape ("P9 の実測"). With nothing to compare against yet there
 * is no number to give, and a structure that ran out of time takes no part.
 */
export function relativeText(entry: LogEntry, settledInGroup: number): string {
  if (!entry.settled || entry.relative === null) return '途中';
  if (settledInGroup < 2) return '';
  if (entry.relative < SAME_VALLEY_KJ_PER_MOL) return 'いちばん低い';
  return `+${entry.relative.toFixed(1)} kJ/mol`;
}

/** How many of a group's records settled, which is what may be compared. */
export function settledCount(group: LogGroup): number {
  return group.entries.filter((entry) => entry.settled).length;
}

/** The same, for the label under a row: how many records found this shape. */
export function sameShapeText(entry: LogEntry): string {
  if (!entry.settled || entry.valleySize === null || entry.valleySize < 2) return '';
  return `同じ形 ${entry.valleySize} 件`;
}

/**
 * The length of a row's bar, from 0 to 1: full for the deepest structure of the
 * group, shorter the higher one sits above it.
 *
 * `spread` is the highest `relative` in the group, so a group whose records all
 * found the same valley draws them all full length - which is the answer: they
 * are the same depth.
 */
export function depthBar(entry: LogEntry, spread: number): number {
  if (!entry.settled || entry.relative === null) return 0;
  if (!(spread > 0)) return 1;
  return MINIMUM_BAR + (1 - MINIMUM_BAR) * (1 - Math.min(1, entry.relative / spread));
}

/** The highest a settled record sits above its group's deepest, in kJ/mol. */
export function spreadOf(group: LogGroup): number {
  return group.entries.reduce((most, entry) => Math.max(most, entry.relative ?? 0), 0);
}

/** `H₂O · 3 件（2 種類の形）`, or just the count when there is one shape. */
export function groupHeading(group: LogGroup): string {
  const shapes = group.valleys >= 2 ? `（${group.valleys} 種類の形）` : '';
  return `${group.formula} · ${group.entries.length} 件${shapes}`;
}

/** `14:32` for a record made today, `9/20 14:32` for an older one. */
export function savedAtText(savedAt: string, now: Date = new Date()): string {
  const at = new Date(savedAt);
  if (Number.isNaN(at.getTime())) return '';
  const time = `${at.getHours()}:${String(at.getMinutes()).padStart(2, '0')}`;
  const sameDay =
    at.getFullYear() === now.getFullYear() &&
    at.getMonth() === now.getMonth() &&
    at.getDate() === now.getDate();
  return sameDay ? time : `${at.getMonth() + 1}/${at.getDate()} ${time}`;
}

/**
 * Why a file was not read.
 *
 * Every one of these says what to do about it, because the person holding the
 * file is about to teach with it.
 */
export function importProblemText(problem: ImportProblem): string {
  switch (problem.kind) {
    case 'unreadable':
      return 'このファイルは読めませんでした。書き出したファイルをそのまま選んでください。';
    case 'format':
      return 'このアプリが書き出したファイルではないようです。';
    case 'version':
      return '新しい版のアプリで書き出されたファイルです。アプリを更新してから開いてください。';
    case 'element':
      return 'このアプリが計算できない元素が入っているため、読み込みませんでした。';
    case 'shape':
      return `${problem.index + 1} 件目の記録が壊れているため、読み込みませんでした（${problem.detail}）。`;
  }
}

/** How many records came in, for the line shown after reading a file. */
export function importedText(added: number, alreadyHere: number): string {
  if (added === 0) return 'この記録はすべて入っています。';
  const already = alreadyHere > 0 ? `（${alreadyHere} 件はすでにありました）` : '';
  return `${added} 件を読み込みました${already}。`;
}

/** What the file is called when it is written out. */
export function exportFileName(formula: string | null, now: Date = new Date()): string {
  const two = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}`;
  return `${formula ? `${formula}-` : ''}記録-${stamp}.json`;
}

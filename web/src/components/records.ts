/**
 * The words and numbers of the records section of the panel.
 *
 * What a class sees of a record is its name, when it was made, and how it
 * compares with the others of the same molecule - a difference in kJ/mol and a
 * bar for how deep the valley is. Nothing about the calculation itself reaches
 * this file (requirement F4): the charge that separates one comparable set from
 * another is in the key, not on the screen, and the level that separates them
 * is named by what it is for (`levelLabel`), never by its basis.
 */
import type { LogEntry, LogGroup } from '../records/log';
import { SAME_VALLEY_KJ_PER_MOL } from '../records/log';
import type { ImportProblem } from '../records/file';
import type { FormulaNode, LevelNode, ValleyNode } from '../records/tree';
import { LEVEL_ORDER, levelLabel } from './level';
import type { ModelLevel } from '../worker/protocol';

export const NO_RECORDS =
  'まだ記録がありません。「安定な形にする」を押すと、落ち着いた形がここに残ります。';

export const RECORDS_HINT =
  '同じ分子の記録どうしを、いちばん低い形からの差で並べています。棒が長いほど低い（安定な）形です。';

/**
 * What the ranking may and may not be read as, one sentence per level (V6-1).
 *
 * The same molecule in different shapes compares well at both levels (ethane's
 * rotation barrier comes out at 13.5 kJ/mol against a textbook 12). Isomers are
 * where the two part. Measured on five pairs (`docs/dev-notes.md`, "v3-0 の実測"):
 * "形を探す" puts two of them the wrong way round - C₃H₆ (cyclopropane against
 * propene) and C₂H₆O (ethanol against dimethyl ether), by 50 and 78 kJ/mol -
 * while "形を測る" puts all five in the right order, but with the gaps too
 * small (C₃H₆: −5.4 kJ/mol against an experimental −32.9). So the first says
 * not to trust it and where to go instead, and the second says the order has
 * held so far but the size may not.
 *
 * Neither names the basis or the functional (requirement F4): the level is
 * named by what it is for (`levelLabel`).
 */
export const ISOMER_CAVEATS: Record<ModelLevel, string> = {
  shape:
    `「${levelLabel('shape')}」の記録: つながり方が違う分子（異性体）どうしでは、` +
    'どちらが安定かが逆に出ることがあります。' +
    `くらべるときは「${levelLabel('measure')}」で計算してください。`,
  measure:
    `「${levelLabel('measure')}」の記録: つながり方が違う分子（異性体）どうしでも、` +
    'どちらが安定かの順は、これまで試した組ではすべて合っています。' +
    'ただし差の大きさは実際より小さく出ることがあります。',
};

/** The caveats for the levels the tree holds, in the order the levels are offered. */
export function isomerCaveats(levels: readonly (ModelLevel | null)[]): string[] {
  return LEVEL_ORDER.filter((level) => levels.includes(level)).map((level) => ISOMER_CAVEATS[level]);
}

export const NOT_KEPT_NOTICE =
  'このブラウザには記録が残りません（タブを閉じると消えます）。必要ならファイルに書き出してください。';

/**
 * The records column's own words (V5-8): its heading and what each button does.
 * The icon buttons carry theirs as `aria-label` and `title`.
 */
export const EXPLORER_WORDS = {
  heading: '記録',
  fold: '記録の欄をたたむ',
  unfold: '記録の欄をひらく',
  exportAll: '書き出す',
  importFile: '読み込む',
  more: 'ほかの操作',
  clear: '全部消す',
  moleculeMore: 'この分子の操作',
  exportMolecule: 'この分子だけ書き出す',
  deleteMolecule: 'この分子の記録を消す',
  levelMore: 'この段の操作',
  deleteLevel: 'この段の記録を消す',
  foldValley: '同じ形をたたむ',
  unfoldValley: '同じ形をひらく',
  open: 'この形を開く',
  replay: '緩和を再生',
  rename: '名前を変える',
  remove: '削除',
  cancelCandidate: '中止',
  cancelAll: 'すべて中止',
  clearFinished: '終わった候補を消す',
  running: '計算中の候補があります',
} as const;

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

/** What a group with an unknown level is filed under, in place of a level. */
export const OTHER_LEVEL = 'ほかの計算';

/**
 * The tree's words (`records/tree.ts`). A molecule node is its formula with the
 * count beside it, small; a level node is the name of the level with
 * `8 · 2 種類の形` beside it; a valley is its first record's name and
 * difference (`relativeText`) with how many found it, `×5`.
 */
export function formulaMeta(node: FormulaNode): string {
  return String(node.count);
}

export function levelHeading(level: ModelLevel | null): string {
  return level === null ? OTHER_LEVEL : levelLabel(level);
}

/** Nothing for a level that holds only the search's candidates so far. */
export function levelMeta(group: LogGroup | null): string {
  if (group === null) return '';
  const shapes = group.valleys >= 2 ? ` · ${group.valleys} 種類の形` : '';
  return `${group.entries.length}${shapes}`;
}

/**
 * What deleting from a molecule's or a level's menu takes away (V6-2), as the
 * confirmation names it: the molecule, or the molecule and the level in the
 * words of the choice. The molecule is its heading, so an ion is named with its
 * charge (H₃O⁺, v7). Two levels that read the same in the tree (models this
 * program does not know) read the same here; the count in `deleteConfirm` tells
 * them apart.
 */
export function deleteWhat(molecule: FormulaNode, level?: LevelNode): string {
  return level === undefined
    ? `${molecule.formula} `
    : `${molecule.formula} の「${levelHeading(level.level)}」`;
}

export function deleteConfirm(what: string, count: number): string {
  return `${what}の記録を ${count} 件消します。よろしいですか？`;
}

export function valleySizeText(node: ValleyNode): string {
  return `×${1 + node.rest.length}`;
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

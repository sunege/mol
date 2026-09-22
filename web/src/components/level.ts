/**
 * The words of the choice every calculation starts with: what it is for.
 *
 * There are two, and they are named for their purpose - seeing which shape a
 * molecule settles into, or reading its angles as numbers - with how long each
 * takes beside it. How each one is solved is the engine's business
 * (requirement F4): nothing here names a basis, a functional, a charge or a
 * multiplicity. Nor are they called higher and lower accuracy, because the
 * slower one is not better at everything once measured, and every result here
 * is approximate anyway (`docs/plan-v3.md`).
 *
 * The choice belongs to one calculation, not to the app, and it cannot change
 * while one runs: the answer arriving would then be at a level that is no
 * longer the one chosen. Results at different levels are never compared
 * (`ModelLevel`), which is why the panel says which one the numbers on screen
 * came from.
 */
import type { ModelLevel } from '../worker/protocol';

interface LevelWords {
  /** What the button says. These two names are decided; do not reword them. */
  label: string;
  /** What it is for, as a phrase the hint ends a sentence with. */
  purpose: string;
  /**
   * Roughly how long it takes, for the molecules this app is for. Benzene is
   * the long end: about two minutes when measuring (V3-8 measures it properly
   * and rewrites this).
   */
  time: string;
}

const WORDS: Record<ModelLevel, LevelWords> = {
  shape: { label: '形を探す', purpose: 'どんな形に落ち着くかを見る', time: '数秒' },
  measure: { label: '形を測る', purpose: '結合の角度を数値として読む', time: '数十秒〜数分' },
};

/** The levels in the order the panel shows them. */
export const LEVEL_ORDER: readonly ModelLevel[] = ['shape', 'measure'];

/** What a calculation is for until the user says otherwise. */
export const DEFAULT_LEVEL: ModelLevel = 'shape';

/** The name of the group of buttons, for a screen reader. */
export const LEVEL_GROUP_LABEL = '計算の目的';

export function levelLabel(level: ModelLevel): string {
  return WORDS[level].label;
}

/** The line under the choice: what the chosen level is for, and how long it takes. */
export function levelHint(level: ModelLevel): string {
  const { purpose, time } = WORDS[level];
  return `${purpose}ための計算です。かかる時間の目安は${time}です。`;
}

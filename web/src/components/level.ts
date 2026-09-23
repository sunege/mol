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
   * Roughly how long it takes, for the molecules this app is for, and measured
   * rather than guessed (`docs/dev-notes.md`, "v3 の実測"). Water is a second
   * either way; benzene is the long end, fourteen seconds to find its shape and
   * three minutes to measure it, and a structure that starts far from its shape
   * is longer still - four and a half minutes for a hand-built C3H6.
   *
   * Only small molecules are done in seconds, which is why finding the shape
   * says 数十秒 too.
   */
  time: string;
}

const WORDS: Record<ModelLevel, LevelWords> = {
  shape: { label: '形を探す', purpose: 'どんな形に落ち着くかを見る', time: '数秒〜数十秒' },
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

/**
 * A second line, when pressing the button now would be the slow way round, or
 * null when there is nothing worth saying.
 *
 * What a measurement costs is decided by how many times the structure has to
 * move, more than by how large the molecule is: a hand-built C3H6 took 72 moves
 * and four and a half minutes to measure, longer than benzene's own five moves
 * and three minutes. Finding its shape first and then measuring that shape took
 * two minutes for both together, because the second relaxation starts next to
 * its answer (`docs/dev-notes.md`, "v3 の実測").
 *
 * So it is said only for a structure the user built or edited, and only while
 * measuring is what the next calculation is for. A preset, a structure from the
 * log, and the shape a relaxation has just found are all near a minimum
 * already, and nobody is told to go round again. It is advice and not a
 * warning: the measurement is the same one either way, and the button is not
 * held back (`docs/v3/V3-8.md`).
 */
export function levelAdvice(level: ModelLevel, handBuilt: boolean): string | null {
  if (level !== 'measure' || !handBuilt) return null;
  return `手で作った形は、先に「${WORDS.shape.label}」で落ち着かせてから測ると早く終わります。`;
}

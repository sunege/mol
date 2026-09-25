/**
 * The main buttons, as two tables (V5-2, split in V6-3).
 *
 * The two that start a calculation live in the calculate tab, under 次の計算:
 * the tab reads top to bottom as "place the atoms, choose the level, run".
 * The two that stop one sit at the top of the panel, and only while something
 * is computing - starting a calculation moves the panel to the observe tab,
 * so a stop in the calculate tab would be out of sight.
 *
 * | state                     | run (calculate tab)       | stop (top of the panel) |
 * | ------------------------- | ------------------------- | ----------------------- |
 * | not computing             | 安定な形にする · この形のまま計算 | none                    |
 * | computing                 | both off                  | 中止 · すぐ止める (off)   |
 * | stopping after the step   | both off                  | 止めています… (off) · すぐ止める |
 *
 * The stops are two fixed slots whose labels change with the state, rather
 * than buttons that come and go: すぐ止める is there, off, from the start, so
 * nothing moves when 中止 is pressed (a button that cannot be used is disabled,
 * not removed). `stop` is one handler in the App: the first press asks a
 * relaxation to stop after its step, the second stops it at once, and a single
 * point is simply cancelled. So すぐ止める is the same action as 中止, pressed
 * again.
 *
 * Nothing can be pressed without an engine or without atoms, whatever else is
 * going on - the same two conditions the buttons have always had.
 *
 * Both jobs that hand the atoms to the engine are drawn as run buttons (green,
 * with a ▶), the same as every other button in the panel that starts a DFT
 * calculation (`RunButton` in `controls.tsx`), so what will set the engine
 * going reads at a glance. The stops are plain.
 */

export type MainAction = 'relax' | 'calculate' | 'stop';

export interface ActionSlot {
  label: string;
  action: MainAction;
  disabled: boolean;
  /** Hands the atoms to the engine: drawn as a run button (`.btn.run`). */
  runs: boolean;
}

export interface ActionState {
  computing: boolean;
  /** The user asked a relaxation to stop, and it is finishing its step. */
  stopping: boolean;
  /** No engine to run on (unsupported browser, failed start). */
  unavailable: boolean;
  atomCount: number;
}

/** The two buttons under 次の計算 in the calculate tab. */
export function runSlots({
  computing,
  unavailable,
  atomCount,
}: Omit<ActionState, 'stopping'>): [ActionSlot, ActionSlot] {
  const disabled = unavailable || atomCount === 0 || computing;
  return [
    { label: '安定な形にする', action: 'relax', disabled, runs: true },
    { label: 'この形のまま計算', action: 'calculate', disabled, runs: true },
  ];
}

/** The two stops at the top of the panel, or null when nothing is computing. */
export function stopSlots({
  computing,
  stopping,
  unavailable,
  atomCount,
}: ActionState): [ActionSlot, ActionSlot] | null {
  if (!computing) return null;
  const blocked = unavailable || atomCount === 0;
  if (stopping) {
    return [
      { label: '止めています…', action: 'stop', disabled: true, runs: false },
      { label: 'すぐ止める', action: 'stop', disabled: blocked, runs: false },
    ];
  }
  return [
    { label: '中止', action: 'stop', disabled: blocked, runs: false },
    { label: 'すぐ止める', action: 'stop', disabled: true, runs: false },
  ];
}

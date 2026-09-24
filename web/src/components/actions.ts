/**
 * The two main buttons at the top of the panel (V5-2), as a table.
 *
 * They are two fixed slots whose labels and jobs change with the state, rather
 * than buttons that come and go: 中止 lands under the pointer that pressed
 * 安定な形にする, and nothing around the pair moves when a calculation starts
 * or ends. Which job each slot does is the same as it always was - only where
 * it sits is new:
 *
 * | state                     | left                | right                |
 * | ------------------------- | ------------------- | -------------------- |
 * | not computing             | 安定な形にする (relax) | この形のまま計算       |
 * | computing                 | 中止 (stop)          | この形のまま計算 (off) |
 * | stopping after the step   | 止めています… (off)   | すぐ止める (stop)      |
 *
 * `stop` is one handler in the App: the first press asks a relaxation to stop
 * after its step, the second stops it at once, and a single point is simply
 * cancelled. So "すぐ止める" is the same action as "中止", pressed again.
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

export function actionSlots({
  computing,
  stopping,
  unavailable,
  atomCount,
}: ActionState): [ActionSlot, ActionSlot] {
  const blocked = unavailable || atomCount === 0;
  if (!computing) {
    return [
      { label: '安定な形にする', action: 'relax', disabled: blocked, runs: true },
      { label: 'この形のまま計算', action: 'calculate', disabled: blocked, runs: true },
    ];
  }
  if (stopping) {
    return [
      { label: '止めています…', action: 'stop', disabled: true, runs: false },
      { label: 'すぐ止める', action: 'stop', disabled: blocked, runs: false },
    ];
  }
  return [
    { label: '中止', action: 'stop', disabled: blocked, runs: false },
    { label: 'この形のまま計算', action: 'calculate', disabled: true, runs: true },
  ];
}

/**
 * The one line along the bottom of the 3D view that says what the pointer does
 * there.
 *
 * It follows the tab (= the viewer's mode) rather than living in the panel,
 * because it describes the view, not the panel. The panel keeps only what
 * changes with what is picked (`pickingHint` in `observe.ts`).
 *
 * One line each, no line breaks: the strip is a single line over the canvas and
 * must not grow up into the molecule.
 */
import type { ViewerMode } from '../scene/gestures';

/** An empty view in the edit tab: how to begin, not how to edit. */
export const START_HINT = '何もない場所をクリックすると原子を置けます。プリセットからも始められます。';

/** An empty view in the observe tab: nothing to pick, so say where atoms come from. */
export const EMPTY_OBSERVE_HINT = '原子がありません · 「計算」タブで置けます';

export const EDIT_HINT = 'クリックで配置 · ドラッグで移動 · Shift+クリックで隣に結合 · 背景のドラッグで回転';

export const OBSERVE_HINT = 'クリックで選ぶ · もう一度で外す · ドラッグで回転 · Esc で解除';

export function viewportHint(mode: ViewerMode, atomCount: number): string {
  if (mode === 'edit') return atomCount === 0 ? START_HINT : EDIT_HINT;
  return atomCount === 0 ? EMPTY_OBSERVE_HINT : OBSERVE_HINT;
}

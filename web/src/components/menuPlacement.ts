/**
 * Where the "…" list of `MoreMenu` goes on the screen (V6-11).
 *
 * The list is drawn `position: fixed` and not under its button: the records
 * tree scrolls in a box of its own (`overflow-y: auto`), and a list that hung
 * out of the bottom of that box was cut off there, behind the caveats under
 * the tree - which no z-index can fix, the box clips it. So the list is placed
 * against the viewport: under the button with its right edge on the button's,
 * above the button when there is no room under it (and more above), and
 * pushed back inside the window at the sides.
 */

export interface Rect {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Placement {
  top: number;
  left: number;
}

/** The gap between the button and the list, as the old `margin-top`. */
export const MENU_GAP = 4;
/** The least distance kept between the list and the window's edges. */
export const MENU_MARGIN = 8;

export function placeMenu(button: Rect, menu: Size, viewport: Size): Placement {
  const below = viewport.height - MENU_MARGIN - (button.bottom + MENU_GAP);
  const above = button.top - MENU_GAP - MENU_MARGIN;
  const up = menu.height > below && above > below;
  const top = up ? button.top - MENU_GAP - menu.height : button.bottom + MENU_GAP;
  const left = clamp(button.right - menu.width, MENU_MARGIN, viewport.width - MENU_MARGIN - menu.width);
  return { top: Math.max(MENU_MARGIN, top), left };
}

/** `lo` wins when the window is narrower than the list: its left edge shows. */
function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(value, hi));
}

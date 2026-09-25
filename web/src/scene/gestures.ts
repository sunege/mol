/**
 * What a pointer gesture or a key means, in each mode of the 3D view.
 *
 * The viewer only works out the facts - which atom, if any, is under the
 * pointer, and whether Shift is held - and asks here what to do with them, so
 * the rules can be read and tested without a WebGL context.
 *
 * A gesture is decided twice: once when the button goes down, because a drag
 * that starts on an atom has to take the pointer away from the camera controls
 * before they start orbiting, and once when it comes back up without having
 * moved, which is a click.
 */

/**
 * `edit` builds the molecule. `observe` is for showing it to a class: nothing
 * a stray click or drag does there changes the structure - which, while a
 * calculation runs, would also throw the calculation away - and clicking atoms
 * picks them for measuring instead.
 */
export type ViewerMode = 'edit' | 'observe';

/** A world axis. The handles move the selected atom along X, Y or Z only. */
export type Axis = 'x' | 'y' | 'z';

/**
 * An axis handle under the pointer: which axis, and whose handle it is (the
 * selected atom's). The viewer tests the handles before the atoms, since they
 * are drawn in front of their atom and behind it too.
 */
export interface HandleHit {
  axis: Axis;
  index: number;
}

/** What pressing the button starts. */
export type PressAction =
  /** The atom follows the pointer; the camera stays put. */
  | { kind: 'drag'; index: number }
  /** The atom moves along one world axis only, following the pointer's ray. */
  | { kind: 'axisDrag'; index: number; axis: Axis }
  /** The camera controls get the gesture: dragging rotates the view. */
  | { kind: 'orbit' };

/** What a click (press and release without moving) does. */
export type ClickAction =
  /** Place a new atom where empty space was clicked. */
  | { kind: 'place' }
  /** Place a new atom bonded to this one, on the side that was clicked. */
  | { kind: 'attach'; index: number }
  /** Select this atom. */
  | { kind: 'select'; index: number }
  /** Add this atom to the ones being measured, or take it out. */
  | { kind: 'measure'; index: number }
  | { kind: 'none' };

/** What a key does. `null` leaves the key to the browser. */
export type KeyAction = 'delete' | 'deselect' | 'clearMeasured' | null;

/**
 * @param hit the atom under the pointer when the button went down, or `null`
 *   for empty space
 * @param handle the axis handle under the pointer, if any. It wins over `hit`:
 *   the handle sits over its own atom, so a press there would otherwise drag
 *   the atom in the screen plane.
 */
export function pressAction(
  mode: ViewerMode,
  hit: number | null,
  shift: boolean,
  handle: HandleHit | null = null,
): PressAction {
  // In observe mode even a drag that starts on an atom turns the view: the
  // molecule is being shown, and moving an atom would be an edit. The viewer
  // draws no handles there, but a stale one must not move anything either.
  if (mode === 'observe') return { kind: 'orbit' };
  // Shift does not matter on a handle: it has no atom to bond to.
  if (handle !== null) return { kind: 'axisDrag', index: handle.index, axis: handle.axis };
  // Shift turns a click on an atom into "bond a new one here", so it must not
  // start dragging the atom it is aimed at.
  if (hit !== null && !shift) return { kind: 'drag', index: hit };
  return { kind: 'orbit' };
}

/**
 * @param hit the atom under the pointer when the button went down, or `null`
 *   for empty space
 * @param handle the axis handle under the pointer when the button went down
 */
export function clickAction(
  mode: ViewerMode,
  hit: number | null,
  shift: boolean,
  handle: HandleHit | null = null,
): ClickAction {
  // A handle pressed and let go without moving is a drag that went nowhere.
  // It is not empty space: placing an atom there would surprise.
  if (handle !== null) return { kind: 'none' };
  if (mode === 'observe') {
    // Empty space and Shift do nothing here: both add atoms in edit mode, and
    // a click that silently did something else would be worse than none.
    if (hit === null || shift) return { kind: 'none' };
    return { kind: 'measure', index: hit };
  }
  if (hit === null) return { kind: 'place' };
  if (shift) return { kind: 'attach', index: hit };
  return { kind: 'select', index: hit };
}

/** `key` is `KeyboardEvent.key`. */
export function keyAction(mode: ViewerMode, key: string): KeyAction {
  switch (key) {
    case 'Delete':
    case 'Backspace':
      return mode === 'edit' ? 'delete' : null;
    case 'Escape':
      return mode === 'edit' ? 'deselect' : 'clearMeasured';
    default:
      return null;
  }
}

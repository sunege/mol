import { describe, expect, it } from 'vitest';
import { clickAction, keyAction, pressAction } from './gestures';

// Every combination the viewer can report, so a change to one rule cannot
// quietly change another.
const ATOM = 3;

describe('edit mode (building a molecule)', () => {
  // These pin the behaviour the app had before there were modes at all.
  it('drags an atom pressed without Shift, and orbits otherwise', () => {
    expect(pressAction('edit', ATOM, false)).toEqual({ kind: 'drag', index: ATOM });
    expect(pressAction('edit', ATOM, true)).toEqual({ kind: 'orbit' });
    expect(pressAction('edit', null, false)).toEqual({ kind: 'orbit' });
    expect(pressAction('edit', null, true)).toEqual({ kind: 'orbit' });
  });

  it('places on empty space, selects an atom, and bonds to one with Shift', () => {
    expect(clickAction('edit', null, false)).toEqual({ kind: 'place' });
    // Shift over empty space has no atom to bond to, so it is a plain placement.
    expect(clickAction('edit', null, true)).toEqual({ kind: 'place' });
    expect(clickAction('edit', ATOM, false)).toEqual({ kind: 'select', index: ATOM });
    expect(clickAction('edit', ATOM, true)).toEqual({ kind: 'attach', index: ATOM });
  });

  it('deletes with Delete or Backspace and deselects with Escape', () => {
    expect(keyAction('edit', 'Delete')).toBe('delete');
    expect(keyAction('edit', 'Backspace')).toBe('delete');
    expect(keyAction('edit', 'Escape')).toBe('deselect');
    expect(keyAction('edit', 'a')).toBeNull();
  });
});

describe('observe mode (showing a molecule)', () => {
  it('orbits whatever the drag starts on, so no atom can be moved', () => {
    for (const hit of [ATOM, null]) {
      for (const shift of [false, true]) {
        expect(pressAction('observe', hit, shift)).toEqual({ kind: 'orbit' });
      }
    }
  });

  it('picks a clicked atom for measuring', () => {
    expect(clickAction('observe', ATOM, false)).toEqual({ kind: 'measure', index: ATOM });
  });

  it('adds nothing: empty space and Shift+click do nothing', () => {
    expect(clickAction('observe', null, false)).toEqual({ kind: 'none' });
    expect(clickAction('observe', null, true)).toEqual({ kind: 'none' });
    expect(clickAction('observe', ATOM, true)).toEqual({ kind: 'none' });
  });

  it('never deletes, and Escape clears the measurement', () => {
    expect(keyAction('observe', 'Delete')).toBeNull();
    expect(keyAction('observe', 'Backspace')).toBeNull();
    expect(keyAction('observe', 'Escape')).toBe('clearMeasured');
  });

  it('never produces an action that changes the molecule', () => {
    const edits = new Set(['drag', 'place', 'attach']);
    for (const hit of [ATOM, null]) {
      for (const shift of [false, true]) {
        expect(edits.has(pressAction('observe', hit, shift).kind)).toBe(false);
        expect(edits.has(clickAction('observe', hit, shift).kind)).toBe(false);
      }
    }
    expect(keyAction('observe', 'Delete')).not.toBe('delete');
  });
});

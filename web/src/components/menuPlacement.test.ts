import { describe, expect, it } from 'vitest';
import { MENU_GAP, MENU_MARGIN, placeMenu } from './menuPlacement';

const viewport = { width: 1366, height: 768 };
const menu = { width: 170, height: 90 };
/** A "…" button in the records column, 24px square. */
const at = (top: number, right = 220) => ({ top, bottom: top + 24, left: right - 24, right });

describe('placeMenu', () => {
  it('drops the list under the button, right edges together', () => {
    const button = at(100);
    const place = placeMenu(button, menu, viewport);
    expect(place.top).toBe(button.bottom + MENU_GAP);
    expect(place.left + menu.width).toBe(button.right);
  });

  it('opens upward near the bottom of the window, ending above the button', () => {
    const button = at(700);
    const place = placeMenu(button, menu, viewport);
    expect(place.top + menu.height).toBe(button.top - MENU_GAP);
  });

  it('stays under the button while the list still fits there', () => {
    const button = at(viewport.height - MENU_MARGIN - MENU_GAP - menu.height - 24);
    expect(placeMenu(button, menu, viewport).top).toBe(button.bottom + MENU_GAP);
  });

  it('stays under when there is even less room above', () => {
    const place = placeMenu(at(20), { width: 170, height: 900 }, viewport);
    expect(place.top).toBe(20 + 24 + MENU_GAP);
  });

  it('never leaves the window at the top or the sides', () => {
    const tall = { width: 170, height: 760 };
    expect(placeMenu(at(700), tall, viewport).top).toBeGreaterThanOrEqual(MENU_MARGIN);
    expect(placeMenu(at(100, 60), menu, viewport).left).toBe(MENU_MARGIN);
    expect(placeMenu(at(100, 2000), menu, viewport).left + menu.width).toBe(
      viewport.width - MENU_MARGIN,
    );
  });
});

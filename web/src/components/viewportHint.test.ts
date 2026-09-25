import { describe, expect, it } from 'vitest';
import type { ViewerMode } from '../scene/gestures';
import { EDIT_HINT, OBSERVE_HINT, START_HINT, viewportHint } from './viewportHint';

const MODES: ViewerMode[] = ['edit', 'observe'];

describe('the line under the 3D view', () => {
  it('tells an empty edit view how to begin', () => {
    expect(viewportHint('edit', 0)).toBe(START_HINT);
    expect(START_HINT).toContain('プリセット');
  });

  it('describes editing once there is something to edit', () => {
    expect(viewportHint('edit', 1)).toBe(EDIT_HINT);
    expect(viewportHint('edit', 12)).toBe(EDIT_HINT);
  });

  it('mentions the axis arrows in the edit tab only', () => {
    expect(EDIT_HINT).toContain('矢印');
    expect(OBSERVE_HINT).not.toContain('矢印');
    // One clause longer than before the arrows, not a second line's worth.
    expect(EDIT_HINT.length).toBeLessThanOrEqual(60);
  });

  it('describes picking in the observe tab', () => {
    expect(viewportHint('observe', 1)).toBe(OBSERVE_HINT);
    expect(viewportHint('observe', 12)).toBe(OBSERVE_HINT);
  });

  it('does not talk about picking atoms that are not there', () => {
    expect(viewportHint('observe', 0)).not.toBe(OBSERVE_HINT);
    expect(viewportHint('observe', 0)).toContain('計算');
  });

  it('is one line whatever the tab and however many atoms', () => {
    for (const mode of MODES) {
      for (const count of [0, 1, 3]) {
        const line = viewportHint(mode, count);
        expect(line.length).toBeGreaterThan(0);
        expect(line).not.toMatch(/[\r\n]/);
      }
    }
  });

  it('differs between the tabs', () => {
    expect(viewportHint('edit', 0)).not.toBe(viewportHint('observe', 0));
    expect(viewportHint('edit', 3)).not.toBe(viewportHint('observe', 3));
  });
});

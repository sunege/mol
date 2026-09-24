import { describe, expect, it } from 'vitest';
import { actionSlots, type ActionState } from './actions';

const idle: ActionState = { computing: false, stopping: false, unavailable: false, atomCount: 3 };

describe('the two main buttons', () => {
  it('relaxes on the left and calculates as it is on the right, when nothing runs', () => {
    const [left, right] = actionSlots(idle);
    expect(left).toEqual({
      label: '安定な形にする',
      action: 'relax',
      disabled: false,
      runs: true,
    });
    expect(right).toEqual({
      label: 'この形のまま計算',
      action: 'calculate',
      disabled: false,
      runs: true,
    });
  });

  it('stops on the left while computing, with the right held', () => {
    const [left, right] = actionSlots({ ...idle, computing: true });
    expect(left).toMatchObject({ label: '中止', action: 'stop', disabled: false });
    expect(right).toMatchObject({ label: 'この形のまま計算', action: 'calculate', disabled: true });
  });

  it('moves the stop to the right, as すぐ止める, once a stop has been asked for', () => {
    const [left, right] = actionSlots({ ...idle, computing: true, stopping: true });
    expect(left).toMatchObject({ label: '止めています…', disabled: true });
    expect(right).toMatchObject({ label: 'すぐ止める', action: 'stop', disabled: false });
  });

  it('draws every slot that starts a calculation as a run button, and no stop', () => {
    const states = [
      idle,
      { ...idle, computing: true },
      { ...idle, computing: true, stopping: true },
    ];
    for (const slot of states.flatMap((state) => actionSlots(state))) {
      expect(slot.runs).toBe(slot.action !== 'stop');
    }
  });

  it('keeps both slots, disabled, without an engine or without atoms', () => {
    for (const state of [
      { ...idle, unavailable: true },
      { ...idle, atomCount: 0 },
    ]) {
      const slots = actionSlots(state);
      expect(slots).toHaveLength(2);
      expect(slots.every((slot) => slot.disabled)).toBe(true);
    }
  });

  it('ignores stopping when nothing is computing', () => {
    expect(actionSlots({ ...idle, stopping: true })).toEqual(actionSlots(idle));
  });
});

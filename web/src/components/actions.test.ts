import { describe, expect, it } from 'vitest';
import { runSlots, stopSlots, type ActionState } from './actions';

const idle: ActionState = { computing: false, stopping: false, unavailable: false, atomCount: 3 };

describe('the two run buttons', () => {
  it('relaxes on the left and calculates as it is on the right', () => {
    const [left, right] = runSlots(idle);
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

  it('holds both, in place, while computing', () => {
    for (const state of [
      { ...idle, computing: true },
      { ...idle, computing: true, stopping: true },
    ]) {
      const slots = runSlots(state);
      expect(slots.map((slot) => slot.label)).toEqual(['安定な形にする', 'この形のまま計算']);
      expect(slots.every((slot) => slot.disabled)).toBe(true);
    }
  });

  it('keeps both, disabled, without an engine or without atoms', () => {
    for (const state of [
      { ...idle, unavailable: true },
      { ...idle, atomCount: 0 },
    ]) {
      const slots = runSlots(state);
      expect(slots).toHaveLength(2);
      expect(slots.every((slot) => slot.disabled)).toBe(true);
    }
  });
});

describe('the two stop buttons', () => {
  it('are not there when nothing is computing, even if a stop was asked for', () => {
    expect(stopSlots(idle)).toBeNull();
    expect(stopSlots({ ...idle, stopping: true })).toBeNull();
  });

  it('stop on the left while computing, with すぐ止める already on the right, held', () => {
    const [left, right] = stopSlots({ ...idle, computing: true })!;
    expect(left).toMatchObject({ label: '中止', action: 'stop', disabled: false });
    expect(right).toMatchObject({ label: 'すぐ止める', action: 'stop', disabled: true });
  });

  it('move the stop to the right, as すぐ止める, once a stop has been asked for', () => {
    const [left, right] = stopSlots({ ...idle, computing: true, stopping: true })!;
    expect(left).toMatchObject({ label: '止めています…', disabled: true });
    expect(right).toMatchObject({ label: 'すぐ止める', action: 'stop', disabled: false });
  });

  it('are drawn plain, never as run buttons', () => {
    for (const state of [
      { ...idle, computing: true },
      { ...idle, computing: true, stopping: true },
    ]) {
      for (const slot of stopSlots(state)!) {
        expect(slot).toMatchObject({ action: 'stop', runs: false });
      }
    }
  });

  it('keep both slots, disabled, without an engine or without atoms', () => {
    for (const state of [
      { ...idle, computing: true, unavailable: true },
      { ...idle, computing: true, atomCount: 0 },
      { ...idle, computing: true, stopping: true, atomCount: 0 },
    ]) {
      const slots = stopSlots(state)!;
      expect(slots).toHaveLength(2);
      expect(slots.every((slot) => slot.disabled)).toBe(true);
    }
  });
});

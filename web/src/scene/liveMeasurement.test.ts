import { describe, expect, it } from 'vitest';
import { LiveMeasurement, sameReadout } from './liveMeasurement';

describe('LiveMeasurement', () => {
  it('tells its listeners when the readout changes, and hands back the new value', () => {
    const store = new LiveMeasurement();
    let calls = 0;
    store.subscribe(() => calls++);
    expect(store.get()).toBeNull();

    store.set({ kind: 'distance', value: 1.54 });
    expect(calls).toBe(1);
    expect(store.get()).toEqual({ kind: 'distance', value: 1.54 });

    store.set({ kind: 'distance', value: 1.512 });
    expect(calls).toBe(2);
    store.set(null);
    expect(calls).toBe(3);
    expect(store.get()).toBeNull();
  });

  it('stays quiet, and keeps the same object, while the shown digits do not change', () => {
    // An animation writes on every frame; most frames move a value by less
    // than its last shown digit.
    const store = new LiveMeasurement();
    let calls = 0;
    store.subscribe(() => calls++);
    store.set({ kind: 'distance', value: 1.5401 });
    const first = store.get();
    store.set({ kind: 'distance', value: 1.5404 });
    store.set({ kind: 'distance', value: 1.53951 });
    expect(calls).toBe(1);
    expect(store.get()).toBe(first);
    store.set(null);
    store.set(null);
    expect(calls).toBe(2);
  });

  it('stops calling a listener that unsubscribed', () => {
    const store = new LiveMeasurement();
    let calls = 0;
    const unsubscribe = store.subscribe(() => calls++);
    unsubscribe();
    store.set({ kind: 'angle', value: 104.5 });
    expect(calls).toBe(0);
  });
});

describe('sameReadout', () => {
  it('compares what would be shown, kind included', () => {
    expect(sameReadout(null, null)).toBe(true);
    expect(sameReadout(null, { kind: 'angle', value: 90 })).toBe(false);
    expect(sameReadout({ kind: 'angle', value: 90.01 }, { kind: 'angle', value: 89.99 })).toBe(true);
    expect(sameReadout({ kind: 'angle', value: 90 }, { kind: 'dihedral', value: 90 })).toBe(false);
    expect(sameReadout({ kind: 'dihedral', value: null }, { kind: 'dihedral', value: null })).toBe(
      true,
    );
    // The same angle, written the same way.
    expect(sameReadout({ kind: 'dihedral', value: -179.99 }, { kind: 'dihedral', value: 180 })).toBe(
      true,
    );
  });
});

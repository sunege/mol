import { formatValue, type Measurement } from './measure';

/**
 * The measurement on screen, for the panel to show next to the 3D label.
 *
 * The viewer is the one place that knows the positions actually drawn - while
 * an animation plays they are interpolated frames that never reach React - so
 * it writes here on every update and the panel reads with
 * `useSyncExternalStore`. Listeners hear about a change only when the readout
 * would be written differently, so a structure creeping by less than the last
 * digit does not re-render anything.
 */
export class LiveMeasurement {
  #value: Measurement | null = null;
  #listeners = new Set<() => void>();

  /** For `useSyncExternalStore`. The same object comes back until the readout changes. */
  get = (): Measurement | null => this.#value;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  set(next: Measurement | null) {
    if (sameReadout(this.#value, next)) return;
    this.#value = next;
    for (const listener of this.#listeners) listener();
  }
}

/** Whether two measurements would be shown identically. */
export function sameReadout(a: Measurement | null, b: Measurement | null): boolean {
  if (a === null || b === null) return a === b;
  return a.kind === b.kind && formatValue(a.kind, a.value) === formatValue(b.kind, b.value);
}

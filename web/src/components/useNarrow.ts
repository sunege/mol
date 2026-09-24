/**
 * Whether the screen is too narrow for the records column (V5-10).
 *
 * The same 720px as the `@media (max-width: 720px)` blocks in `App.css`, so
 * the App puts the records in the sheet exactly when the CSS has turned the
 * panel into one. Read through `useSyncExternalStore`, so the first render is
 * already right and a resize across the line re-renders at once.
 */
import { useSyncExternalStore } from 'react';

export const NARROW_QUERY = '(max-width: 720px)';

function subscribe(onChange: () => void): () => void {
  const list = window.matchMedia(NARROW_QUERY);
  list.addEventListener('change', onChange);
  return () => list.removeEventListener('change', onChange);
}

function isNarrow(): boolean {
  return window.matchMedia(NARROW_QUERY).matches;
}

export function useNarrow(): boolean {
  return useSyncExternalStore(subscribe, isNarrow, () => false);
}

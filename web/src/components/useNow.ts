/**
 * The `performance.now()` clock, re-read every tick while something is running.
 *
 * The same idea as the progress card's: only the part of the screen showing a
 * time re-renders for it. The search's candidates tick in the records column
 * (V5-9), so the clock lives there and not in the App, which would otherwise
 * redraw everything ten times a second.
 */
import { useEffect, useState } from 'react';

/** How often a running clock is redrawn. */
const TICK_MS = 100;

export function useNow(running: boolean): number {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    if (!running) return;
    const tick = () => setNow(performance.now());
    tick();
    const handle = setInterval(tick, TICK_MS);
    return () => clearInterval(handle);
  }, [running]);
  return now;
}

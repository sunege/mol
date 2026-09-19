/**
 * The card over the 3D view that says what a running calculation is doing.
 *
 * It sits where the user is looking - on the molecule, which for the first
 * seconds of a large calculation does not move at all - rather than in the
 * panel. The words come from `progress.ts`; this file only lays them out and
 * keeps the clock running.
 */
import { useEffect, useState } from 'react';
import { checklist, formatElapsed, headline, type JobState } from './progress';

/**
 * A surface cut on its own - the first one for a channel, which samples the
 * density - is not announced until it has taken this long. Most take a few
 * milliseconds, and a card that flashes up and away reads as a glitch.
 */
const SURFACE_ONLY_DELAY_MS = 300;

/** How often the elapsed time is redrawn. */
const TICK_MS = 100;

/**
 * The `performance.now()` clock, re-read every tick while `running`.
 *
 * Only the components that show a time use it, so the rest of the app does not
 * re-render ten times a second.
 */
function useNow(running: boolean): number {
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

/** Time since `since`, kept current. */
export function Elapsed({ since }: { since: number }) {
  const now = useNow(true);
  return <span className="elapsed">{formatElapsed(now - since)}</span>;
}

export interface ProgressOverlayProps {
  /** The calculation in progress, or null. */
  job: JobState | null;
  /**
   * When a surface began being cut outside any calculation (a channel shown for
   * the first time), or null.
   */
  surfaceSince: number | null;
}

export function ProgressOverlay({ job, surfaceSince }: ProgressOverlayProps) {
  const now = useNow(job !== null || surfaceSince !== null);

  if (job !== null) {
    return (
      <div className="progress-card">
        <div className="progress-head">
          <span className="spinner" aria-hidden="true" />
          {/* Only the sentence is announced: the clock changes ten times a
              second and would drown it out. */}
          <span className="progress-title" role="status">
            {headline(job)}
          </span>
          <span className="elapsed">{formatElapsed(now - job.startedAt)}</span>
        </div>
        <ol className="progress-steps">
          {checklist(job).map((item) => (
            <li key={item.id} className={item.state}>
              <span className="progress-mark" aria-hidden="true" />
              {item.label}
              {item.detail && <span className="progress-detail">{item.detail}</span>}
            </li>
          ))}
        </ol>
      </div>
    );
  }

  if (surfaceSince !== null && now - surfaceSince >= SURFACE_ONLY_DELAY_MS) {
    return (
      <div className="progress-card">
        <div className="progress-head">
          <span className="spinner" aria-hidden="true" />
          <span className="progress-title" role="status">
            電子の雲を描いています
          </span>
          <span className="elapsed">{formatElapsed(now - surfaceSince)}</span>
        </div>
      </div>
    );
  }

  return null;
}

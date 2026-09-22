/**
 * The search section of the panel: shapes being tried behind the one on screen.
 *
 * Everything here runs on workers of its own, so nothing in this section waits
 * on - or holds up - the relaxation the user started from the 計算 section. A
 * candidate that has finished is a record like any other, and 開く hands it to
 * the same place the log does.
 *
 * The elapsed times tick, so the clock is read here rather than in the App: a
 * re-render ten times a second belongs to this section alone.
 */
import { useEffect, useState } from 'react';
import type { Candidate } from '../search/pool';
import type { LogEntry } from '../records/log';
import {
  NUDGED_COUNT,
  SEARCH_EMPTY,
  SEARCH_HEADING,
  SEARCH_HINT,
  canCancel,
  canOpen,
  candidateName,
  depthText,
  searchDisabledReason,
  searchSummary,
  statusText,
} from './search';

/** How often the running candidates' clocks are redrawn. */
const TICK_MS = 100;

interface Props {
  candidates: Candidate[];
  /** The log entry of the record a settled candidate became, if there is one. */
  entryOf: (candidateId: string) => LogEntry | null;
  /** How many records of that candidate's molecule settled, for the comparison. */
  settledOf: (candidateId: string) => number;
  /** The record on screen, so the list can show which candidate it is. */
  openId: string | null;
  /** Atoms on screen: with none there is nothing to try. */
  atomCount: number;
  /** True when the engine will not run in this browser at all. */
  unavailable: boolean;
  onTryCurrent: () => void;
  onTryNudged: () => void;
  onOpen: (candidate: Candidate) => void;
  onCancel: (candidate: Candidate) => void;
  onCancelAll: () => void;
  onClearFinished: () => void;
}

export function SearchPanel({
  candidates,
  entryOf,
  settledOf,
  openId,
  atomCount,
  unavailable,
  onTryCurrent,
  onTryNudged,
  onOpen,
  onCancel,
  onCancelAll,
  onClearFinished,
}: Props) {
  const running = candidates.some(
    (candidate) => candidate.status === 'running' || candidate.status === 'waiting',
  );
  const now = useNow(running);
  const disabledReason = searchDisabledReason(atomCount);
  const disabled = unavailable || disabledReason !== null;
  const finished = candidates.filter((candidate) => !canCancel(candidate)).length;

  return (
    <>
      <h2>{SEARCH_HEADING}</h2>
      <div className="row">
        <button type="button" onClick={onTryCurrent} disabled={disabled}>
          今の形を試す
        </button>
        <button type="button" onClick={onTryNudged} disabled={disabled}>
          ゆらして {NUDGED_COUNT} 通り試す
        </button>
      </div>
      <p className="hint">{disabledReason ?? SEARCH_HINT}</p>

      {candidates.length === 0 ? (
        <p className="hint">{SEARCH_EMPTY}</p>
      ) : (
        <>
          <p className="search-summary" role="status">
            {searchSummary(candidates)}
          </p>
          <ul className="candidates">
            {candidates.map((candidate) => {
              const depth = depthText(candidate, entryOf(candidate.id), settledOf(candidate.id));
              const open = candidate.id === openId;
              return (
                <li key={candidate.id} className={open ? 'candidate open' : 'candidate'}>
                  <div className="candidate-row">
                    <span className="candidate-name">{candidateName(candidates, candidate)}</span>
                    <span className="candidate-status">{statusText(candidate, now)}</span>
                    {depth && <span className="candidate-depth">{depth}</span>}
                  </div>
                  <div className="candidate-actions">
                    {canOpen(candidate) && (
                      <button type="button" onClick={() => onOpen(candidate)}>
                        開く
                      </button>
                    )}
                    {canCancel(candidate) && (
                      <button type="button" onClick={() => onCancel(candidate)}>
                        中止
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
          <div className="row">
            <button type="button" onClick={onCancelAll} disabled={!running}>
              すべて中止
            </button>
            <button type="button" onClick={onClearFinished} disabled={finished === 0}>
              終わった行を消す
            </button>
          </div>
        </>
      )}
    </>
  );
}

/**
 * The `performance.now()` clock, re-read every tick while something is running.
 *
 * The same idea as the progress card's: only the part of the screen showing a
 * time re-renders for it.
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

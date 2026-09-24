/**
 * The search section of the panel: shapes being tried behind the one on screen.
 *
 * Everything here runs on workers of its own, so nothing in this section waits
 * on - or holds up - the relaxation the user started from the 計算 section. The
 * candidates themselves are rows of the records column (V5-9), where each turns
 * from waiting to running to the record it became; what stays here is how to
 * start them and one line on how the set is doing.
 */
import type { Candidate } from '../search/pool';
import { ActionGrid, RunButton } from './controls';
import {
  NUDGED_COUNT,
  SEARCH_HEADING,
  SEARCH_HINT,
  searchDisabledReason,
  searchSummary,
} from './search';

interface Props {
  candidates: Candidate[];
  /** Atoms on screen: with none there is nothing to try. */
  atomCount: number;
  /** True when the engine will not run in this browser at all. */
  unavailable: boolean;
  onTryCurrent: () => void;
  onTryNudged: () => void;
}

export function SearchPanel({
  candidates,
  atomCount,
  unavailable,
  onTryCurrent,
  onTryNudged,
}: Props) {
  const disabledReason = searchDisabledReason(atomCount);
  const disabled = unavailable || disabledReason !== null;
  const summary = searchSummary(candidates);

  return (
    <>
      <h2>{SEARCH_HEADING}</h2>
      <ActionGrid columns={2}>
        <RunButton onClick={onTryCurrent} disabled={disabled}>
          今の形を試す
        </RunButton>
        <RunButton onClick={onTryNudged} disabled={disabled}>
          ゆらして {NUDGED_COUNT} 通り試す
        </RunButton>
      </ActionGrid>
      {summary && (
        <p className="search-summary" role="status">
          {summary}
        </p>
      )}
      <p className="hint">{disabledReason ?? SEARCH_HINT}</p>
    </>
  );
}

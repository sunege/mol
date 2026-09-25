/**
 * The top of the panel, which never scrolls away (V5-2).
 *
 * "Is it done, and what is the energy" and "stop" used to sit at the far ends
 * of the panel - the state list at the very bottom, 3,000px down once an open
 * molecule's orbitals were showing. Here they are one block above the part
 * that scrolls: the state, how far the shape got, the total energy, and -
 * only while something is computing - the two stops as fixed slots
 * (`actions.ts`). The buttons that start a calculation are in the calculate
 * tab, under 次の計算 (V6-3): starting one moves the panel to the observe tab,
 * so the stops stay up here, where either tab can reach them.
 *
 * The state line keeps every branch it had (requirement F5): a calculation
 * that did not converge is `—`, "solved" is not "settled", and a stopped
 * relaxation says so. Its words are `status.ts`; this only lays them out.
 */
import { ActionGrid } from './controls';
import { Elapsed } from './ProgressOverlay';
import { headline, type JobState } from './progress';
import type { ActionSlot } from './actions';

export interface StatusHeaderProps {
  unavailable: boolean;
  error: string | null;
  computing: boolean;
  job: JobState | null;
  /** Frames of a relaxation are playing, before the job has reported. */
  relaxing: boolean;
  /** The state line once nothing runs (`describeOutcome`). */
  outcome: string;
  /** How far the shape got (`describeRelaxation`). */
  relaxation: string;
  /** Hartree, or null when there is no number to show (F5). */
  energy: number | null;
  /** The two stops (`stopSlots`), or null when nothing is computing. */
  stops: readonly [ActionSlot, ActionSlot] | null;
  onStop: () => void;
}

export function StatusHeader({
  unavailable,
  error,
  computing,
  job,
  relaxing,
  outcome,
  relaxation,
  energy,
  stops,
  onStop,
}: StatusHeaderProps) {
  return (
    <div className="panel-head">
      <h1>分子シミュレータ</h1>
      {/* Above the three lines rather than under them: those wrap as the
          engine reports ("12 回目の移動 · …"), and a slot under them would
          move away from the pointer that pressed it. */}
      {stops !== null && (
        <ActionGrid columns={2}>
          {stops.map((slot, i) => (
            // By position, not by action: the slot stays, its job changes.
            <button
              key={i}
              type="button"
              className="btn"
              onClick={onStop}
              disabled={slot.disabled}
            >
              {slot.label}
            </button>
          ))}
        </ActionGrid>
      )}
      <dl className="status">
        <dt>状態</dt>
        <dd>
          {unavailable ? (
            <span className="error">このブラウザでは計算できません</span>
          ) : error ? (
            <span className="error">{error}</span>
          ) : computing ? (
            job ? (
              <>
                {headline(job)} · <Elapsed since={job.startedAt} />
              </>
            ) : relaxing ? (
              '形を調整中…'
            ) : (
              '計算中…'
            )
          ) : (
            outcome
          )}
        </dd>
        <dt>形の調整</dt>
        <dd>{relaxation}</dd>
        <dt>全エネルギー</dt>
        {/* The energy of the structure on screen, which is a real number
            about a real structure even when the optimiser ran out of time
            before reaching the bottom. What is never shown is the last
            iterate of a diverging SCF: that is a number about the iteration,
            not about the molecule. */}
        <dd>{energy === null ? '—' : `${energy.toFixed(6)} Ha`}</dd>
      </dl>
    </div>
  );
}

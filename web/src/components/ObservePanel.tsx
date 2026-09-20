/**
 * The observe section of the panel: what the picked atoms measure, how that
 * changed over the last relaxation, and the switches for the labels.
 *
 * The value now comes from the viewer rather than from React state, because
 * while an animation plays the positions on screen are frames that never reach
 * React. Subscribing here keeps the re-render to this section.
 */
import { useSyncExternalStore } from 'react';
import type { Measurement } from '../scene/measure';
import type { LiveMeasurement } from '../scene/liveMeasurement';
import {
  BEFORE_AFTER_HINT,
  KIND_LABELS,
  atomPath,
  pickingHint,
  readout,
  undefinedReason,
} from './observe';

interface Props {
  live: LiveMeasurement;
  /** The same atoms measured on the structure the last relaxation started from. */
  before: Measurement | null;
  /** Element symbols of the picked atoms, in the order they were picked. */
  symbols: string[];
  showBondLengths: boolean;
  onShowBondLengths: (show: boolean) => void;
  onClear: () => void;
  onFrame: () => void;
  canFrame: boolean;
}

export function ObservePanel({
  live,
  before,
  symbols,
  showBondLengths,
  onShowBondLengths,
  onClear,
  onFrame,
  canFrame,
}: Props) {
  const now = useSyncExternalStore(live.subscribe, live.get);
  // Two or more picked but nothing measured yet happens only for the moment
  // between a click and the viewer catching up; say nothing rather than a dash.
  const measuring = symbols.length >= 2 && now !== null;
  const comparing = measuring && before !== null && before.kind === now.kind;
  const reason = measuring ? undefinedReason(now) : null;

  return (
    <>
      <h2>観測</h2>
      {measuring ? (
        <dl className="measurement">
          <dt>
            {KIND_LABELS[now.kind]}（{atomPath(symbols)}）
          </dt>
          <dd className="measurement-value">{readout(now, comparing ? before : null)}</dd>
        </dl>
      ) : symbols.length === 1 ? (
        <p className="measurement-picked">{symbols[0]} を選択中</p>
      ) : null}
      {reason && <p className="hint">{reason}</p>}
      {comparing && <p className="hint">{BEFORE_AFTER_HINT}</p>}
      <p className="hint">{pickingHint(symbols.length)}</p>

      <label className="toggle observe-toggle">
        <input
          type="checkbox"
          checked={showBondLengths}
          onChange={(event) => onShowBondLengths(event.target.checked)}
        />
        結合の長さをすべて表示（Å）
      </label>
      <div className="row observe-actions">
        <button type="button" onClick={onClear} disabled={symbols.length === 0}>
          計測を解除
        </button>
        <button type="button" onClick={onFrame} disabled={!canFrame}>
          全体表示
        </button>
      </div>
      <p className="hint">
        原子をクリックで選ぶ · もう一度クリックで外す · ドラッグで回転 · Esc で計測を解除
      </p>
    </>
  );
}

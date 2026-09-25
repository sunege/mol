/**
 * "近づけてみる": the distance scan, drawn (V4-8).
 *
 * A closed section of its own in the observe tab, after the molecular-orbital
 * one (V5-6; it used to sit at the bottom of that section, which made it about
 * 1,300px long when open). App draws it only for a molecule of exactly two
 * atoms - which is the only shape the scan can be drawn for. This is the inside
 * of that fold: its heading and the line beside it are App's.
 *
 * The correlation diagram used to open this section as well. Since V6-4 it is
 * in the molecular-orbital section instead, in place of the ladder of a
 * molecule of two atoms (`CorrelationDiagram.tsx`), so what is left here is the
 * scan: a calculation per separation, so it is started deliberately, reports
 * how far along it is, and can be given up on. Its figure grows as the points
 * arrive.
 *
 * It is about the two atoms on screen and nothing else. The section used to
 * offer five other pairs to scan as well (H₂, He₂, N₂, O₂, HF), and moving the
 * marker of one of those replaced the molecule in the viewer with that pair -
 * which, in a user's hands (V5-11), read as the section taking the atoms away.
 * App hands in the pair (`scanPairFor`) and draws a scan only while it is still
 * the pair on screen.
 *
 * Plain SVG: the page is cross-origin isolated, so no chart library can be
 * loaded from anywhere (`docs/plan-v4.md`, decision 8). Every string it draws
 * is worked out in `components/scan.ts`, which is what lets `scan.test.ts` walk
 * the picture and check that the only numbers in it are separations.
 *
 * The marker is the one control here that reaches outside the section: moving
 * it puts the two atoms at that separation in the viewer, which makes the
 * numbers beside them stale exactly as an edit would, and once it is still App
 * calculates them there, bringing back the cloud or the orbital that was on
 * screen (V5-11). Only once it is still: a drag passes through every separation
 * and would otherwise start one calculation per step.
 */
import { useMemo } from 'react';
import { ActionGrid, RunButton } from './controls';
import {
  SCAN_EMPTY,
  SCAN_ENERGY_HINT,
  SCAN_FIGURE_LABEL,
  SCAN_INTRO,
  SCAN_LEVELS_HINT,
  SCAN_MARKER_HINT,
  SCAN_PART_HEADING,
  SCAN_START,
  SCAN_STOP,
  SCAN_STOP_HINT,
  buildScan,
  markerLabel,
  scanProgress,
  type ScanRange,
  type ScanXY,
} from './scan';
import type { ScanPoint } from '../worker/protocol';

interface Props {
  /** A scan is in flight: the worker is busy and the marker must hold still. */
  running: boolean;
  /** Everything else is busy instead - a calculation of the molecule itself. */
  disabled: boolean;
  /** The points of the scan on screen, in the order they were solved. */
  points: readonly ScanPoint[];
  /** What was asked for, which is what the distance axis is drawn from. */
  range: ScanRange | null;
  /** Where the user put the marker, or null while it is where it started. */
  markerIndex: number | null;
  /**
   * The marker cannot move. Not while the calculation it started itself is
   * running - moving it again replaces that one - but while a relaxation is.
   */
  markerDisabled: boolean;
  onMarker: (index: number) => void;
  onStart: () => void;
  onStop: () => void;
}

export function DistanceScan({
  running,
  disabled,
  points,
  range,
  markerIndex,
  markerDisabled,
  onMarker,
  onStart,
  onStop,
}: Props) {
  const figure = useMemo(
    () => (range === null || points.length === 0 ? null : buildScan(points, range, markerIndex)),
    [points, range, markerIndex],
  );
  return (
    <section className="scan">
      <p className="hint">{SCAN_INTRO}</p>

      <h3>{SCAN_PART_HEADING}</h3>
      <ActionGrid columns={1}>
        {running ? (
          <button type="button" className="btn" disabled={disabled} onClick={onStop}>
            {SCAN_STOP}
          </button>
        ) : (
          <RunButton disabled={disabled} onClick={onStart}>
            {SCAN_START}
          </RunButton>
        )}
      </ActionGrid>
      {running && (
        <p className="hint">
          {scanProgress(points.length, range?.points ?? 0)} · {SCAN_STOP_HINT}
        </p>
      )}

      {figure === null ? (
        <p className="hint">{SCAN_EMPTY}</p>
      ) : (
        <>
          <svg
            className="scan-figure"
            viewBox={`0 0 ${figure.width} ${figure.height}`}
            role="group"
            aria-label={SCAN_FIGURE_LABEL}
          >
            <text className="scan-heading" x={0} y={figure.levels.headingY}>
              {figure.levels.heading}
            </text>
            <text className="scan-heading" x={0} y={figure.energy.headingY}>
              {figure.energy.heading}
            </text>

            {/* The marker first, so every line is drawn over it. */}
            {figure.marker !== null && (
              <line
                className="scan-marker-line"
                x1={figure.marker.x}
                y1={figure.marker.top}
                x2={figure.marker.x}
                y2={figure.marker.bottom}
              />
            )}

            {figure.levels.curves.map((curve) => (
              <g
                key={curve.key}
                className={`scan-curve${curve.dashed ? ' down' : ''}`}
                role="img"
                aria-label={curve.label}
              >
                {curve.segments.map((segment, index) => (
                  <Line key={index} points={segment} className="scan-level" />
                ))}
                {curve.species !== null && (
                  <text
                    className="scan-species"
                    x={curve.species.x}
                    y={curve.species.y}
                    textAnchor="end"
                  >
                    {curve.species.text}
                  </text>
                )}
                {curve.mark !== null && (
                  <text
                    className="scan-mark"
                    x={curve.mark.x}
                    y={curve.mark.y}
                    textAnchor={curve.mark.anchor}
                  >
                    {curve.mark.text}
                  </text>
                )}
              </g>
            ))}

            {figure.core !== null && (
              <>
                <line
                  className="scan-cut"
                  x1={0}
                  y1={figure.core.y}
                  x2={figure.width}
                  y2={figure.core.y}
                />
                <text className="scan-core" x={0} y={figure.core.textY}>
                  {figure.core.text}
                </text>
              </>
            )}

            {figure.energy.segments.map((segment, index) => (
              <Line key={index} points={segment} className="scan-total" />
            ))}
            {figure.energy.lowest !== null && (
              <circle
                className="scan-lowest"
                cx={figure.energy.lowest.x}
                cy={figure.energy.lowest.y}
                r={2}
              />
            )}

            <line
              className="scan-axis"
              x1={0}
              y1={figure.axis.y}
              x2={figure.width}
              y2={figure.axis.y}
            />
            {figure.axis.ticks.map((tick) => (
              <g key={tick.label}>
                <line
                  className="scan-tick"
                  x1={tick.x}
                  y1={figure.axis.y}
                  x2={tick.x}
                  y2={figure.axis.y + 3}
                />
                <text
                  className="scan-tick-label"
                  x={tick.x}
                  y={figure.axis.y + 11}
                  textAnchor={tick.anchor}
                >
                  {tick.label}
                </text>
              </g>
            ))}
            <text
              className="scan-unit"
              x={figure.width / 2}
              y={figure.axis.y + 22}
              textAnchor="middle"
            >
              {figure.axis.unit}
            </text>
          </svg>

          {figure.marker !== null && (
            <label className="scan-marker">
              {markerLabel(figure.marker.distance)}
              <input
                type="range"
                min={0}
                max={points.length - 1}
                step={1}
                value={figure.marker.index}
                disabled={running || markerDisabled}
                onChange={(event) => onMarker(Number(event.target.value))}
              />
            </label>
          )}
          <p className="hint">{SCAN_LEVELS_HINT}</p>
          <p className="hint">{SCAN_ENERGY_HINT}</p>
          <p className="hint">{SCAN_MARKER_HINT}</p>
          {figure.notes.map((note) => (
            <p className="hint" key={note}>
              {note}
            </p>
          ))}
        </>
      )}

    </section>
  );
}

/**
 * One unbroken run of a curve.
 *
 * A run of one point has no line in it, and a `polyline` of one point draws
 * nothing at all - which is what the first point of every scan is, and the
 * whole of a curve either side of a separation that would not solve. Those are
 * drawn as a dot, so a scan is visibly under way from its first answer.
 */
function Line({ points, className }: { points: readonly ScanXY[]; className: string }) {
  if (points.length === 1) {
    return <circle className={className} cx={points[0].x} cy={points[0].y} r={1.2} />;
  }
  return (
    <polyline className={className} points={points.map(({ x, y }) => `${x},${y}`).join(' ')} />
  );
}

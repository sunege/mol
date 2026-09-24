/**
 * "近づけてみる": the distance scan and the correlation diagram, drawn (V4-8).
 *
 * Inside the molecular-orbital section, and only for a molecule of exactly two
 * atoms - which is the only shape either figure can be drawn for.
 *
 * The correlation diagram comes first, because it is about the molecule on
 * screen and reads as the ladder above it continued outwards to the free atoms.
 * The scan is below it, because it need not be about that molecule at all: it
 * walks whichever pair is chosen, and it is a calculation per separation, so it
 * is started deliberately, reports how far along it is, and can be given up on.
 * Its figure grows as the points arrive.
 *
 * Two SVGs, both plain: the page is cross-origin isolated, so no chart library
 * can be loaded from anywhere (`docs/plan-v4.md`, decision 8). Every string
 * either of them draws is worked out in `components/scan.ts`, which is what
 * lets `scan.test.ts` walk the pictures and check that the only numbers in them
 * are separations.
 *
 * The marker is the one control here that reaches outside the section: moving
 * it puts the two atoms at that separation in the viewer, which makes the
 * numbers beside them stale exactly as an edit would. It is deliberately not a
 * calculation - the button next to it is - because dragging it would otherwise
 * queue one per step.
 */
import { useMemo } from 'react';
import {
  CORRELATION_HEADING,
  CORRELATION_HINT,
  CORRELATION_LABEL,
  CORR_LINE,
  SCAN_CALCULATE,
  SCAN_EMPTY,
  SCAN_ENERGY_HINT,
  SCAN_FIGURE_LABEL,
  SCAN_GROUP_LABEL,
  SCAN_HEADING,
  SCAN_LEVELS_HINT,
  SCAN_MARKER_HINT,
  SCAN_START,
  SCAN_STOP,
  SCAN_STOP_HINT,
  SCAN_TEASER,
  buildCorrelation,
  buildScan,
  markerLabel,
  scanProgress,
  type RungMakeup,
  type ScanPreset,
  type ScanRange,
  type ScanXY,
} from './scan';
import type { OrbitalLevel, ScanPoint } from '../worker/protocol';

interface Props {
  /** The pairs on offer, the last of which is the two atoms on screen. */
  presets: readonly ScanPreset[];
  chosenId: string;
  onChoose: (id: string) => void;
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
  onMarker: (index: number) => void;
  onStart: () => void;
  onStop: () => void;
  /** Solves the electrons at one of the separations, placing the pair first. */
  onCalculate: (index: number) => void;
  /** One list of a free atom's orbital energies per nucleus, or null. */
  atomLevels: number[][] | null;
  /** The molecule's own ladder, or null while there is none. */
  levels: readonly OrbitalLevel[] | null;
  /** What each rung of `levels` is made of: its share of each atom, and bonding or not. */
  weights: readonly RungMakeup[];
  /** One symbol per atom, in the order the engine was given them. */
  symbols: readonly string[];
}

export function DistanceScan({
  presets,
  chosenId,
  onChoose,
  running,
  disabled,
  points,
  range,
  markerIndex,
  onMarker,
  onStart,
  onStop,
  onCalculate,
  atomLevels,
  levels,
  weights,
  symbols,
}: Props) {
  const figure = useMemo(
    () => (range === null || points.length === 0 ? null : buildScan(points, range, markerIndex)),
    [points, range, markerIndex],
  );
  // The static companion, which needs no scan: a ladder of the molecule on
  // screen and the levels of the two free atoms are the whole of it.
  const correlation = useMemo(
    () =>
      atomLevels === null || atomLevels.length < 2 || levels === null || levels.length === 0
        ? null
        : buildCorrelation(atomLevels, symbols, levels, weights),
    [atomLevels, levels, weights, symbols],
  );

  return (
    <section className="scan">
      {correlation !== null && (
        <>
          <h3>{CORRELATION_HEADING}</h3>
          <p className="hint">{CORRELATION_HINT}</p>
          <svg
            className="correlation"
            viewBox={`0 0 ${correlation.width} ${correlation.height}`}
            role="group"
            aria-label={CORRELATION_LABEL}
          >
            {correlation.links.map((link, index) => (
              <line
                key={index}
                className="correlation-link"
                x1={link.x1}
                y1={link.y1}
                x2={link.x2}
                y2={link.y2}
              />
            ))}
            {correlation.columns.map((column) => (
              <g key={column.key}>
                <text
                  className="correlation-heading"
                  x={column.x}
                  y={column.headingY}
                  textAnchor="middle"
                >
                  {column.heading}
                </text>
                {column.rungs.map((rung) => (
                  <g key={rung.key} role="img" aria-label={rung.label}>
                    {rung.tag !== '' && (
                      <text
                        className="correlation-tag"
                        x={rung.tagX}
                        y={rung.y - 2.5}
                        textAnchor={rung.tagAnchor}
                      >
                        {rung.tag}
                      </text>
                    )}
                    {rung.name !== '' && (
                      <text
                        className="correlation-name"
                        x={rung.nameX}
                        y={rung.y - 2.5}
                        textAnchor={rung.nameAnchor}
                      >
                        {rung.name}
                      </text>
                    )}
                    {rung.lines.map((x) => (
                      <g key={x}>
                        {rung.mark !== '' && (
                          <text
                            className="correlation-mark"
                            x={x}
                            y={rung.y - 2.5}
                            textAnchor="middle"
                          >
                            {rung.mark}
                          </text>
                        )}
                        <line
                          className="correlation-line"
                          x1={x - CORR_LINE / 2}
                          y1={rung.y}
                          x2={x + CORR_LINE / 2}
                          y2={rung.y}
                        />
                      </g>
                    ))}
                  </g>
                ))}
              </g>
            ))}
            {correlation.core !== null && (
              <>
                <line
                  className="scan-cut"
                  x1={0}
                  y1={correlation.core.y}
                  x2={correlation.width}
                  y2={correlation.core.y}
                />
                <text className="scan-core" x={0} y={correlation.core.textY}>
                  {correlation.core.text}
                </text>
              </>
            )}
          </svg>
        </>
      )}

      <h3>{SCAN_HEADING}</h3>
      <p className="hint">{SCAN_TEASER}</p>
      <div className="row scan-pairs" role="group" aria-label={SCAN_GROUP_LABEL}>
        {presets.map((preset) => (
          <button
            key={preset.id}
            type="button"
            className={preset.id === chosenId ? 'active' : ''}
            aria-pressed={preset.id === chosenId}
            disabled={running || disabled}
            onClick={() => onChoose(preset.id)}
          >
            {preset.label}
          </button>
        ))}
      </div>
      <div className="row">
        <button
          type="button"
          className={running ? '' : 'active'}
          disabled={disabled}
          onClick={running ? onStop : onStart}
        >
          {running ? SCAN_STOP : SCAN_START}
        </button>
        {/* The pair is placed at the marker before it is solved, so this
            answers about the separation in the figure whether or not anyone has
            dragged the marker yet. */}
        <button
          type="button"
          disabled={running || disabled || figure?.marker == null}
          onClick={() => figure?.marker != null && onCalculate(figure.marker.index)}
        >
          {SCAN_CALCULATE}
        </button>
      </div>
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
                disabled={running || disabled}
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

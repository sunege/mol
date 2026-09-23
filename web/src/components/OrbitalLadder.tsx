/**
 * The ladder of orbitals, as a picture (V4-6).
 *
 * One short line per orbital, stacked by energy, with the electrons drawn above
 * each line and a label on the two rungs either side of where they run out.
 * The heights are the only thing carrying a number here, and they carry it as a
 * picture: no energy is written anywhere, because LDA's would be wrong while
 * the order and the spacings it draws are right (`components/orbital.ts`).
 *
 * A molecule with unpaired electrons gets a column per spin rather than one
 * ladder with halves of rungs, and the two are drawn on one scale with faint
 * lines joining the pairs, because the gap between a pair - O2's pi* is 0.08
 * Hartree lower in the spin that fills it - is what puts one electron in each
 * of two orbitals. The lines cross, which is also the point: the two spins put
 * their orbitals in different orders.
 *
 * Everything drawn is worked out in `components/ladder.ts`, including every
 * string; this file places SVG elements and handles the pointer and the keys.
 * The SVG is one tab stop per column and the arrow keys walk the lines from
 * there, because a molecule the size of benzene has three dozen of them and a
 * tab stop each would bury everything after the section.
 */
import { useMemo, useRef } from 'react';
import { LINE, buildLadder, step, type LadderColumn } from './ladder';
import { LADDER_LABEL, samePick, type OrbitalPick } from './orbital';
import type { OrbitalLevel } from '../worker/protocol';

interface Props {
  /** The rungs as the engine returned them, lowest first. */
  levels: readonly OrbitalLevel[];
  picked: OrbitalPick | null;
  onPick: (pick: OrbitalPick) => void;
}

export function OrbitalLadder({ levels, picked, onPick }: Props) {
  const ladder = useMemo(() => buildLadder(levels), [levels]);
  // The lines, so that an arrow key can move the focus with the selection.
  const lines = useRef(new Map<string, SVGGElement | null>());

  const move = (from: OrbitalPick, delta: number) => {
    const next = step(ladder, from, delta);
    if (next === null) return;
    onPick(next);
    lines.current.get(keyOf(next))?.focus();
  };

  return (
    <svg
      className="orbital-ladder"
      viewBox={`0 0 ${ladder.width} ${ladder.height}`}
      role="group"
      aria-label={LADDER_LABEL}
    >
      {ladder.links.map((link, index) => (
        <line
          key={index}
          className="orbital-ladder-link"
          x1={link.x1}
          y1={link.y1}
          x2={link.x2}
          y2={link.y2}
        />
      ))}
      {ladder.columns.map((column) => {
        const stop = tabStop(column, picked);
        return (
          <g key={column.spin}>
            {column.heading !== null && (
              <text
                className="orbital-ladder-heading"
                x={column.x}
                y={column.headingY}
                textAnchor="middle"
              >
                {column.heading}
              </text>
            )}
            {column.rungs.map((rung) => (
              <g key={rung.key}>
                {rung.tag !== '' && (
                  <text
                    className="orbital-ladder-tag"
                    x={rung.tagX}
                    y={rung.y + 3}
                    textAnchor={rung.tagAnchor}
                  >
                    {rung.tag}
                  </text>
                )}
                {rung.orbitals.map((orbital) => {
                  const showing = samePick(picked, orbital.pick);
                  return (
                    <g
                      key={orbital.pick.index}
                      ref={(node) => {
                        lines.current.set(keyOf(orbital.pick), node);
                      }}
                      className={`orbital-ladder-orbital${showing ? ' active' : ''}`}
                      role="button"
                      aria-label={orbital.label}
                      aria-pressed={showing}
                      tabIndex={samePick(orbital.pick, stop) ? 0 : -1}
                      onClick={() => onPick(orbital.pick)}
                      onKeyDown={(event) => {
                        if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
                          event.preventDefault();
                          move(orbital.pick, -1);
                        } else if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
                          event.preventDefault();
                          move(orbital.pick, 1);
                        } else if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          onPick(orbital.pick);
                        }
                      }}
                    >
                      {/* Wider than the line, so the whole rung is easy to hit
                          and the focus ring has something to sit on. */}
                      <rect
                        className="orbital-ladder-hit"
                        x={orbital.x - LINE / 2 - 3}
                        y={rung.y - 9.5}
                        width={LINE + 6}
                        height={12}
                        rx={3}
                      />
                      <text
                        className="orbital-ladder-mark"
                        x={orbital.x}
                        y={rung.y - 2.5}
                        textAnchor="middle"
                      >
                        {rung.mark}
                      </text>
                      <line
                        className="orbital-ladder-line"
                        x1={orbital.x - LINE / 2}
                        y1={rung.y}
                        x2={orbital.x + LINE / 2}
                        y2={rung.y}
                      />
                    </g>
                  );
                })}
              </g>
            ))}
          </g>
        );
      })}
      {ladder.core !== null && (
        <>
          <line
            className="orbital-ladder-cut"
            x1={0}
            y1={ladder.core.y}
            x2={ladder.width}
            y2={ladder.core.y}
          />
          <text className="orbital-ladder-core" x={0} y={ladder.core.textY}>
            {ladder.core.text}
          </text>
        </>
      )}
    </svg>
  );
}

/**
 * The one line of a column that Tab reaches.
 *
 * The orbital on screen where it is in this column, so that tabbing back in
 * lands on it; otherwise the highest one holding electrons, which is where a
 * reader of this picture starts.
 */
function tabStop(column: LadderColumn, picked: OrbitalPick | null): OrbitalPick | null {
  const orbitals = column.rungs.flatMap((rung) => rung.orbitals);
  const here = orbitals.find((orbital) => samePick(orbital.pick, picked));
  if (here !== undefined) return here.pick;
  const homo = column.rungs.find((rung) => rung.frontier === 'homo') ?? column.rungs[0];
  return homo?.orbitals[0]?.pick ?? null;
}

function keyOf(pick: OrbitalPick): string {
  return `${pick.spin}:${pick.index}`;
}

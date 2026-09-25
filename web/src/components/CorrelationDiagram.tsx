/**
 * The correlation diagram of two atoms, drawn - and, for two atoms, the ladder.
 *
 * Two free atoms either side and the molecule they make in the middle, on one
 * scale, with thin lines from each of the molecule's rungs to the atomic
 * levels it was made of (V4-8). It used to sit in "近づけてみる" under a ladder
 * of the same molecule, which drew the middle column twice; since V6-4 it takes
 * the ladder's place in the molecular-orbital section of a molecule of exactly
 * two atoms, and so it is what an orbital is picked from there.
 *
 * Each of the molecule's lines carries its pick (`CorrelationRung.picks`) - the
 * same one the ladder's line had - under a transparent box a little taller than
 * the line, so it can be hit. A free atom's lines carry theirs too since V6-7,
 * and a p set is three shorter lines on one rung (`CorrelationRung.lineLength`).
 *
 * Plain SVG, like the other figures (the page is cross-origin isolated). Every
 * string in it comes from `components/scan.ts`, which is what lets
 * `scan.test.ts` check that none of it is a number.
 */
import { CORRELATION_LABEL, type CorrelationFigure } from './scan';
import { samePick, type OrbitalPick } from './orbital';

/** How tall the box a line can be pressed in is, in the figure's units. */
const HIT_HEIGHT = 12;

interface Props {
  figure: CorrelationFigure;
  picked: OrbitalPick | null;
  onPick: (pick: OrbitalPick) => void;
}

export function CorrelationDiagram({ figure, picked, onPick }: Props) {
  return (
    <svg
      className="correlation"
      viewBox={`0 0 ${figure.width} ${figure.height}`}
      role="group"
      aria-label={CORRELATION_LABEL}
    >
      {figure.links.map((link, index) => (
        <line
          key={index}
          className="correlation-link"
          x1={link.x1}
          y1={link.y1}
          x2={link.x2}
          y2={link.y2}
        />
      ))}
      {figure.columns.map((column) => (
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
            // A rung with buttons in it is not an image: the children of one
            // are hidden from the accessibility tree, and each button already
            // says what the rung would have.
            <g
              key={rung.key}
              {...(rung.picks.some((pick) => pick !== null)
                ? {}
                : { role: 'img', 'aria-label': rung.label })}
            >
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
              {rung.lines.map((x, k) => {
                const pick = rung.picks[k] ?? null;
                const showing = pick !== null && samePick(pick, picked);
                return (
                  <g key={x} className={pick === null ? undefined : 'correlation-orbital'}>
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
                      className={`correlation-line${showing ? ' picked' : ''}`}
                      x1={x - rung.lineLength / 2}
                      y1={rung.y}
                      x2={x + rung.lineLength / 2}
                      y2={rung.y}
                    />
                    {/* Over the line and the circles on it, so the whole of it
                        is easy to hit and the focus ring has something to sit on. */}
                    {pick !== null && (
                      <rect
                        className="correlation-hit"
                        x={x - rung.lineLength / 2}
                        y={rung.y - HIT_HEIGHT + 3}
                        width={rung.lineLength}
                        height={HIT_HEIGHT}
                        role="button"
                        tabIndex={0}
                        aria-label={rung.lineLabels[k]}
                        aria-pressed={showing}
                        onClick={() => onPick(pick)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            onPick(pick);
                          }
                        }}
                      />
                    )}
                  </g>
                );
              })}
            </g>
          ))}
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
    </svg>
  );
}

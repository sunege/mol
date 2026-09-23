/**
 * The molecular-orbital section of the panel (phase v4).
 *
 * Closed until someone opens it, so the default screen is the one v3 left
 * behind (`docs/plan-v4.md`, decision 1). Inside is the ladder of the molecule
 * on screen - one row per rung, lowest at the bottom - and picking a row draws
 * that orbital in place of the density, in the two colours of its two signs.
 *
 * What a row may say is decided in `components/orbital.ts`: no energies, no
 * numbering, and nothing about how any of it was computed. The rows are also
 * the one place in the app where a molecule with unpaired electrons looks
 * different from any other - two columns instead of one - and that is the
 * point of them rather than a leak (decision 2).
 *
 * The section owns nothing. Which orbital is picked, and the threshold it is
 * cut at, belong to the App beside the density's own: only one surface is ever
 * drawn, so the two selections have to be one decision.
 */
import { ISO_RANGES, IsoLevelSlider } from './IsoLevelSlider';
import {
  MEMBER_GROUP_LABEL,
  ORBITAL_HEADING,
  ORBITAL_INTRO,
  ORBITAL_LOADING,
  ORBITAL_NEEDS_CALCULATION,
  ORBITAL_OTHER_LEVEL,
  ORBITAL_SCALE,
  ORBITAL_SURFACE_HINT,
  ORBITAL_TEASER,
  degenerateText,
  frontierLabel,
  memberLabel,
  occupationMark,
  occupationText,
  orbitalColumns,
  samePick,
  type OrbitalPick,
} from './orbital';
import type { OrbitalLevel } from '../worker/protocol';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The rungs of the molecule on screen, or null while there are none yet. */
  levels: OrbitalLevel[] | null;
  /** A ladder is on its way: the worker has a calculation to read it from. */
  loading: boolean;
  /** The numbers on screen are the other level's, which has no ladder here. */
  otherLevel: boolean;
  picked: OrbitalPick | null;
  onPick: (pick: OrbitalPick) => void;
  /** The threshold an orbital is cut at, which is not the density's. */
  isoLevel: number;
  onIsoLevel: (level: number) => void;
}

export function OrbitalPanel({
  open,
  onOpenChange,
  levels,
  loading,
  otherLevel,
  picked,
  onPick,
  isoLevel,
  onIsoLevel,
}: Props) {
  return (
    <>
      <details
        className="orbitals"
        open={open}
        onToggle={(event) => onOpenChange(event.currentTarget.open)}
      >
        <summary>
          <h2>{ORBITAL_HEADING}</h2>
        </summary>
        {otherLevel ? (
          <p className="hint">{ORBITAL_OTHER_LEVEL}</p>
        ) : levels === null ? (
          <p className="hint">{loading ? ORBITAL_LOADING : ORBITAL_NEEDS_CALCULATION}</p>
        ) : (
          <>
            <p className="hint">{ORBITAL_INTRO}</p>
            <div className="orbital-columns">
              {orbitalColumns(levels).map((column) => (
                <div className="orbital-column" key={column.spin}>
                  {column.heading !== null && <h3>{column.heading}</h3>}
                  <ul className="orbital-rungs">
                    {column.rows.map(({ level, frontier }) => (
                      <li key={level.first} className="orbital-rung">
                        <span className="orbital-mark" title={occupationText(level.occupation)}>
                          {occupationMark(level.occupation)}
                        </span>
                        <span className="orbital-frontier">
                          {frontier === null ? '' : frontierLabel(frontier)}
                        </span>
                        <span
                          className="orbital-members"
                          // A group only where there is something to choose
                          // between: one button is not a set of anything.
                          role={level.count >= 2 ? 'group' : undefined}
                          aria-label={level.count >= 2 ? MEMBER_GROUP_LABEL : undefined}
                        >
                          {Array.from({ length: level.count }, (_, offset) => {
                            const pick = { index: level.first + offset, spin: level.spin };
                            const showing = samePick(picked, pick);
                            return (
                              <button
                                key={offset}
                                type="button"
                                className={showing ? 'active' : ''}
                                aria-pressed={showing}
                                onClick={() => onPick(pick)}
                              >
                                {memberLabel(offset, level.count)}
                              </button>
                            );
                          })}
                        </span>
                        {/* Its own line under the row, where there is one to
                            say: it is longer than the column is wide. */}
                        {level.count >= 2 && (
                          <span className="orbital-degenerate">{degenerateText(level.count)}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
            {/* The threshold is the orbital's own, and appears only while one
                is on screen: with none, it would slide nothing. */}
            {picked !== null && (
              <>
                <IsoLevelSlider
                  value={isoLevel}
                  range={ISO_RANGES.orbital}
                  scale={ORBITAL_SCALE}
                  onChange={onIsoLevel}
                />
                <p className="hint">{ORBITAL_SURFACE_HINT}</p>
              </>
            )}
          </>
        )}
      </details>
      {/* What is behind the closed section, since the heading alone does not
          say. It is replaced by the section's own words once it is open. */}
      {!open && <p className="hint">{ORBITAL_TEASER}</p>}
    </>
  );
}

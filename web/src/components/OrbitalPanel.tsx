/**
 * The molecular-orbital section of the panel (phase v4).
 *
 * Closed until someone opens it, so the default screen is the one v3 left
 * behind (`docs/plan-v4.md`, decision 1). Inside is the ladder of the molecule
 * on screen - drawn in `OrbitalLadder.tsx`, a line per orbital with the lowest
 * at the bottom - and picking a line draws that orbital in place of the
 * density, in the two colours of its two signs. Under it are the threshold it
 * is cut at and what it is like in words (V4-5).
 *
 * What the ladder may say is decided in `components/orbital.ts`: no energies,
 * no numbering, and nothing about how any of it was computed. It is also the
 * one place in the app where a molecule with unpaired electrons looks
 * different from any other - two columns instead of one - and that is the
 * point of it rather than a leak (decision 2).
 *
 * The section owns nothing. Which orbital is picked, and the threshold it is
 * cut at, belong to the App beside the density's own: only one surface is ever
 * drawn, so the two selections have to be one decision.
 */
import { ISO_RANGES, IsoLevelSlider } from './IsoLevelSlider';
import { OrbitalLadder } from './OrbitalLadder';
import {
  ORBITAL_HEADING,
  ORBITAL_INTRO,
  ORBITAL_LOADING,
  ORBITAL_NEEDS_CALCULATION,
  ORBITAL_OTHER_LEVEL,
  ORBITAL_SCALE,
  ORBITAL_SURFACE_HINT,
  ORBITAL_TEASER,
  countNodes,
  describeBonds,
  describeLobes,
  describeNodes,
  rungOf,
  verdictBySymmetry,
  type Bond,
  type OrbitalPick,
} from './orbital';
import type { IsoMesh, OrbitalCharacter, OrbitalLevel } from '../worker/protocol';
import type { ReactNode } from 'react';

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
  /** What the picked orbital does to the bonds, once it has been asked for. */
  character: OrbitalCharacter | null;
  /** The bonds on screen, which are the ones the words may talk about. */
  bonds: readonly Bond[];
  /** One symbol per atom, in the order the engine was given them. */
  symbols: readonly string[];
  /** The blobs the surface on screen came out in, or null while there is none. */
  lobes: IsoMesh['lobes'] | null;
  /**
   * Two atoms being moved together, for a molecule that is two atoms.
   *
   * Outside everything above it on purpose: a distance scan solves its own
   * geometries, so it is there whether or not anything has been calculated for
   * the molecule on screen, and at whichever level the numbers beside it came
   * from (`components/DistanceScan.tsx`).
   */
  scan: ReactNode;
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
  character,
  bonds,
  symbols,
  lobes,
  scan,
}: Props) {
  // What the picked orbital is like, in the three lines under the ladder. The
  // nodes are counted only for a rung the reflection calls pi: nobody counts
  // the nodes of an arbitrary orbital, and a molecule with no plane has no
  // amplitudes to count them from (`countNodes`).
  const rung = rungOf(levels, picked);
  const bondWords =
    character === null
      ? ''
      : describeBonds(
          character.populations,
          bonds,
          symbols,
          rung === null ? null : verdictBySymmetry(rung.count, rung.inversion),
        );
  const nodes =
    character !== null && rung?.parity === -1 ? countNodes(character.amplitudes, bonds) : null;
  const lobeWords = lobes === null ? '' : describeLobes(lobes);
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
            <OrbitalLadder levels={levels} picked={picked} onPick={onPick} />
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
                {/* What the orbital is, as opposed to what it looks like. Each
                    line appears only once there is something true to put in
                    it: the first two wait for the round trip that fetches
                    them, and the last for the surface itself, since the blobs
                    it counts are the ones on screen at this threshold. */}
                <ul className="orbital-character">
                  {bondWords !== '' && <li>{bondWords}</li>}
                  {nodes !== null && <li>{describeNodes(nodes)}</li>}
                  {lobeWords !== '' && <li>{lobeWords}</li>}
                </ul>
              </>
            )}
          </>
        )}
        {scan}
      </details>
      {/* What is behind the closed section, since the heading alone does not
          say. It is replaced by the section's own words once it is open. */}
      {!open && <p className="hint">{ORBITAL_TEASER}</p>}
    </>
  );
}

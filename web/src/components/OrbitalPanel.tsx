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
 * A molecule of exactly two atoms gets the correlation diagram in the ladder's
 * place (V6-4): its middle column is the same ladder, with the free atoms it
 * was made of either side, and its lines are picked from exactly as the
 * ladder's were. Two figures of one ladder, one above the other, said nothing
 * the second did not.
 *
 * The section owns nothing. Which orbital is picked, and the threshold it is
 * cut at, belong to the App beside the density's own: only one surface is ever
 * drawn, so the two selections have to be one decision.
 */
import { CorrelationDiagram } from './CorrelationDiagram';
import { Fold } from './Fold';
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
import {
  CORRELATION_HINT,
  atomPickWords,
  type CorrelationFigure,
  type DiagramEnd,
} from './scan';
import type { IsoMesh, OrbitalCharacter, OrbitalLevel } from '../worker/protocol';

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
  /** The two ends of the correlation diagram, ions headed as ions (V7-7). */
  ends: readonly DiagramEnd[];
  /** The blobs the surface on screen came out in, or null while there is none. */
  lobes: IsoMesh['lobes'] | null;
  /** Exactly two atoms on screen: the correlation diagram stands in for the ladder. */
  diatomic: boolean;
  /** That diagram, or null until the free atoms' levels have arrived as well. */
  correlation: CorrelationFigure | null;
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
  ends,
  lobes,
  diatomic,
  correlation,
}: Props) {
  // What the picked orbital is like, in the three lines under the ladder. The
  // nodes are counted only for a rung the reflection calls pi: nobody counts
  // the nodes of an arbitrary orbital, and a molecule with no plane has no
  // amplitudes to count them from (`countNodes`).
  //
  // A free atom's orbital, pressed on the correlation diagram, has no bond to
  // talk about: one line says whose it is instead (V6-8), and the blobs are
  // counted as for any other.
  const rung = rungOf(levels, picked);
  const atomWords =
    picked?.atom === undefined ? '' : atomPickWords(correlation, picked, ends);
  const bondWords =
    character === null || atomWords !== ''
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
    <Fold
      heading={ORBITAL_HEADING}
      teaser={ORBITAL_TEASER}
      className="orbitals"
      open={open}
      onOpenChange={onOpenChange}
    >
      {otherLevel ? (
        <p className="hint">{ORBITAL_OTHER_LEVEL}</p>
      ) : levels === null ? (
        <p className="hint">{loading ? ORBITAL_LOADING : ORBITAL_NEEDS_CALCULATION}</p>
      ) : (
        <>
          <p className="hint">{ORBITAL_INTRO}</p>
          {!diatomic ? (
            <OrbitalLadder levels={levels} picked={picked} onPick={onPick} />
          ) : (
            <>
              <p className="hint">{CORRELATION_HINT}</p>
              {correlation === null ? (
                <p className="hint">{ORBITAL_LOADING}</p>
              ) : (
                <CorrelationDiagram figure={correlation} picked={picked} onPick={onPick} />
              )}
            </>
          )}
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
                {atomWords !== '' && <li>{atomWords}</li>}
                {bondWords !== '' && <li>{bondWords}</li>}
                {nodes !== null && <li>{describeNodes(nodes)}</li>}
                {lobeWords !== '' && <li>{lobeWords}</li>}
              </ul>
            </>
          )}
        </>
      )}
    </Fold>
  );
}

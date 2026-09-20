/**
 * Turning "try this shape" and "try a few shapes near this one" into candidates
 * for the pool.
 *
 * The second of those is the one with a choice in it, and the measurements
 * behind the choice are worth knowing before changing anything here
 * (`docs/dev-notes.md`, "P10-1 の実測"):
 *
 * - **A structure with no symmetry is not helped by nudging at all.** A methane
 *   clicked together by hand relaxed to the same tetrahedron from every nudge
 *   tried, up to half an Angstrom, in the same number of steps. What the nudge
 *   is for is the same thing it was for in `records/perturb.ts`: a structure
 *   sitting on a symmetry the optimiser cannot leave on its own.
 * - **Getting off that symmetry depends on the direction, not the size.** One
 *   set of directions left a flat methane flat at 0.05 and 0.20 A and took it to
 *   the tetrahedron at 0.10. So the way to find another shape is to try several,
 *   which is what the pool is for - not to nudge harder.
 * - **Nudging harder finds worse shapes, not other ones.** Past about 0.3 A,
 *   candidates began settling on stationary points hundreds of kJ/mol above the
 *   minimum (671 for methane, 263 for hydrogen peroxide). They are real - the
 *   forces balance - but they are not what a class is looking for, and without a
 *   vibrational analysis there is no telling a floor from a pass.
 *
 * Hence {@link SEARCH_AMPLITUDE}: four times the nudge a single relaxation gets,
 * and well short of where the results stop meaning anything.
 */
import { perturb } from '../records/perturb';
import type { CandidateRequest } from './pool';

/**
 * How far each atom moves in a search candidate, in Angstrom.
 *
 * A fifth of a bond: plainly a different starting point, and measured to be
 * enough to come off a plane from most directions. `PERTURB_AMPLITUDE` (0.05 A)
 * is the other one in the app and is a different job - the smallest tremble that
 * breaks an exact symmetry before a single relaxation.
 *
 * The cost is real and is the reason not to go further: a nudged structure has
 * no symmetry left for the optimiser to lean on, and takes one and a half to
 * four times as many steps to bring to a stop.
 */
export const SEARCH_AMPLITUDE = 0.2;

/**
 * How close two atoms may come, as a fraction of their covalent radii, before a
 * drawn candidate is thrown away and drawn again.
 *
 * Not a limit the engine needs. Nothing in the measurements failed to converge,
 * including a draw that brought two atoms within 0.59 A. It is a limit on what
 * is worth *showing*: a candidate with two atoms inside each other is not a
 * version of the molecule the user built, and a row of them in the log would
 * say nothing. Six tenths of the sum of the covalent radii is well inside any
 * real bond - a C-H bond would have to shrink from 1.09 A to 0.64 - so this only
 * catches a draw that went badly.
 */
export const MINIMUM_SEPARATION_FRACTION = 0.6;

/**
 * Draws to make before giving up on a seed and using it as it came out.
 *
 * A structure so crowded that every nudge overlaps something is one the user
 * built that way, and refusing to start a candidate at all would be a worse
 * answer than starting a slightly crowded one - the engine will solve it, and
 * whatever it settles on is the honest reply to what was on screen.
 */
const DRAWS_PER_CANDIDATE = 8;

export interface CandidateSource {
  /** Atomic numbers, in the order `xyz` uses. */
  z: Uint8Array;
  /** The structure on screen, in Angstrom. */
  xyz: Float64Array;
  /** The engine's covalent radii, for the overlap check. */
  covalentRadius: (z: number) => number;
  /** Shared by everything started together; the records carry it. */
  batch: string;
  /** Ids for the candidates, in order. The App passes `crypto.randomUUID`. */
  id: () => string;
}

/**
 * The structure exactly as it is, as one candidate.
 *
 * What "今の形を候補に追加" makes. No nudge: the user is asking what *this*
 * shape relaxes to, and a structure with no symmetry relaxes to the same place
 * either way.
 */
export function candidateAsBuilt(source: CandidateSource): CandidateRequest {
  return {
    id: source.id(),
    batch: source.batch,
    z: source.z,
    built: source.xyz,
    start: source.xyz,
  };
}

/**
 * `count` candidates near the structure, each nudged in its own directions.
 *
 * `seed` decides the whole set, so a test can say which draw it is talking
 * about; the App passes `randomSeed()` and gets a different set each time it is
 * pressed - which is the point, since pressing again is how you try more
 * directions.
 */
export function nudgedCandidates(
  source: CandidateSource,
  count: number,
  seed: number,
  amplitude: number = SEARCH_AMPLITUDE,
): CandidateRequest[] {
  const candidates: CandidateRequest[] = [];
  for (let index = 0; index < Math.max(0, Math.floor(count)); index++) {
    candidates.push({
      id: source.id(),
      batch: source.batch,
      z: source.z,
      built: source.xyz,
      start: drawApart(source, amplitude, (seed + index * 0x9e3779b1) >>> 0),
    });
  }
  return candidates;
}

/**
 * A nudge of `amplitude` that did not put two atoms inside each other, from the
 * first of a few draws that managed it.
 *
 * Exported for the tests, which is also why the draw count is fixed here rather
 * than looped over by the caller.
 */
export function drawApart(
  source: Pick<CandidateSource, 'z' | 'xyz' | 'covalentRadius'>,
  amplitude: number,
  seed: number,
): Float64Array {
  let drawn = perturb(source.xyz, amplitude, seed);
  for (let draw = 1; draw < DRAWS_PER_CANDIDATE && overlaps(source, drawn); draw++) {
    drawn = perturb(source.xyz, amplitude, (seed + draw * 0x85ebca6b) >>> 0);
  }
  return drawn;
}

/**
 * Whether any two atoms of `xyz` are closer than they have any business being.
 *
 * Element-aware, because "too close" is not one distance: two hydrogens bond at
 * 0.74 A and two carbons at 1.5.
 */
export function overlaps(
  source: Pick<CandidateSource, 'z' | 'covalentRadius'>,
  xyz: Float64Array,
): boolean {
  const count = Math.floor(xyz.length / 3);
  for (let i = 0; i < count; i++) {
    for (let j = i + 1; j < count; j++) {
      const limit =
        (source.covalentRadius(source.z[i]) + source.covalentRadius(source.z[j])) *
        MINIMUM_SEPARATION_FRACTION;
      const d = Math.hypot(
        xyz[3 * i] - xyz[3 * j],
        xyz[3 * i + 1] - xyz[3 * j + 1],
        xyz[3 * i + 2] - xyz[3 * j + 2],
      );
      if (d < limit) return true;
    }
  }
  return false;
}

/**
 * Where the lines of the orbital ladder go: the arithmetic behind the picture.
 *
 * The ladder shows heights and nothing else. LDA's orbital energies are out by
 * a factor of several, so no number from them may reach the screen
 * (`components/orbital.ts`), but their order, their degeneracies and the size
 * of the gaps between them are right - which is exactly what a textbook's own
 * level diagram is drawn from. Everything here turns those energies into y
 * coordinates and leaves the drawing to `OrbitalLadder.tsx`.
 *
 * Two things are done to the energies on the way, and both are visible in the
 * picture rather than hidden in it.
 *
 * The innermost electrons are cut off the bottom ({@link foldCore}). Water's
 * oxygen 1s is 17 Hartree below the next rung and benzene's six carbons are 9
 * below theirs, against a valence spread of one and a half: drawn to scale, the
 * whole of the chemistry collapses onto one line. What is cut is counted and
 * said in a line of its own, and the cut is made once for the whole molecule so
 * that a molecule with two columns has them cut level with each other.
 *
 * Rungs closer together than the eye can separate are pushed apart
 * ({@link layout}). This is a distortion, and a deliberate one: the figure is
 * there to show the order of the rungs, which of them are level, and where the
 * large gaps are, and two lines drawn on top of each other show none of those.
 * Large gaps survive it - the push is local, so a gap wider than the minimum is
 * left alone - and the order never changes.
 *
 * Every string the SVG draws is built here, out of `components/orbital.ts`, so
 * that "no energy reaches the screen" is something `ladder.test.ts` can check
 * by walking this structure.
 */
import type { OrbitalLevel, SpinChannel } from '../worker/protocol';
import {
  coreText,
  frontierLabel,
  ladderRungLabel,
  occupationMark,
  orbitalColumns,
  samePick,
  type Frontier,
  type OrbitalPick,
} from './orbital';

/**
 * Two rungs within this of each other are drawn at one height, in Hartree.
 *
 * The engine's own threshold for calling a set degenerate, which it has already
 * applied inside one spin (`dft-core/src/orbital.rs`); it is applied again here
 * because the two spins' rungs are grouped separately there and a pair of them
 * may well land on the same height.
 */
const SAME_HEIGHT = 1e-4;

/**
 * The least room between two rungs, in the units the viewBox is drawn in.
 *
 * Enough for the circles that sit above a line to clear the line above them,
 * which is what makes two rungs read as two.
 */
export const MIN_STEP = 13;

/** The room one rung would like, which is what sets how tall the picture is. */
const STEP = 18;

/** The drawing, in viewBox units: about the width of the panel it sits in. */
const WIDTH = 260;
const TOP = 12;
const HEADING = 14;
const BOTTOM = 8;
/** The dashed line for the folded core, and the words under it. */
const CORE_ROW = 24;
const MIN_BAND = 140;
const MAX_BAND = 520;

/** One orbital, as a short horizontal line. */
export const LINE = 24;
const LINE_GAP = 7;
/** Room between a rung's lines and the HOMO or LUMO label beside them. */
const TAG_GAP = 4;

/**
 * The least a rung has to be for the two functions below to place it.
 *
 * Neither of them looks at anything else, so the ladder of a molecule
 * (`OrbitalLevel`), the rungs of one separation of a distance scan
 * (`ScanLevel`) and the levels of a free atom all go through the same
 * arithmetic, which is what makes the correlation diagram of `scan.ts` line up
 * with the ladder drawn here.
 */
export interface Rung {
  energy: number;
  occupation: number;
  count: number;
}

/** What {@link foldCore} left of the ladder, and how much it took. */
export interface FoldedLadder<T = OrbitalLevel> {
  /** Orbitals cut off the bottom: none, or every one below the cut. */
  core: number;
  /** The rungs that are drawn, in the order the engine returned them. */
  shown: T[];
}

/**
 * Cuts the innermost orbitals off the bottom of the ladder.
 *
 * The cut is looked for from the bottom up and made at the first gap that is
 * wider than the whole of what is left above it - which is a fact about the
 * molecule rather than a threshold anyone tuned: water's is 17.4 against a
 * span of 1.26, benzene's 8.87 against 1.49, and no gap between valence rungs
 * comes close. A molecule whose orbitals are all of a piece keeps them all.
 *
 * Two conditions keep it from eating anything else. Only rungs that hold
 * electrons are folded, so the frontier is never touched and `orbitalColumns`
 * still finds the same HOMO and LUMO in what is left. And at least two rungs
 * have to remain, because with one left there is no span above the gap to
 * compare it with - which is what stops the ladder of H2 folding its bonding
 * orbital away as core.
 *
 * Open shell: the rungs of both spins are sorted together and cut once, so the
 * two columns lose everything below one height rather than each finding a cut
 * of its own. Their innermost rungs are not at the same energy - O2's are 0.02
 * Hartree apart - and two columns cut at different heights cannot be read
 * against each other.
 */
export function foldCore<T extends Rung>(levels: readonly T[]): FoldedLadder<T> {
  const sorted = [...levels].sort((a, b) => a.energy - b.energy);
  const top = sorted.length === 0 ? 0 : sorted[sorted.length - 1].energy;
  for (let cut = 1; cut < sorted.length - 1; cut++) {
    if (sorted[cut].energy - sorted[cut - 1].energy <= top - sorted[cut].energy) continue;
    // An empty rung down there is not a core orbital, and every higher cut
    // would swallow that same rung, so there is nothing further to look for.
    const core = sorted.slice(0, cut);
    if (!core.every((level) => level.occupation > 0)) break;
    const folded = new Set(core);
    return {
      core: core.reduce((orbitals, level) => orbitals + level.count, 0),
      shown: levels.filter((level) => !folded.has(level)),
    };
  }
  return { core: 0, shown: [...levels] };
}

/**
 * The height of every rung, in viewBox units from the top of the band.
 *
 * Proportional to the energy, then pushed apart where the lines would touch.
 * The push sweeps up from the lowest rung and, only if that has run out of
 * room at the top, back down again; either way the order is kept and rungs at
 * one height stay at one height. A band too short to hold the rungs at all
 * falls back to even spacing, which is the one case where the picture says
 * nothing about the gaps - {@link buildLadder} makes the band tall enough that
 * it does not arise for the molecules this app solves.
 */
export function layout(shown: readonly Pick<Rung, 'energy'>[], height: number): number[] {
  const energies = shown.map((level) => level.energy);
  if (energies.length === 0) return [];
  const low = Math.min(...energies);
  const span = Math.max(...energies) - low;
  // The distinct heights, lowest first: rungs of opposite spin that came out
  // level with each other are one of them and are drawn level.
  const rows: number[] = [];
  for (const energy of [...energies].sort((a, b) => a - b)) {
    if (rows.length === 0 || energy - rows[rows.length - 1] > SAME_HEIGHT) rows.push(energy);
  }
  const raised = pushApart(
    rows.map((energy) => (span > 0 ? ((energy - low) / span) * height : height / 2)),
    height,
  );
  return energies.map((energy) => height - raised[nearest(rows, energy)]);
}

/** Which of the heights a rung belongs to, by the energy it came in with. */
function nearest(rows: readonly number[], energy: number): number {
  let best = 0;
  for (let i = 1; i < rows.length; i++) {
    if (Math.abs(rows[i] - energy) < Math.abs(rows[best] - energy)) best = i;
  }
  return best;
}

/** Heights above the bottom of the band, lowest first, made at least a step apart. */
function pushApart(raw: readonly number[], height: number): number[] {
  const raised = [...raw];
  for (let i = 1; i < raised.length; i++) {
    raised[i] = Math.max(raised[i], raised[i - 1] + MIN_STEP);
  }
  if (raised.length > 1 && raised[raised.length - 1] > height) {
    raised[raised.length - 1] = height;
    for (let i = raised.length - 2; i >= 0; i--) {
      raised[i] = Math.min(raised[i], raised[i + 1] - MIN_STEP);
    }
    if (raised[0] < 0) {
      for (let i = 0; i < raised.length; i++) raised[i] = (i * height) / (raised.length - 1);
    }
  }
  return raised;
}

/** One orbital: a line to draw, a place to put it, and what it is when read. */
export interface LadderOrbital {
  pick: OrbitalPick;
  /** Centre of the line. */
  x: number;
  /** Everything the picture says about this line, in words. */
  label: string;
}

/** One rung: the orbitals at one height, and what is written beside them. */
export interface LadderRung {
  /** Identifies the rung inside the picture; not shown and not an orbital. */
  key: string;
  level: OrbitalLevel;
  frontier: Frontier | null;
  y: number;
  /** The electrons in one of its orbitals, drawn above each line. */
  mark: string;
  /** `HOMO`, `LUMO`, or nothing at all. */
  tag: string;
  /** Outside the pair of columns, so the middle is left for the links. */
  tagX: number;
  tagAnchor: 'start' | 'end';
  orbitals: LadderOrbital[];
}

/** One spin's ladder, or the only one there is. */
export interface LadderColumn {
  spin: SpinChannel;
  /** Null where there is one column, which needs no heading. */
  heading: string | null;
  /** Middle of the column: where the heading goes and the rungs are centred. */
  x: number;
  headingY: number;
  /** Highest rung first. */
  rungs: LadderRung[];
}

/** The same orbital in the two spins, which are rarely at the same height. */
export interface LadderLink {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** What was cut off the bottom, as a line across the picture and a sentence. */
export interface LadderCore {
  orbitals: number;
  y: number;
  textY: number;
  text: string;
}

/** A picture ready to draw: nothing below this decides anything. */
export interface Ladder {
  width: number;
  height: number;
  columns: LadderColumn[];
  links: LadderLink[];
  core: LadderCore | null;
}

/**
 * The whole picture, from the rungs the engine returned.
 *
 * The band is made tall enough that every rung has its preferred room, so the
 * push in {@link layout} only ever has to move the rungs that are genuinely on
 * top of each other. It is the count of rungs that sets it rather than the
 * count of columns: the two spins interleave in energy, and both columns are
 * laid out on one scale so that the exchange splitting between a pair of them
 * can be read across the gap.
 */
export function buildLadder(levels: readonly OrbitalLevel[]): Ladder {
  const { core, shown } = foldCore(levels);
  const columns = orbitalColumns(shown);
  const headed = columns.length > 1;
  const band = Math.max(MIN_BAND, Math.min(MAX_BAND, (shown.length - 1) * STEP));
  const top = TOP + (headed ? HEADING : 0);
  const ys = layout(shown, band);
  const heights = new Map(shown.map((level, i) => [keyOf(level), top + ys[i]]));
  const span = WIDTH / Math.max(columns.length, 1);

  // Where each rung's lines start and end, for the links between the columns.
  const edges = new Map<string, { left: number; right: number; y: number }>();
  const drawn = columns.map((column, index) => {
    const middle = (index + 0.5) * span;
    // The labels go on the outside of the figure, the links down the middle.
    const outward = columns.length > 1 && index === columns.length - 1;
    const rungs = column.rows.map((row) => {
      const { level, frontier } = row;
      const key = keyOf(level);
      const y = heights.get(key) ?? top + band;
      const half = (level.count * LINE + (level.count - 1) * LINE_GAP) / 2;
      edges.set(key, { left: middle - half, right: middle + half, y });
      return {
        key,
        level,
        frontier,
        y,
        mark: occupationMark(level.occupation),
        tag: frontier === null ? '' : frontierLabel(frontier),
        tagX: outward ? middle + half + TAG_GAP : middle - half - TAG_GAP,
        tagAnchor: outward ? ('start' as const) : ('end' as const),
        orbitals: Array.from({ length: level.count }, (_, offset) => ({
          pick: { index: level.first + offset, spin: level.spin },
          x: middle - half + LINE / 2 + offset * (LINE + LINE_GAP),
          label: ladderRungLabel(row, offset, column.heading),
        })),
      };
    });
    return { spin: column.spin, heading: column.heading, x: middle, headingY: TOP, rungs };
  });

  return {
    width: WIDTH,
    height: top + band + (core > 0 ? CORE_ROW : 0) + BOTTOM,
    columns: drawn,
    links: linksBetween(levels, shown, edges),
    core:
      core > 0
        ? {
            orbitals: core,
            y: top + band + 10,
            textY: top + band + 21,
            text: coreText(core),
          }
        : null,
  };
}

/**
 * The faint lines joining the same orbital in the two spins.
 *
 * `partner` is an index into the array the engine returned, never into what is
 * left after the core was folded away, so the partner is looked up there and
 * then found by what it is. They cross: O2's fourth rung of one spin is the
 * fifth of the other, which is the thing this line is drawn to show.
 */
function linksBetween(
  levels: readonly OrbitalLevel[],
  shown: readonly OrbitalLevel[],
  edges: ReadonlyMap<string, { left: number; right: number; y: number }>,
): LadderLink[] {
  const links: LadderLink[] = [];
  for (const level of shown) {
    if (level.partner === null) continue;
    const other = levels[level.partner];
    const from = edges.get(keyOf(level));
    const to = other === undefined ? undefined : edges.get(keyOf(other));
    // Once per pair, left to right: both rungs name each other.
    if (from === undefined || to === undefined || from.right >= to.left) continue;
    links.push({ x1: from.right, y1: from.y, x2: to.left, y2: to.y });
  }
  return links;
}

/** A rung, named by what it is rather than by where it sits in any array. */
function keyOf(level: OrbitalLevel): string {
  return `${level.spin}:${level.first}`;
}

/** The line an arrow key moves to, within the column the picked one is in. */
export function step(ladder: Ladder, pick: OrbitalPick, delta: number): OrbitalPick | null {
  for (const column of ladder.columns) {
    const order = column.rungs.flatMap((rung) => rung.orbitals);
    const at = order.findIndex((orbital) => samePick(orbital.pick, pick));
    if (at >= 0) return order[at + delta]?.pick ?? null;
  }
  return null;
}

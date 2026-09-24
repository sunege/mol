/**
 * The two figures of "近づけてみる": what happens to a diatomic's levels as its
 * nuclei approach, and which atomic levels those came out of (V4-8).
 *
 * The distance scan is one calculation per separation, streamed as it is solved
 * (`worker/protocol.ts`), and this turns the points into coordinates: the
 * levels above, the total energy below, one distance axis under both. The
 * correlation diagram is the static companion - the free atoms on the outside,
 * the molecule between them - and it is placed by the same arithmetic as the
 * ladder of V4-6, so the two pictures are the same size and read the same way
 * (`components/ladder.ts`).
 *
 * Three rules run through all of it.
 *
 * **Only the distance carries a number.** The heights are energies, and LDA's
 * are out by a factor of several, so nothing vertical may be written down
 * (`docs/plan-v4.md`, decision 3). A separation is different in kind: it is the
 * length already on screen in the viewer, in the unit the panel already uses.
 * Every string either figure draws is built here, so `scan.test.ts` can walk
 * them and check it.
 *
 * **A separation that would not solve is a hole, not a failure.** Stretching a
 * polar bond with the spin state held fixed loses the solution - hydrogen
 * fluoride's does from 1.89 Angstrom out - and the energy that comes back
 * jumps by most of a Hartree. Those points still arrive, so they are kept out
 * of what sets the vertical scale, without which the real curve collapses into
 * a line, and the line is broken across them rather than drawn through them.
 *
 * **Lines are followed by symmetry species.** A diatomic has no reflection
 * parity to sort its levels by - it lies in every plane through its axis - so
 * what names a level is how many orbitals are degenerate with it: two for a pi
 * level, one for a sigma level. Levels of one species never cross, so the n-th
 * of a species at one separation is the n-th at the next, and that is the whole
 * of how a point is joined to the one before it.
 */
import type { OrbitalLevel, ScanLevel, ScanPoint } from '../worker/protocol';
import { foldCore, layout } from './ladder';
import {
  BOND_POPULATION_THRESHOLD,
  coreText,
  frontierLabel,
  occupationMark,
  occupationText,
  orbitalColumns,
  spinHeading,
  verdictBySymmetry,
  type Frontier,
} from './orbital';
import { SAME_VALLEY_KJ_PER_MOL } from '../records/log';
import { HARTREE_TO_KJ_PER_MOL } from '../records/units';

// --- what may be asked for ------------------------------------------------

/** A range of separations to solve: Angstrom, and how many points across it. */
export interface ScanRange {
  from: number;
  to: number;
  points: number;
}

/** A pair of elements to walk together, and the range worth walking. */
export interface ScanPreset extends ScanRange {
  id: string;
  /** As the button says it. */
  label: string;
  z: [number, number];
}

/**
 * How many separations the offered scans use, which is a wait of seconds.
 *
 * Measured in Node on the development machine (`docs/dev-notes.md`, "V4-9
 * の実測"): the five presets take 0.6 (He2) to 2.4 seconds (O2, open shell,
 * twice the levels), a point every 22-88 ms, so the "N / 27" count moves many
 * times a second and no time estimate is written beside it. A pair no preset
 * covers can be far slower - NO fails to converge at almost every point and
 * takes 29 seconds - but even then the count moves every second or so, and a
 * fixed estimate would be wrong by a factor of ten one way or the other.
 */
export const SCAN_POINTS = 27;

/**
 * The pairs the section offers, and the range each is worth seeing over.
 *
 * All five were measured through the engine before they were written down
 * (`docs/dev-notes.md`, "V4-7 の実装メモ"), and the ranges are what those
 * measurements say rather than round numbers:
 *
 * - **H2** is the whole of the story in one curve: a deep well, and two levels
 *   that fan apart all the way in. It stretches to three Angstrom without
 *   losing the solution.
 * - **He2** is the counter-example, and is here for its levels rather than for
 *   its energy: the bonding level and the antibonding one are both full, which
 *   is why there is no bond. Its well is 0.24 kJ/mol deep - a quarter of what
 *   the structure log calls one valley - so the figure declines to point at it
 *   ({@link lowestPoint}).
 * - **N2** and **O2** are the ones with a pi level to tell from a sigma level,
 *   and oxygen is the one with two sets of lines, its pi* half filled.
 * - **HF** stops short of 1.8 Angstrom on purpose: past 1.89 the fixed spin
 *   state loses the solution and the points that come back are noise.
 */
export const SCAN_PRESETS: ScanPreset[] = [
  { id: 'h2', label: 'H₂', z: [1, 1], from: 0.4, to: 3.0, points: SCAN_POINTS },
  { id: 'he2', label: 'He₂', z: [2, 2], from: 1.5, to: 4.0, points: SCAN_POINTS },
  { id: 'n2', label: 'N₂', z: [7, 7], from: 0.8, to: 2.0, points: SCAN_POINTS },
  { id: 'o2', label: 'O₂', z: [8, 8], from: 0.9, to: 2.1, points: SCAN_POINTS },
  { id: 'hf', label: 'HF', z: [1, 9], from: 0.6, to: 1.7, points: SCAN_POINTS },
];

/**
 * The offered pair that is the two atoms on screen, or none.
 *
 * What the section starts on, so that a molecule the app has a measured range
 * for gets that range rather than one worked out from where its atoms happen to
 * be. The curated ranges are the ones that were walked end to end before they
 * were written down; a range reaching much further out can find the engine
 * calling a degenerate pair degenerate at one separation and not at the next
 * ({@link buildScan}'s last note).
 */
export function presetFor(z: readonly number[]): ScanPreset | null {
  if (z.length !== 2) return null;
  return (
    SCAN_PRESETS.find(
      (preset) =>
        (preset.z[0] === z[0] && preset.z[1] === z[1]) ||
        (preset.z[0] === z[1] && preset.z[1] === z[0]),
    ) ?? null
  );
}

/**
 * The range for the two atoms already on screen, from how far apart they are.
 *
 * 0.7 to 1.8 times their separation, which puts whatever they are sitting at
 * inside the figure. Element-independent on purpose: the pair on screen may be
 * one no preset covers, and the one length that is known to be worth looking
 * at for it is the one the user put them at.
 *
 * Both factors are the curated presets' own, which were walked end to end:
 * their ranges run from 0.65-0.75 to 1.75-1.85 times the bond length for the
 * pairs heavier than H2. The first range was half to two and a half times, and
 * measured (`docs/dev-notes.md`, "V4-9 の実測") it went wrong at both ends.
 * Past about twice the bond, a stretched molecule stops being the one it was:
 * O2 at 2.37 Angstrom (1.96 times) comes back with its pi pairs split by up to
 * 0.008 Ha - a converged solution that has broken the symmetry, not a matter
 * of the degeneracy threshold - HF stops converging at 1.875 (2.0 times), CO at
 * 2.13, and O2's two 1s orbitals fall within the threshold of each other at
 * 2.65 and are counted as one pi pair. And at half the bond the wall is 4.1-4.7
 * Ha high over a well of 0.05-0.5, so the curve the figure is for is squashed
 * flat along its bottom; at 0.7 times the wall is 0.3-1.1 Ha.
 */
export function rangeAround(distance: number): ScanRange {
  const round = (value: number) => Math.round(value * 100) / 100;
  return {
    from: round(Math.max(0.3, distance * 0.7)),
    to: round(Math.max(0.6, distance * 1.8)),
    points: SCAN_POINTS,
  };
}

// --- words ----------------------------------------------------------------

export const SCAN_HEADING = '近づけてみる';

export const SCAN_TEASER =
  '2 つの原子を近づけると、電子の部屋の高さがどう変わるかを見られます。' +
  '離れていれば原子それぞれの部屋、近づけば分子の部屋です。';

/** Under the upper panel: how to read the lines. */
export const SCAN_LEVELS_HINT =
  '右へ行くほど 2 つの原子は遠く、左へ行くほど近くなります。' +
  '近づけて下がる線が結合をつくる部屋、上がる線がこわす部屋です。';

/** Under the lower panel, which is a different quantity from the upper one. */
export const SCAN_ENERGY_HINT =
  '下は分子全体のエネルギーです。いちばん低いところが、その 2 原子の落ち着く距離です。';

/** The one thing the marker does to the rest of the app. */
export const SCAN_MARKER_HINT =
  'スライダーを動かすと、その距離の形が 3D に置かれます。' +
  'その距離の部屋を見るには「この距離で計算」を押してください。';

/** Stopping a scan is the brutal kind of cancel, and takes the surface with it. */
export const SCAN_STOP_HINT = '途中でやめると、画面の等値面はもう一度計算し直しになります。';

/** The pair already on screen, which is offered beside the written-down ones. */
export const SCAN_CURRENT_ID = 'current';

export const SCAN_START = 'スキャンする';
export const SCAN_STOP = 'やめる';
export const SCAN_CALCULATE = 'この距離で計算';
export const SCAN_CURRENT_LABEL = 'いまの 2 原子';
export const SCAN_GROUP_LABEL = '近づける 2 原子';
export const SCAN_FIGURE_LABEL = '原子を近づけたときの部屋の高さと全エネルギー';

/** The section is only about two atoms approaching, so it needs two. */
export const SCAN_NEEDS_TWO = '原子が 2 つのときに、近づけたり離したりできます。';

/** Nothing has been scanned yet. */
export const SCAN_EMPTY = '上のどれかを選んで「スキャンする」を押すと、ここに図が出ます。';

/** How far along a running scan is. */
export function scanProgress(received: number, asked: number): string {
  return `${received} / ${asked} 点`;
}

/** The slider that moves the marker, and the separation it stands at now. */
export function markerLabel(distance: number): string {
  return `原子の間隔 ${distance.toFixed(2)} Å`;
}

// --- the distance scan ----------------------------------------------------

/** The viewBox, in the units the ladder is drawn in so the two figures match. */
const WIDTH = 260;
/**
 * Room on the left for a line's name, written just outside the plot: 12 held
 * a `σ` or a `π`, and a starred one is about 11 units wide (V4-10).
 */
const PLOT_LEFT = 16;
const PLOT_RIGHT = 248;
/** Baseline of a panel's heading, above the plot it names. */
const HEADING_GAP = 5;
const LEVELS_TOP = 15;
const LEVELS_HEIGHT = 168;
/** The dashed line where the innermost levels were cut away, and its words. */
const CORE_ROW = 18;
/** Between the two plots: enough for the lower one's heading. */
const PANEL_GAP = 20;
const ENERGY_HEIGHT = 58;
/** The distances under the axis, and the unit under them. */
const TICK_ROW = 11;
const UNIT_ROW = 11;
const BOTTOM = 4;

export interface ScanXY {
  x: number;
  y: number;
}

/** A word placed in the figure. */
export interface ScanText extends ScanXY {
  text: string;
}

/** One line of the upper panel: one symmetry species' n-th level, in one spin. */
export interface ScanCurve {
  /** Identifies the line inside the picture; not shown. */
  key: string;
  /** `0` for the only set of orbitals there is, `1` for the second one. */
  spin: number;
  /** The second spin's lines are broken, which is how they are told apart. */
  dashed: boolean;
  /** Orbitals degenerate with it: two for a pi level, one for a sigma level. */
  count: number;
  /** Unbroken runs of the line: a separation that would not solve breaks it. */
  segments: ScanXY[][];
  /**
   * `σ`, `σ*`, `π` or `π*`, at the left-hand end of the line, or null for
   * none ({@link diatomicName}).
   */
  species: ScanText | null;
  /**
   * The electrons in one of its orbitals, where the marker stands.
   *
   * Beside the marker rather than on the line, and on the side of it the
   * line's own spin puts it: a molecule with unpaired electrons has a pair of
   * lines a hair apart at nearly every height, and their two marks would be
   * drawn on top of each other in one column.
   */
  mark: (ScanText & { anchor: 'start' | 'end' }) | null;
  /** The whole line in words, for a reader who cannot see it. */
  label: string;
}

/** Where the marker stands: one separation, across both plots. */
export interface ScanMarker {
  index: number;
  distance: number;
  x: number;
  top: number;
  bottom: number;
}

/** One plot of the figure. */
export interface ScanPanel {
  heading: string;
  headingY: number;
  top: number;
  height: number;
}

export interface ScanTick {
  x: number;
  label: string;
  anchor: 'start' | 'middle' | 'end';
}

/** What was folded off the bottom: a line across the picture, and a sentence. */
export interface FoldedRow {
  orbitals: number;
  y: number;
  textY: number;
  text: string;
}

/** A picture ready to draw: nothing below this decides anything. */
export interface ScanFigure {
  width: number;
  height: number;
  levels: ScanPanel & { curves: ScanCurve[] };
  energy: ScanPanel & {
    /** Unbroken runs of the total-energy curve. */
    segments: ScanXY[][];
    /** The deepest separation, where there is a well worth pointing at. */
    lowest: ScanXY | null;
  };
  axis: { y: number; ticks: ScanTick[]; unit: string };
  marker: ScanMarker | null;
  core: FoldedRow | null;
  /** Lines of prose under the figure, which are HTML rather than SVG. */
  notes: string[];
}

/**
 * A well shallower than this is not pointed at, in Hartree.
 *
 * The structure log's own threshold for two shapes being the same valley
 * (`records/log.ts`), which is thirty times the scatter of the optimiser and
 * far below anything a lecture tells apart. Helium's dimer has a minimum -
 * 0.24 kJ/mol below where its curve flattens out (`docs/dev-notes.md`, "V4-7
 * の実装メモ") - and a figure that pointed at it would be teaching that two
 * helium atoms bond, which is the opposite of what the levels above it say.
 */
export const MIN_WELL = SAME_VALLEY_KJ_PER_MOL / HARTREE_TO_KJ_PER_MOL;

/**
 * The deepest separation, when the curve has a well deep enough to mean one and
 * the figure is wide enough to show it.
 *
 * Two ways of having nothing to point at. Depth is measured against the longest
 * separation solved rather than against the whole spread of the curve: what
 * makes a well a well is that pulling the atoms apart costs energy, and the
 * wall on the left - which helium has, and which is real - says nothing about
 * whether they are bound. And a curve still falling where the figure runs out
 * on the left has its bottom off the picture, so the lowest point drawn is the
 * edge of the window rather than anything about the molecule.
 */
export function lowestPoint(points: readonly ScanPoint[]): ScanPoint | null {
  const solved = points.filter((point) => point.converged);
  if (solved.length < 2) return null;
  const deepest = deepestOf(solved);
  if (deepest === solved[0]) return null;
  const apart = solved[solved.length - 1];
  return apart.energy - deepest.energy > MIN_WELL ? deepest : null;
}

function deepestOf(solved: readonly ScanPoint[]): ScanPoint {
  return solved.reduce((best, point) => (point.energy < best.energy ? point : best));
}

/**
 * Where the marker stands before anyone moves it.
 *
 * The bottom of the well, which is the separation the pair actually sits at;
 * and where there is no well to speak of, the shortest separation, where the
 * levels are furthest apart and the picture says the most.
 */
export function defaultMarker(points: readonly ScanPoint[]): number {
  const lowest = lowestPoint(points);
  return lowest === null ? 0 : points.indexOf(lowest);
}

/**
 * The whole figure, from the points received so far.
 *
 * `range` is what was asked for rather than what arrived, so the axis does not
 * slide under the curve while it is being drawn and a scan that was stopped
 * leaves the rest of the axis empty. The vertical scales are the other way
 * round - read off what has arrived - because there is nothing else to read
 * them off.
 */
export function buildScan(
  points: readonly ScanPoint[],
  range: ScanRange,
  markerIndex: number | null = null,
): ScanFigure {
  const solved = points.filter((point) => point.converged);
  const { folded, core } = foldedCurves(points);

  const levelsBottom = LEVELS_TOP + LEVELS_HEIGHT;
  const energyTop = levelsBottom + (core > 0 ? CORE_ROW : 0) + PANEL_GAP;
  const energyBottom = energyTop + ENERGY_HEIGHT;

  const xOf = (distance: number) =>
    range.to > range.from
      ? PLOT_LEFT + ((distance - range.from) / (range.to - range.from)) * (PLOT_RIGHT - PLOT_LEFT)
      : (PLOT_LEFT + PLOT_RIGHT) / 2;

  const levelY = scaleOf(
    solved.flatMap((point) =>
      point.levels
        .filter((_, index) => !folded.has(keyAt(point.levels, index)))
        .map((level) => level.energy),
    ),
    LEVELS_TOP,
    LEVELS_HEIGHT,
  );
  const energyY = scaleOf(solved.map((point) => point.energy), energyTop, ENERGY_HEIGHT);

  const index = markerAt(points, markerIndex);
  const marker =
    index === null
      ? null
      : {
          index,
          distance: points[index].distance,
          x: xOf(points[index].distance),
          top: LEVELS_TOP,
          bottom: energyBottom,
        };

  const spins = new Set(points.flatMap((point) => point.levels.map((level) => level.spin)));
  const reference = solved.length === 0 ? null : points.indexOf(deepestOf(solved));
  const curves = buildCurves(points, folded, spins.size > 1, xOf, levelY, marker, reference);
  const lowest = lowestPoint(points);
  return {
    width: WIDTH,
    height: energyBottom + TICK_ROW + UNIT_ROW + BOTTOM,
    levels: {
      heading: '部屋の高さ',
      headingY: LEVELS_TOP - HEADING_GAP,
      top: LEVELS_TOP,
      height: LEVELS_HEIGHT,
      curves,
    },
    energy: {
      heading: '全エネルギー',
      headingY: energyTop - HEADING_GAP,
      top: energyTop,
      height: ENERGY_HEIGHT,
      segments: split(
        points.map((point) =>
          point.converged ? { x: xOf(point.distance), y: energyY(point.energy) } : null,
        ),
      ),
      lowest: lowest === null ? null : { x: xOf(lowest.distance), y: energyY(lowest.energy) },
    },
    axis: { y: energyBottom, ticks: ticksOf(range, xOf), unit: '距離（Å）' },
    marker,
    core: core > 0 ? foldedRow(core, levelsBottom + 5) : null,
    notes: notesOf(points, lowest, curves, solved.length),
  };
}

/** Every word the scan figure puts on screen, and nothing that it does not. */
export function scanTexts(figure: ScanFigure): string[] {
  return [
    figure.levels.heading,
    figure.energy.heading,
    figure.axis.unit,
    ...figure.levels.curves.flatMap((curve) => [
      curve.species?.text ?? '',
      curve.mark?.text ?? '',
      curve.label,
    ]),
    figure.core?.text ?? '',
  ];
}

/** The distances written under the axis, which are the one numbers here. */
export function scanAxisLabels(figure: ScanFigure): string[] {
  return figure.axis.ticks.map((tick) => tick.label);
}

/**
 * Which lines are the innermost electrons, and how many orbitals that is.
 *
 * The cut is made once, on the shortest separation that solved, and then holds
 * for the whole figure: deciding it afresh at every point would let a line drop
 * out of the picture half way along. The rule itself is the ladder's - the
 * first gap from the bottom that is wider than everything above it - so the two
 * figures fold the same electrons away (`components/ladder.ts`).
 */
function foldedCurves(points: readonly ScanPoint[]): { folded: Set<string>; core: number } {
  const first = points.find((point) => point.converged);
  if (first === undefined) return { folded: new Set(), core: 0 };
  const { core, shown } = foldCore(first.levels);
  const kept = new Set<ScanLevel>(shown);
  const folded = new Set<string>();
  first.levels.forEach((level, index) => {
    if (!kept.has(level)) folded.add(keyAt(first.levels, index));
  });
  return { folded, core };
}

/**
 * The lines of the upper panel, each followed from point to point by species.
 *
 * The n-th sigma level is joined to the n-th sigma level of the next
 * separation and never to a pi level, because levels of one species do not
 * cross while levels of different species do. Nothing is sorted here: the
 * engine returns them lowest first, and counting them in that order is what
 * gives an "n-th" at all.
 */
function buildCurves(
  points: readonly ScanPoint[],
  folded: ReadonlySet<string>,
  twoSpins: boolean,
  xOf: (distance: number) => number,
  levelY: (energy: number) => number,
  marker: ScanMarker | null,
  reference: number | null,
): ScanCurve[] {
  const curves = new Map<string, ScanCurve>();
  const samples = new Map<string, Array<ScanXY | null>>();
  // What each line is named by: its level at the deepest separation, which is
  // the molecule the pair makes (for two unlike atoms, where the name is read
  // off the overlap population and that changes along the line).
  const named = new Map<string, ScanLevel>();
  points.forEach((point, index) => {
    point.levels.forEach((level, position) => {
      const key = keyAt(point.levels, position);
      if (folded.has(key)) return;
      let curve = curves.get(key);
      if (curve === undefined) {
        curve = {
          key,
          spin: level.spin,
          dashed: level.spin > 0,
          count: level.count,
          segments: [],
          species: null,
          mark: null,
          label: '',
        };
        curves.set(key, curve);
        samples.set(key, Array.from({ length: points.length }, () => null));
      }
      if (!point.converged) return;
      if (index === reference || !named.has(key)) named.set(key, level);
      samples.get(key)![index] = { x: xOf(point.distance), y: levelY(level.energy) };
      if (marker !== null && marker.index === index) {
        // One spin's marks to the left of the marker and the other's to the
        // right, so a pair of lines a hair apart keeps two readable marks.
        const right = twoSpins ? level.spin > 0 : marker.x < (PLOT_LEFT + PLOT_RIGHT) / 2;
        curve.mark = {
          text: occupationMark(level.occupation),
          x: marker.x + (right ? 4 : -4),
          y: levelY(level.energy) - 3,
          anchor: right ? 'start' : 'end',
        };
      }
    });
  });
  for (const [key, curve] of curves) {
    curve.segments = split(samples.get(key)!);
    const start = curve.segments[0]?.[0];
    const level = named.get(key);
    const species =
      level === undefined ? '' : diatomicName(level.count, level.inversion, level.overlap);
    if (level !== undefined) curve.label = curveLabel(key, level, species, twoSpins);
    // Outside the plot, at the end of the line where the levels are furthest
    // apart: two lines that have run together at the right-hand end would have
    // their names on top of each other. A molecule with unpaired electrons
    // names only the first spin's lines, since the second's are the same
    // species in the same order and would double the column for nothing.
    if (start !== undefined && species !== '' && curve.spin === 0) {
      curve.species = { text: species, x: start.x - 3, y: start.y + 3 };
    }
  }
  const drawn = [...curves.values()];
  // Neither of these is data: a name and a count of electrons belong to the
  // line they sit beside, and where two lines have run together the reader can
  // see that from the lines. Two of them written on top of each other says
  // nothing at all, so they are pushed apart exactly as the ladder's rungs are
  // (`components/ladder.ts`), each within its own column.
  spread(drawn.map((curve) => curve.species));
  for (const anchor of ['start', 'end'] as const) {
    spread(drawn.map((curve) => (curve.mark?.anchor === anchor ? curve.mark : null)));
  }
  return drawn;
}

/** The least room between two of the words beside the lines, in viewBox units. */
const LABEL_GAP = 8.5;

/** Keeps a column of words legible, in the order the lines put them in. */
function spread(labels: readonly (ScanXY | null)[]): void {
  const rows = labels.filter((label) => label !== null).sort((a, b) => a.y - b.y);
  if (rows.length === 0) return;
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].y - rows[i - 1].y < LABEL_GAP) rows[i].y = rows[i - 1].y + LABEL_GAP;
  }
  const bottom = LEVELS_TOP + LEVELS_HEIGHT;
  if (rows[rows.length - 1].y > bottom) {
    rows[rows.length - 1].y = bottom;
    for (let i = rows.length - 2; i >= 0; i--) {
      if (rows[i + 1].y - rows[i].y < LABEL_GAP) rows[i].y = rows[i + 1].y - LABEL_GAP;
    }
  }
  for (const row of rows) row.y = Math.max(row.y, LEVELS_TOP + 7);
}

/**
 * A level's place in the figure: its spin, its species, and which of that
 * species it is counting from the bottom.
 *
 * Read off the position in the array the engine returned, which is the whole of
 * what identifies a line from one separation to the next.
 */
function keyAt(levels: readonly ScanLevel[], position: number): string {
  const level = levels[position];
  let ordinal = 0;
  for (let i = 0; i < position; i++) {
    const other = levels[i];
    if (other.spin === level.spin && other.count === level.count) {
      if (other.inversion === level.inversion) ordinal += 1;
    }
  }
  // Two like atoms: gerade and ungerade are two species, which may cross.
  const parity = level.inversion === null ? '' : level.inversion === 1 ? 'g' : 'u';
  return `${level.spin}:${level.count}${parity}:${ordinal}`;
}

/**
 * The symmetry species, by how many orbitals are degenerate with the level.
 *
 * A diatomic in this description has only the two: one orbital on the rung is a
 * sigma level, two are a pi level. There is no third case over H-Ar, and a rung
 * of some other size is left unnamed rather than guessed at.
 */
function speciesOf(count: number): string {
  if (count === 1) return 'σ';
  return count === 2 ? 'π' : '';
}

/**
 * The name the textbook gives a rung of a diatomic: σ or π from how many
 * orbitals are on it, starred where it is antibonding. `''` where that cannot
 * be said, rather than a guess.
 *
 * Two like atoms are named by symmetry ({@link verdictBySymmetry}); two unlike
 * ones by the overlap population between them, past the threshold the words
 * under the ladder use, so a σ* here and "反結合性" there never disagree. A
 * rung that is neither - hydrogen fluoride's lone pairs - carries no star, as
 * in the textbook.
 */
export function diatomicName(
  count: number,
  inversion: 1 | -1 | null,
  overlap: number | undefined,
): string {
  const species = speciesOf(count);
  if (species === '') return '';
  const bySymmetry = verdictBySymmetry(count, inversion);
  if (bySymmetry !== null) return bySymmetry === 'antibonding' ? `${species}*` : species;
  if (overlap === undefined) return '';
  return overlap < -BOND_POPULATION_THRESHOLD ? `${species}*` : species;
}

/** One line, read aloud: where it sits in the picture is all it otherwise says. */
function curveLabel(key: string, level: ScanLevel, species: string, twoSpins: boolean): string {
  const ordinal = Number(key.split(':')[2]) + 1;
  const said = twoSpins ? [spinHeading(level.spin === 0 ? 'up' : 'down') ?? ''] : [];
  said.push(species === '' ? `下から ${ordinal} つめ` : `${species} の下から ${ordinal} つめ`);
  said.push(occupationText(level.occupation));
  return said.join('、');
}

/**
 * A linear energy-to-height map, from the values that are worth scaling to.
 *
 * Only the separations that solved are passed in. Hydrogen fluoride's stop
 * solving past 1.89 Angstrom and the energies that come back are most of a
 * Hartree away, which is several times the whole of the well: scaled to include
 * them, the curve everyone came to see is a flat line.
 */
function scaleOf(
  values: readonly number[],
  top: number,
  height: number,
): (value: number) => number {
  if (values.length === 0) return () => top + height / 2;
  const low = Math.min(...values);
  const span = Math.max(...values) - low;
  if (span <= 0) return () => top + height / 2;
  return (value) => top + height - ((value - low) / span) * height;
}

/** Splits a sampled line into its unbroken runs, dropping the holes. */
function split(samples: readonly (ScanXY | null)[]): ScanXY[][] {
  const segments: ScanXY[][] = [];
  let run: ScanXY[] = [];
  for (const sample of samples) {
    if (sample === null) {
      if (run.length > 0) segments.push(run);
      run = [];
    } else {
      run.push(sample);
    }
  }
  if (run.length > 0) segments.push(run);
  return segments;
}

/** The marker's point, clamped to what has arrived. */
function markerAt(points: readonly ScanPoint[], wanted: number | null): number | null {
  if (points.length === 0) return null;
  return Math.min(Math.max(wanted ?? defaultMarker(points), 0), points.length - 1);
}

/**
 * The distances written under the axis: round numbers, and at most seven.
 *
 * The smallest step that does not crowd the axis, so the labels come out the
 * ones anyone would have chosen - halves for hydrogen's 0.4 to 3.0, fifths for
 * nitrogen's 0.8 to 2.0.
 */
function ticksOf(range: ScanRange, xOf: (distance: number) => number): ScanTick[] {
  const steps = [0.1, 0.2, 0.25, 0.5, 1];
  const fits = (step: number) => Math.floor(range.to / step) - Math.ceil(range.from / step) <= 6;
  const step = steps.find(fits) ?? steps[steps.length - 1];
  const decimals = Math.round(step * 100) % 10 === 0 ? 1 : 2;
  const ticks: ScanTick[] = [];
  for (let n = Math.ceil(range.from / step - 1e-6); n * step <= range.to + 1e-6; n++) {
    const x = xOf(n * step);
    ticks.push({
      x,
      label: (n * step).toFixed(decimals),
      anchor: x < PLOT_LEFT + 8 ? 'start' : x > PLOT_RIGHT - 8 ? 'end' : 'middle',
    });
  }
  return ticks;
}

/** The dashed line the innermost levels were cut at, and what it says. */
function foldedRow(orbitals: number, y: number): FoldedRow {
  return { orbitals, y, textY: y + 9, text: coreText(orbitals) };
}

/**
 * What the figure cannot draw, in prose under it.
 *
 * Two things it would otherwise be read as saying: that the gap in a curve is
 * a curve going somewhere, and - for helium - that the dip at the bottom is a
 * bond. The second is the whole reason helium is offered: its well is a quarter
 * of what this app elsewhere calls one valley, so the honest sentence is that
 * there is nothing there, and that the picture worth looking at is the one
 * above it.
 */
function notesOf(
  points: readonly ScanPoint[],
  lowest: ScanPoint | null,
  curves: readonly ScanCurve[],
  solvedCount: number,
): string[] {
  const notes: string[] = [];
  const solved = points.filter((point) => point.converged);
  // Which is the one thing about the upper panel that cannot be read off it:
  // both the line style and the side the electrons are drawn on say the same
  // thing, and neither says it in words.
  if (points.some((point) => point.levels.some((level) => level.spin > 0))) {
    notes.push(
      '実線と縦線の左側の ● が上向きのスピン、破線と右側の ● が下向きのスピンです。' +
        '同じ部屋でも、向きによって高さが違います。',
    );
  }
  if (lowest !== null) {
    notes.push(`いちばん低いのは ${lowest.distance.toFixed(2)} Å のときです。`);
  } else if (solved.length >= 2) {
    notes.push(
      deepestOf(solved) === solved[0]
        ? 'この図の中では左端がいちばん低く、落ち着く距離はもっと近いところにあります。'
        : 'いちばん低いところと、離したときとの差がごくわずかで、谷と呼べるものがありません。' +
            '上の図のほうを見てください。',
    );
  }
  if (solved.length < points.length) {
    notes.push('電子の配置が求まらなかった距離があり、そこは線が切れています。');
  }
  // A line that is not drawn at every separation that solved is one the engine
  // stopped calling degenerate: far apart, a pair that is one rung at the bond
  // length drifts a fraction of a hair and comes back as two rungs of one
  // orbital each, so the pair's line ends and two new lines begin. The picture
  // cannot join them - a line is followed along its own symmetry species, and
  // those two are not it - so it says what happened instead.
  if (curves.some((curve) => samples(curve) < solvedCount)) {
    notes.push(
      '遠く離したところでは、同じ高さだった部屋がごくわずかに分かれて別々の線になります。' +
        'そこで線が切れ、本数が増えているのはそのためです。',
    );
  }
  return notes;
}

/** How many separations a line was drawn at, across its unbroken runs. */
function samples(curve: ScanCurve): number {
  return curve.segments.reduce((total, segment) => total + segment.length, 0);
}

// --- the correlation diagram ----------------------------------------------

/**
 * Room for the column headings above the diagram.
 *
 * The top rung's circles and its HOMO or LUMO label stand about ten units above
 * its line, so the headings sit well clear of that (V4-10: at 22, O2's
 * "下向き" was written over the circles of the rung under it).
 */
const CORR_TOP = 32;
const CORR_HEADING_Y = 13;
/**
 * The width of a free atom's column: its line, and the name of the atomic
 * orbital on the outside of it. The molecule's columns share what is left,
 * which for a molecule with unpaired electrons is what makes room for a name
 * on the inner side of each of its two columns.
 */
const CORR_ATOM_SPAN = 50;
const CORR_STEP = 18;
const CORR_MIN_BAND = 140;
const CORR_MAX_BAND = 420;
/** One orbital, as a short horizontal line. */
export const CORR_LINE = 20;
const CORR_LINE_GAP = 5;
/** Room between a rung's lines and the HOMO or LUMO label beside them. */
const CORR_TAG_GAP = 3;

export const CORRELATION_HEADING = '原子の部屋から分子の部屋へ';

export const CORRELATION_LABEL = '原子の部屋と分子の部屋のつながり';

export const CORRELATION_HINT =
  '左右がばらばらの原子の部屋、まん中がくっついてできた分子の部屋です。' +
  '細い線は、どの原子の部屋からできた部屋かを結んでいます。';

/**
 * The heading of a spin's column here, which is not the ladder's wording.
 *
 * A molecule with unpaired electrons puts four columns in the width of one
 * panel, and "上向きのスピン" written over the second of them runs into the
 * third. The ladder above says it in full, a few centimetres up the panel, so
 * the short form here is a repetition rather than the only place it is said.
 */
function columnHeading(heading: string | null): string {
  if (heading === null) return '分子';
  return heading.replace('のスピン', '');
}

/**
 * Below this much of a rung, the atom is not what the rung is made of.
 *
 * A tenth of an orbital is the tail of the other atom's lobe reaching across,
 * not a share of it, and a line drawn for that would say the rung was built out
 * of something it was not. It matters only for two unlike atoms - between two
 * like ones every rung is half and half.
 *
 * Where it sits was measured on HF, HCl, CO, NO, LiH and NaH at their bond
 * lengths (`docs/dev-notes.md`, "V4-9 の実測"). The smaller atom's share of a
 * rung comes in two groups there: 0.13 to 0.152 (HF's 2sigma 0.142, HCl's
 * 4sigma 0.147, the oxygen end of CO's HOMO 0.152, two of NaH's - each an
 * orbital of one atom with a little of the other mixed in) and then 0.218 and
 * up. The first value tried, 0.15, sat inside the first group, so which of them
 * got a line was
 * down to the third decimal; this is the middle of the gap. The shares move
 * with the separation - HF's 2sigma is 0.205 at 0.6 Angstrom and 0.086 at 1.1
 * - so a line can still appear or go as the marker is dragged, which is what
 * it should do.
 */
const LINK_FLOOR = 0.18;

/**
 * What one rung of the molecule is made of, from `orbitalCharacter`: how much
 * of it sits on each of the two atoms ({@link atomFraction}), and the overlap
 * population between them, whose sign is whether it is bonding.
 */
export interface RungMakeup {
  shares: readonly number[];
  overlap: number;
}

/** One line of the diagram. */
export interface CorrelationRung {
  key: string;
  /** Centre of the rung; a link meets it {@link CorrelationRung.half} away. */
  x: number;
  y: number;
  half: number;
  /** Centre of each of the rung's lines: one apiece, two where it is a pi. */
  lines: number[];
  /** The electrons in one of its orbitals, or nothing for a free atom's. */
  mark: string;
  /** `HOMO`, `LUMO`, or nothing at all. */
  tag: string;
  tagX: number;
  tagAnchor: 'start' | 'end';
  label: string;
  /**
   * What the textbook calls it: `2p` for a free atom's, `σ*` or `π` for the
   * molecule's. Written on the far side of the lines from the tag.
   */
  name: string;
  nameX: number;
  nameAnchor: 'start' | 'end';
  /** Orbitals on the rung, which is how many lines are drawn side by side. */
  count: number;
}

export interface CorrelationColumn {
  key: string;
  heading: string;
  headingY: number;
  x: number;
  rungs: CorrelationRung[];
}

export interface CorrelationLink {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface CorrelationFigure {
  width: number;
  height: number;
  columns: CorrelationColumn[];
  links: CorrelationLink[];
  core: FoldedRow | null;
}

/**
 * How much of one orbital sits on one atom, as a fraction of the whole of it.
 *
 * Mulliken's division of the electrons between the nuclei, out of the matrix
 * `orbitalCharacter` already returns: an atom's gross population is its own
 * diagonal entry plus half of each entry it shares with another atom, which is
 * half of its row either way, and the fractions over all the atoms add to one.
 * It is a convention for splitting electrons up rather than a measurement -
 * which is why it decides here which line joins which, and is never written
 * down as a number.
 */
export function atomFraction(populations: ArrayLike<number>, atoms: number, atom: number): number {
  let total = 0;
  let here = 0;
  for (let a = 0; a < atoms; a++) {
    for (let b = 0; b < atoms; b++) {
      const value = populations[a * atoms + b] ?? 0;
      total += value;
      if (a === atom) here += value;
    }
  }
  return total === 0 ? 0 : here / total;
}

/** The atomic orbitals of H-Ar in this description, one name per degenerate set. */
const ATOMIC_SHELLS: ReadonlyArray<readonly [string, number]> = [
  ['1s', 1],
  ['2s', 1],
  ['2p', 3],
  ['3s', 1],
  ['3p', 3],
];

/**
 * The name of each of a free atom's orbitals, lowest first, or `''` for the
 * second and third of a p set (the name is written once per height).
 *
 * Read off the count, not the energy: the smallest description has one
 * function per atomic orbital, so the n-th degenerate set from the bottom is
 * the n-th shell of the table above, 1s < 2s < 2p < 3s < 3p for every neutral
 * atom from H to Ar. Where the sets do not come out the size the table says,
 * nothing is named rather than something misnamed.
 */
export function atomicOrbitalNames(energies: readonly number[]): string[] {
  const names: string[] = [];
  let at = 0;
  for (const [name, size] of ATOMIC_SHELLS) {
    if (at >= energies.length) break;
    const set = energies.slice(at, at + size);
    const sameHeight =
      set.length === size &&
      set.every((energy) => Math.abs(energy - set[0]) < 1e-4) &&
      (energies[at + size] === undefined || Math.abs(energies[at + size] - set[0]) >= 1e-4);
    if (!sameHeight) return energies.map(() => '');
    names.push(name, ...Array.from({ length: size - 1 }, () => ''));
    at += size;
  }
  return at === energies.length ? names : energies.map(() => '');
}

/**
 * The correlation diagram: two free atoms, the molecule they make, and the
 * lines between them.
 *
 * `atoms` is one list of orbital energies per nucleus, as the free atom has
 * them - one column each, because a free atom is solved with its partly filled
 * shell spread evenly and so does not split by spin. `levels` is the molecule's
 * ladder, one column when it is closed and two when it is not. `weights[i]` is
 * what `levels[i]` is made of ({@link RungMakeup}), and an empty list simply
 * draws no lines between the columns and names none of the molecule's rungs.
 *
 * Every column is laid out by the ladder's own `layout` on one scale, so a rung
 * of the molecule sits at the height its energy puts it at against the atomic
 * levels either side - which is the thing the picture is for. The innermost
 * electrons are folded off the bottom by the molecule's own gap, and the atomic
 * levels below that cut go with them: they are the same electrons.
 */
export function buildCorrelation(
  atoms: readonly (readonly number[])[],
  symbols: readonly string[],
  levels: readonly OrbitalLevel[],
  makeup: readonly RungMakeup[],
): CorrelationFigure {
  const { core, shown } = foldCore(levels);
  const cut = shown.length === 0 ? -Infinity : Math.min(...shown.map((level) => level.energy));
  // The same electrons on either side: an atomic level below the molecule's cut
  // is the shell those folded orbitals were made out of.
  const kept = [0, 1].map((side) => {
    const energies = atoms[side] ?? [];
    const names = atomicOrbitalNames(energies);
    return energies.flatMap((energy, at) => (energy >= cut ? [{ energy, name: names[at] }] : []));
  });
  const sides = kept.map((side) => side.map(({ energy }) => energy));

  const columns = orbitalColumns(shown);
  const stacked = [
    ...sides[0].map((energy) => ({ energy })),
    ...shown.map((level) => ({ energy: level.energy })),
    ...sides[1].map((energy) => ({ energy })),
  ];
  const band = Math.max(CORR_MIN_BAND, Math.min(CORR_MAX_BAND, (stacked.length - 1) * CORR_STEP));
  const ys = layout(stacked, band).map((y) => CORR_TOP + y);
  const span = (WIDTH - 2 * CORR_ATOM_SPAN) / columns.length;
  const index = new Map(levels.map((level, at) => [level, at]));

  const leftYs = ys.slice(0, sides[0].length);
  const rightYs = ys.slice(ys.length - sides[1].length);
  const heights = new Map(
    shown.map((level, index) => [rungKey(level), ys[sides[0].length + index]]),
  );

  const atomColumn = (side: number, heightOf: readonly number[]) => {
    const x = side === 0 ? CORR_ATOM_SPAN / 2 : WIDTH - CORR_ATOM_SPAN / 2;
    // The name goes on the outside, where no link comes in.
    const outward = side === 0 ? -1 : 1;
    return {
      key: side === 0 ? 'left' : 'right',
      heading: symbols[side] ?? '',
      headingY: CORR_HEADING_Y,
      x,
      rungs: kept[side].map(({ name }, at) => ({
        key: `${side}:${at}`,
        x,
        y: heightOf[at],
        half: CORR_LINE / 2,
        lines: [x],
        mark: '',
        tag: '',
        tagX: x,
        tagAnchor: 'start' as const,
        label: [`${symbols[side] ?? ''} の原子の部屋`, ...(name === '' ? [] : [name])].join('、'),
        name,
        nameX: x + outward * (CORR_LINE / 2 + CORR_TAG_GAP),
        nameAnchor: side === 0 ? ('end' as const) : ('start' as const),
        count: 1,
      })),
    };
  };

  const drawn: CorrelationColumn[] = [
    atomColumn(0, leftYs),
    ...columns.map((column, at) => {
      const middle = CORR_ATOM_SPAN + (at + 0.5) * span;
      // Tag and name on opposite sides of the lines. The second of two spin
      // columns is the mirror of the first, so the two names meet in the gap
      // between the columns and each tag has the outside to itself.
      const mirrored = columns.length === 2 && at === 1;
      return {
        key: `mo${at}`,
        heading: columnHeading(column.heading),
        headingY: CORR_HEADING_Y,
        x: middle,
        rungs: column.rows.map((row) => {
          const half = (row.level.count * CORR_LINE + (row.level.count - 1) * CORR_LINE_GAP) / 2;
          const name = diatomicName(
            row.level.count,
            row.level.inversion,
            makeup[index.get(row.level) ?? -1]?.overlap,
          );
          const before = middle - half - CORR_TAG_GAP;
          const after = middle + half + CORR_TAG_GAP;
          return {
            key: rungKey(row.level),
            x: middle,
            y: heights.get(rungKey(row.level)) ?? CORR_TOP + band,
            half,
            lines: Array.from(
              { length: row.level.count },
              (_, offset) => middle - half + CORR_LINE / 2 + offset * (CORR_LINE + CORR_LINE_GAP),
            ),
            mark: occupationMark(row.level.occupation),
            // Above the line rather than level with it: the links come in at
            // the rung's own height, on both sides of a middle column.
            tag: row.frontier === null ? '' : frontierLabel(row.frontier),
            tagX: mirrored ? after : before,
            tagAnchor: mirrored ? ('start' as const) : ('end' as const),
            label: rungLabel(row.level, row.frontier, column.heading, name),
            name,
            nameX: mirrored ? before : after,
            nameAnchor: mirrored ? ('end' as const) : ('start' as const),
            count: row.level.count,
          };
        }),
      };
    }),
    atomColumn(1, rightYs),
  ];

  return {
    width: WIDTH,
    height: CORR_TOP + band + (core > 0 ? CORE_ROW : 0) + BOTTOM + 6,
    columns: drawn,
    links: correlationLinks(columns, sides, makeup, levels, drawn),
    core: core > 0 ? foldedRow(core, CORR_TOP + band + 8) : null,
  };
}

/** Every word the correlation diagram puts on screen. */
export function correlationTexts(figure: CorrelationFigure): string[] {
  return [
    ...figure.columns.flatMap((column) => [
      column.heading,
      ...column.rungs.flatMap((rung) => [rung.mark, rung.tag, rung.label, rung.name]),
    ]),
    figure.core?.text ?? '',
  ];
}

function rungKey(level: OrbitalLevel): string {
  return `${level.spin}:${level.first}`;
}

function rungLabel(
  level: OrbitalLevel,
  frontier: Frontier | null,
  heading: string | null,
  name: string,
): string {
  const said = heading === null ? ['分子の部屋'] : [heading];
  if (name !== '') said.push(name);
  said.push(occupationText(level.occupation));
  if (frontier !== null) said.push(frontierLabel(frontier));
  return said.join('、');
}

/**
 * Which atomic level each of the molecule's rungs came out of.
 *
 * The count decides it, not the energy. Walking one spin's orbitals from the
 * bottom and adding up how much of each sits on one atom, the running total
 * passes one as that atom's lowest orbital is used up, two as its next is, and
 * so on - an atom with five orbitals has exactly five to give, whatever the
 * molecule did with them. So the atomic level a rung is joined to is the one
 * its own stretch of that total covers most of, which for two like atoms is the
 * textbook picture of a bonding and an antibonding orbital per atomic level,
 * and for two unlike ones follows the electrons to the atom that holds them.
 *
 * The folded core needs no allowance: the orbitals cut off the bottom used up
 * exactly the atomic levels cut off with them, so both totals start at zero.
 */
function correlationLinks(
  columns: readonly { rows: readonly { level: OrbitalLevel }[] }[],
  sides: readonly (readonly number[])[],
  makeup: readonly RungMakeup[],
  levels: readonly OrbitalLevel[],
  drawn: readonly CorrelationColumn[],
): CorrelationLink[] {
  const rungs = new Map(drawn.flatMap((column) => column.rungs.map((rung) => [rung.key, rung])));
  const index = new Map(levels.map((level, at) => [level, at]));
  const links: CorrelationLink[] = [];
  for (const side of [0, 1]) {
    const atomRungs = drawn[side === 0 ? 0 : drawn.length - 1].rungs;
    for (const column of columns) {
      let total = 0;
      // The rows come highest first, and the running total counts from the
      // bottom: the lowest orbital is the one that uses up the lowest level.
      for (const row of [...column.rows].reverse()) {
        const share = (makeup[index.get(row.level) ?? -1]?.shares[side] ?? 0) * row.level.count;
        const slot = bestSlot(total, total + share, sides[side].length);
        total += share;
        if (share < LINK_FLOOR || slot === null) continue;
        const from = rungs.get(rungKey(row.level));
        const to = atomRungs[slot];
        if (from === undefined || to === undefined) continue;
        links.push(
          side === 0
            ? { x1: to.x + to.half, y1: to.y, x2: from.x - from.half, y2: from.y }
            : { x1: from.x + from.half, y1: from.y, x2: to.x - to.half, y2: to.y },
        );
      }
    }
  }
  return links;
}

/** The atomic level a stretch of the running total overlaps most of. */
function bestSlot(from: number, to: number, available: number): number | null {
  let best: number | null = null;
  let most = 0;
  for (let slot = 0; slot < available; slot++) {
    const overlap = Math.min(to, slot + 1) - Math.max(from, slot);
    if (overlap > most) {
      most = overlap;
      best = slot;
    }
  }
  return best;
}

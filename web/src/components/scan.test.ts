import { describe, expect, it } from 'vitest';
import {
  CHARGED_REACH,
  MIN_WELL,
  NEUTRAL_REACH,
  SCAN_CHARGED_NOTE,
  SCAN_HEADING,
  SCAN_INTRO,
  SCAN_PART_HEADING,
  SCAN_PRESETS,
  SCAN_TEASER,
  atomFraction,
  atomPickWords,
  atomicOrbitalNames,
  buildCorrelation,
  buildScan,
  correlationTexts,
  defaultMarker,
  diagramEnds,
  diatomicName,
  lowestPoint,
  presetFor,
  rangeAround,
  scanAxisLabels,
  scanPairFor,
  scanTexts,
  type CorrelationLink,
  type ScanRange,
} from './scan';
import { MAX_SCAN_POINTS, type OrbitalLevel, type ScanLevel, type ScanPoint } from '../worker/protocol';
import type { OrbitalPick } from './orbital';

/** One separation, with its rungs given outright, lowest first. */
function withLevels(
  distance: number,
  energy: number,
  levels: ScanLevel[],
  converged = true,
): ScanPoint {
  return { distance, energy, converged, levels };
}

/**
 * Hydrogen: a bonding level and an antibonding one, fanning apart as the nuclei
 * approach, over a curve with a well in it.
 *
 * The shape of the measured one (`docs/dev-notes.md`, "V4-7 の実装メモ": -1.120
 * at 0.70 Angstrom against -0.796 at 3.0), with the numbers in between written
 * here - what the figure does with them turns on the shape, not on the values.
 */
const HYDROGEN: ScanPoint[] = [
  withLevels(0.4, -0.95, [level(-0.75, 2), level(0.6)]),
  withLevels(0.7, -1.12, [level(-0.6, 2), level(0.3)]),
  withLevels(1.2, -1.05, [level(-0.5, 2), level(0.05)]),
  withLevels(2.0, -0.85, [level(-0.35, 2), level(-0.15)]),
  withLevels(3.0, -0.8, [level(-0.26, 2), level(-0.24)]),
];

/** Helium: both levels full, and a curve that flattens out instead of a well. */
const HELIUM: ScanPoint[] = [
  withLevels(1.5, -5.5287, [level(-0.9, 2), level(-0.3, 2)]),
  withLevels(2.0, -5.5425, [level(-0.87, 2), level(-0.4, 2)]),
  withLevels(2.46, -5.543866, [level(-0.85, 2), level(-0.45, 2)]),
  withLevels(3.0, -5.54382, [level(-0.84, 2), level(-0.47, 2)]),
  withLevels(4.0, -5.543777, [level(-0.83, 2), level(-0.48, 2)]),
];

function level(
  energy: number,
  occupation = 0,
  count = 1,
  spin = 0,
  inversion: 1 | -1 | null = null,
  overlap = 0,
): ScanLevel {
  return { energy, occupation, count, spin, overlap, inversion };
}

const RANGE = (from: number, to: number, points: number): ScanRange => ({ from, to, points });

describe('following a level from one separation to the next', () => {
  const figure = buildScan(HYDROGEN, RANGE(0.4, 3.0, 5));

  it('draws one line per level, in the order the engine returned them', () => {
    expect(figure.levels.curves).toHaveLength(2);
    expect(figure.levels.curves.map((curve) => curve.key)).toEqual(['0:1:0', '0:1:1']);
  });

  it('gives each line one point per separation, left to right', () => {
    for (const curve of figure.levels.curves) {
      expect(curve.segments).toHaveLength(1);
      expect(curve.segments[0]).toHaveLength(HYDROGEN.length);
      const xs = curve.segments[0].map((sample) => sample.x);
      expect([...xs].sort((a, b) => a - b)).toEqual(xs);
    }
  });

  it('draws the lower level lower, all the way along', () => {
    const [bonding, antibonding] = figure.levels.curves;
    // Larger y is further down the picture.
    for (let i = 0; i < HYDROGEN.length; i++) {
      expect(bonding.segments[0][i].y).toBeGreaterThan(antibonding.segments[0][i].y);
    }
  });

  it('joins the n-th level of a species to the n-th, never across species', () => {
    // Two sigma levels and a pi level between them: the two sigmas are one line
    // each and the pi is its own, whatever order they arrive in.
    const rungs = [level(-1, 2), level(-0.5, 2, 2), level(0.2)];
    const scan = buildScan(
      [withLevels(1, -10, rungs), withLevels(2, -9, rungs)],
      RANGE(1, 2, 2),
    );
    expect(scan.levels.curves.map((curve) => curve.key)).toEqual(['0:1:0', '0:2:0', '0:1:1']);
    expect(scan.levels.curves.map((curve) => curve.count)).toEqual([1, 2, 1]);
  });

  it('names a level by how many orbitals are degenerate with it', () => {
    const rungs = [level(-1, 2), level(-0.5, 2, 2)];
    const scan = buildScan([withLevels(1, -10, rungs)], RANGE(1, 2, 2));
    expect(scan.levels.curves.map((curve) => curve.species?.text)).toEqual(['σ', 'π']);
  });

  it('keeps the lines of the two spins apart, and breaks the second’s', () => {
    const rungs = [level(-1, 1, 1, 0), level(-0.9, 1, 1, 1), level(0.1, 0, 2, 0)];
    const scan = buildScan([withLevels(1.2, -150, rungs)], RANGE(0.9, 2.1, 27));
    expect(scan.levels.curves.map((curve) => curve.key)).toEqual(['0:1:0', '1:1:0', '0:2:0']);
    expect(scan.levels.curves.map((curve) => curve.dashed)).toEqual([false, true, false]);
    // Only the first spin's lines are named: the second's are the same species
    // in the same order, and a second column of names says nothing new.
    expect(scan.levels.curves.map((curve) => curve.species?.text ?? null)).toEqual([
      'σ',
      null,
      'π',
    ]);
    // And the two spins' electrons go to opposite sides of the marker, since a
    // pair of lines a hair apart would otherwise share one mark's worth of room.
    expect(scan.levels.curves.map((curve) => curve.mark?.anchor)).toEqual([
      'end',
      'start',
      'end',
    ]);
    // Neither the line style nor the side can be read off the picture.
    expect(scan.notes.some((note) => note.includes('破線'))).toBe(true);
  });
});

describe('a separation that would not solve', () => {
  // Hydrogen fluoride: the last two points come back with the energy most of a
  // Hartree away, which is what the fixed spin state losing the solution looks
  // like (`docs/dev-notes.md`, "V4-7 の実装メモ").
  const points: ScanPoint[] = [
    withLevels(0.9, -97.9, [level(-1, 2), level(-0.3)]),
    withLevels(1.2, -97.8, [level(-0.9, 2), level(-0.35)]),
    withLevels(1.5, -97.7, [level(-0.8, 2), level(-0.4)]),
    withLevels(1.9, -97.3, [level(5, 2), level(9)], false),
    withLevels(2.2, -97.5, [level(-4, 2), level(8)], false),
  ];
  const figure = buildScan(points, RANGE(0.9, 2.2, 5));

  it('breaks the curve rather than drawing through it', () => {
    expect(figure.energy.segments).toHaveLength(1);
    expect(figure.energy.segments[0]).toHaveLength(3);
    for (const curve of figure.levels.curves) {
      expect(curve.segments.flat()).toHaveLength(3);
    }
  });

  it('leaves it out of what sets the vertical scale', () => {
    // Every point that did solve is inside the plot; a scale that had taken the
    // others in would have squeezed them into a band a few units tall.
    const ys = figure.energy.segments.flat().map((sample) => sample.y);
    expect(Math.min(...ys)).toBe(figure.energy.top);
    expect(Math.max(...ys)).toBe(figure.energy.top + figure.energy.height);
  });

  it('says so under the figure, since a hole is not a curve', () => {
    expect(figure.notes.some((note) => note.includes('線が切れています'))).toBe(true);
  });
});

describe('a level the engine stops calling degenerate', () => {
  // Far apart, a pi pair drifts past the threshold the engine groups by and
  // comes back as two rungs of one orbital each. The pair's line ends there and
  // two new lines begin, because a line is followed along its own symmetry
  // species and those two are not it.
  const together = [level(-1, 2), level(-0.4, 2, 2)];
  const apart = [level(-1, 2), level(-0.4, 2), level(-0.399, 2)];
  const figure = buildScan(
    [withLevels(1.0, -10, together), withLevels(2.0, -9.5, together), withLevels(3.0, -9.4, apart)],
    RANGE(1, 3, 3),
    0,
  );

  it('ends the line rather than joining it to something else', () => {
    const pi = figure.levels.curves.find((curve) => curve.key === '0:2:0');
    expect(pi?.segments.flat()).toHaveLength(2);
    expect(figure.levels.curves.map((curve) => curve.key)).toEqual([
      '0:1:0',
      '0:2:0',
      '0:1:1',
      '0:1:2',
    ]);
  });

  it('says why the lines multiplied, which the picture cannot', () => {
    expect(figure.notes.some((note) => note.includes('別々の線'))).toBe(true);
    // And not the other way round: a figure whose lines all run end to end
    // says nothing about it.
    const whole = buildScan(HYDROGEN, RANGE(0.4, 3.0, 5));
    expect(whole.notes.some((note) => note.includes('別々の線'))).toBe(false);
  });
});

describe('the deepest separation', () => {
  it('is named when the curve has a well', () => {
    const lowest = lowestPoint(HYDROGEN);
    expect(lowest?.distance).toBe(0.7);
    const figure = buildScan(HYDROGEN, RANGE(0.4, 3.0, 5));
    expect(figure.energy.lowest).not.toBeNull();
    expect(figure.notes[0]).toContain('0.70 Å');
  });

  it('is not named for a dip shallower than one valley of the log', () => {
    // Helium's measured minimum is 8.9e-5 Hartree below where the curve
    // flattens out, which is a quarter of the threshold.
    const dip = HELIUM[HELIUM.length - 1].energy - Math.min(...HELIUM.map((p) => p.energy));
    expect(dip).toBeLessThan(MIN_WELL);
    expect(lowestPoint(HELIUM)).toBeNull();
    const figure = buildScan(HELIUM, RANGE(1.5, 4.0, 5));
    expect(figure.energy.lowest).toBeNull();
    expect(figure.notes.some((note) => note.includes('谷と呼べるものがありません'))).toBe(true);
  });

  it('is not named when the curve is still falling where the figure ends', () => {
    // The window opened above the bottom, which is what a range worked out from
    // a stretched pair on screen does: the lowest point drawn is the left edge
    // of the figure rather than anything about the molecule.
    const cropped = HYDROGEN.slice(2);
    expect(lowestPoint(cropped)).toBeNull();
    const figure = buildScan(cropped, RANGE(1.2, 3.0, 3));
    expect(figure.energy.lowest).toBeNull();
    expect(figure.notes[0]).toContain('もっと近いところ');
  });

  it('says so when the curve is still falling where the figure ends on the right', () => {
    // H2+ placed at H2's length, walked to the charged reach (V7-7): its bottom
    // is past the right edge, which is not the same thing as there being none.
    const squashed = HYDROGEN.slice(0, 2);
    expect(lowestPoint(squashed)).toBeNull();
    const figure = buildScan(squashed, RANGE(0.4, 0.74, 2));
    expect(figure.notes[0]).toContain('もっと遠いところ');
    // A tail flat to a hair keeps its own sentence even when its far end happens
    // to come out lowest: helium's, with the last point nudged below the rest.
    const flat = [...HELIUM.slice(1, -1), { ...HELIUM[HELIUM.length - 1], energy: -5.54387 }];
    const tail = buildScan(flat, RANGE(2.0, 4.0, 4));
    expect(tail.notes.some((note) => note.includes('谷と呼べるものがありません'))).toBe(true);
  });

  it('is where the marker starts, and otherwise the shortest separation', () => {
    expect(defaultMarker(HYDROGEN)).toBe(1);
    expect(defaultMarker(HELIUM)).toBe(0);
  });
});

describe('the marker', () => {
  it('stands at one separation, across both plots', () => {
    const figure = buildScan(HYDROGEN, RANGE(0.4, 3.0, 5), 3);
    expect(figure.marker?.distance).toBe(2.0);
    expect(figure.marker?.top).toBe(figure.levels.top);
    expect(figure.marker?.bottom).toBe(figure.energy.top + figure.energy.height);
  });

  it('is clamped to the points that have arrived', () => {
    const figure = buildScan(HYDROGEN.slice(0, 2), RANGE(0.4, 3.0, 27), 20);
    expect(figure.marker?.index).toBe(1);
  });

  it('carries the electrons of every level at the separation it stands at', () => {
    // Oxygen near equilibrium: one spin's pi* holds an electron each and the
    // other spin's is empty, which is what the two sets of lines are for.
    const rungs = [
      level(-1, 1, 1, 0),
      level(-0.081, 1, 2, 0),
      level(-1, 1, 1, 1),
      level(-0.001, 0, 2, 1),
    ];
    const figure = buildScan([withLevels(1.21, -147, rungs)], RANGE(0.9, 2.1, 27), 0);
    const marks = new Map(
      figure.levels.curves.map((curve) => [curve.key, curve.mark?.text ?? '']),
    );
    expect(marks.get('0:2:0')).toBe('●');
    expect(marks.get('1:2:0')).toBe('○');
  });
});

describe('what the picture is allowed to say', () => {
  const figures = [
    buildScan(HYDROGEN, RANGE(0.4, 3.0, 5), 1),
    buildScan(HELIUM, RANGE(1.5, 4.0, 5), 0),
    buildScan(
      [
        withLevels(1.0, -108, [level(-14, 2), level(-1, 2), level(-0.5, 2, 2), level(0.2)]),
        withLevels(1.5, -107, [level(-14, 2), level(-0.9, 2), level(-0.4, 2, 2), level(0.3)]),
      ],
      RANGE(0.8, 2.0, 2),
      0,
    ),
  ];

  it('writes no energy, in any unit or any form', () => {
    for (const figure of figures) {
      for (const text of scanTexts(figure)) {
        expect(text).not.toMatch(/\d+\.\d+/);
        expect(text).not.toMatch(/[-−]/);
        for (const unit of ['Ha', 'eV', 'ハートリー', 'kJ']) expect(text).not.toContain(unit);
      }
    }
  });

  it('writes a measured number only under the distance axis', () => {
    // Which is the one quantity that may be written down here: a separation is
    // the length already on screen in the viewer, not a parameter of the method.
    for (const figure of figures) {
      for (const label of scanAxisLabels(figure)) expect(label).toMatch(/^\d+\.\d+$/);
    }
    const figure = buildScan(HYDROGEN, RANGE(0.4, 3.0, 5));
    const labels = scanAxisLabels(figure).map(Number);
    expect(Math.min(...labels)).toBeGreaterThanOrEqual(0.4);
    expect(Math.max(...labels)).toBeLessThanOrEqual(3.0);
    expect(labels.length).toBeGreaterThanOrEqual(3);
    expect(labels.length).toBeLessThanOrEqual(7);
  });

  it('writes no number in the words around the figures either', () => {
    // The section's own words, which are on screen before any scan has run -
    // the line beside the heading most of all, which is seen while it is shut.
    for (const text of [SCAN_HEADING, SCAN_TEASER, SCAN_INTRO, SCAN_PART_HEADING]) {
      expect(text).not.toMatch(/\d+\.\d+/);
      for (const unit of ['Ha', 'eV', 'ハートリー', 'kJ', 'Å']) expect(text).not.toContain(unit);
    }
  });

  it('keeps the line beside the heading short enough to fit beside it', () => {
    // About fourteen characters are what fit to the right of the heading in
    // the panel, and past that the line is cut short with an ellipsis.
    expect([...SCAN_TEASER].length).toBeLessThanOrEqual(15);
  });

  it('names no DFT parameter either (requirement F4)', () => {
    const said = [
      ...figures.flatMap(scanTexts),
      SCAN_HEADING,
      SCAN_TEASER,
      SCAN_INTRO,
      SCAN_PART_HEADING,
    ].join(' ');
    for (const word of ['基底', 'STO-3G', '6-31G', '汎関数', 'LDA', '電荷', '多重度', 'DFT']) {
      expect(said).not.toContain(word);
    }
  });

  it('folds the innermost levels off the bottom, once for the whole figure', () => {
    // The nitrogen-shaped one above: a level 13 Hartree below the next.
    const figure = figures[2];
    expect(figure.core?.orbitals).toBe(1);
    expect(figure.levels.curves).toHaveLength(3);
  });
});

describe('the pair a scan walks', () => {
  it('asks for no more separations than the worker will take', () => {
    for (const preset of SCAN_PRESETS) {
      expect(preset.points).toBeLessThanOrEqual(MAX_SCAN_POINTS);
      expect(preset.from).toBeGreaterThan(0);
      expect(preset.to).toBeGreaterThan(preset.from);
    }
  });

  it('stops hydrogen fluoride short of where it stops solving', () => {
    // Measured at 1.89 Angstrom (`docs/dev-notes.md`, "V4-7 の実装メモ").
    expect(SCAN_PRESETS.find((preset) => preset.id === 'hf')?.to).toBeLessThan(1.8);
  });

  it('is the one the molecule on screen is, when it is one of them', () => {
    expect(presetFor([8, 8])?.id).toBe('o2');
    // Either way round: the atoms were placed in whatever order they were.
    expect(presetFor([9, 1])?.id).toBe('hf');
    expect(presetFor([1, 9])?.id).toBe('hf');
    expect(presetFor([6, 8])).toBeNull();
    expect(presetFor([8])).toBeNull();
  });

  it('puts the pair on screen in the middle of its own range', () => {
    const range = rangeAround(1.2);
    expect(range.from).toBeLessThan(1.2);
    expect(range.to).toBeGreaterThan(1.2);
    expect(rangeAround(0.1).from).toBeGreaterThanOrEqual(0.3);
  });

  it('walks the two atoms on screen, in their order, over the measured range if any', () => {
    // Hydrogen fluoride placed fluorine first: the measured range, but the
    // elements stay where they were on screen.
    expect(scanPairFor([9, 1], 0.92)).toEqual({
      z: [9, 1],
      charges: [0, 0],
      from: 0.6,
      to: 1.7,
      points: 27,
    });
    // Carbon monoxide has no measured range: one around where it sits.
    expect(scanPairFor([6, 8], 1.13)).toEqual({
      z: [6, 8],
      charges: [0, 0],
      ...rangeAround(1.13),
    });
    // And the measured range does not follow the marker: a stretched O2 is
    // still walked over O2's own range.
    expect(scanPairFor([8, 8], 1.9)).toMatchObject({ from: 0.9, to: 2.1 });
  });

  it('stops short of where a stretched pair stops being the same molecule', () => {
    // Measured through the engine (docs/dev-notes.md, "V4-9 の実測"): O2 at its
    // preset length of 1.208 Angstrom splits its pi pairs from 2.37 on, HF
    // (0.92) stops converging at 1.875, CO (1.13) at 2.13.
    expect(rangeAround(1.208).to).toBeLessThan(2.37);
    expect(rangeAround(0.92).to).toBeLessThan(1.875);
    expect(rangeAround(1.13).to).toBeLessThan(2.13);
    // And the wall does not start so far in that it flattens the well: every
    // preset heavier than H2 starts at 0.65 to 0.75 times its bond.
    expect(rangeAround(1.208).from).toBeGreaterThanOrEqual(0.65 * 1.208);
  });

  it('walks a charged pair over no preset, and not as far out (V7-7)', () => {
    // H2+ at H2's length: H2 has a measured range to 3.0, but that was walked
    // neutral; the charged one stops at 1.4 bonds, the same near end as ever.
    const h2plus = scanPairFor([1, 1], 0.74, [1, 0]);
    expect(h2plus).toEqual({
      z: [1, 1],
      charges: [1, 0],
      ...rangeAround(0.74, CHARGED_REACH),
      charged: true,
    });
    expect(h2plus.to).toBeLessThan(presetFor([1, 1])!.to);
    expect(h2plus.from).toBe(rangeAround(0.74).from);
    // The same pair around the same length, neutral, reaches further.
    expect(h2plus.to).toBeLessThan(rangeAround(0.74).to);
    expect(CHARGED_REACH).toBeLessThan(NEUTRAL_REACH);
    // A charged pair no preset covers: OH-, cut short the same way.
    const hydroxide = scanPairFor([8, 1], 0.98, [-1, 0]);
    expect(hydroxide.to).toBe(rangeAround(0.98, CHARGED_REACH).to);
    expect(hydroxide.to).toBeLessThan(rangeAround(0.98).to);
  });

  it('decides a pair is charged by its total, not by its atoms (V7-0)', () => {
    // H+ beside F- is neutral HF to the engine: HF's own range, no note. The
    // charges still go with the pair, for the free ions at the diagram's ends.
    expect(scanPairFor([1, 9], 0.92, [1, -1])).toEqual({
      z: [1, 9],
      charges: [1, -1],
      from: 0.6,
      to: 1.7,
      points: 27,
    });
    expect(scanPairFor([11, 17], 2.36, [1, -1]).charged).toBeUndefined();
  });
});

describe('the note under a charged pair’s scan', () => {
  it('says why the far end is near, only when the pair is charged', () => {
    const charged = buildScan(HYDROGEN, { ...RANGE(0.4, 3.0, 5), charged: true });
    expect(charged.notes).toContain(SCAN_CHARGED_NOTE);
    expect(buildScan(HYDROGEN, RANGE(0.4, 3.0, 5)).notes).not.toContain(SCAN_CHARGED_NOTE);
    // And with a range from `scanPairFor`, which is how the app asks for it.
    const asked = scanPairFor([1, 1], 0.74, [0, 1]);
    expect(buildScan(HYDROGEN, asked).notes).toContain(SCAN_CHARGED_NOTE);
  });

  it('writes no number and names nothing of the method (requirement F4)', () => {
    expect(SCAN_CHARGED_NOTE).not.toMatch(/\d/);
    for (const word of ['Å', '倍', '基底', 'STO-3G', '6-31G', '汎関数', 'LDA', '電荷', '多重度']) {
      expect(SCAN_CHARGED_NOTE).not.toContain(word);
    }
  });
});

describe('naming the lines bonding or antibonding', () => {
  /** Hydrogen's levels, as two like atoms have them: gerade, then ungerade. */
  const symmetric = HYDROGEN.map((point) =>
    withLevels(point.distance, point.energy, [
      { ...point.levels[0], inversion: 1 },
      { ...point.levels[1], inversion: -1 },
    ]),
  );

  it('stars the antibonding line of two like atoms, by symmetry', () => {
    const figure = buildScan(symmetric, RANGE(0.4, 3.0, 5));
    expect(figure.levels.curves.map((curve) => curve.species?.text)).toEqual(['σ', 'σ*']);
    // And says it aloud too, for a reader who cannot see the lines.
    expect(figure.levels.curves[1].label).toContain('σ*');
    // A pi is the other way round: ungerade bonds, gerade antibonds.
    expect(diatomicName(2, -1, undefined)).toBe('π');
    expect(diatomicName(2, 1, undefined)).toBe('π*');
  });

  it('believes the symmetry over the overlap population', () => {
    // Nitrogen's 3sigma_g at its bond length: gerade, and a population just
    // past the threshold on the negative side (dev-notes, "V4-10 の確認").
    expect(diatomicName(1, 1, -0.063)).toBe('σ');
  });

  it('follows a gerade and an ungerade line through each other', () => {
    // Two species, so they may cross, and a line is one species all along.
    const crossing = [
      withLevels(1.0, -1.0, [level(-1.0, 2, 1, 0, 1), level(-0.9, 2, 1, 0, -1)]),
      withLevels(1.5, -1.1, [level(-1.0, 2, 1, 0, -1), level(-0.9, 2, 1, 0, 1)]),
    ];
    const figure = buildScan(crossing, RANGE(1.0, 1.5, 2));
    const gerade = figure.levels.curves.find((curve) => curve.key === '0:1g:0')!;
    const [near, far] = gerade.segments[0];
    // Lowest at the first separation, the higher of the two at the second.
    expect(near.y).toBeGreaterThan(far.y);
  });

  it('names two unlike atoms’ lines at the bottom of the well', () => {
    // The overlap population changes along a line of two unlike atoms - HF's
    // third sigma is antibonding close in and nonbonding at its bond length -
    // so the name is the molecule's: the deepest separation, 0.7 here.
    const overlaps = [-0.3, 0.02, 0.1, 0.1, 0.05];
    const unlike = HYDROGEN.map((point, at) =>
      withLevels(point.distance, point.energy, [
        { ...point.levels[0], overlap: 0.5 },
        { ...point.levels[1], overlap: overlaps[at] },
      ]),
    );
    const figure = buildScan(unlike, RANGE(0.4, 3.0, 5));
    expect(figure.levels.curves.map((curve) => curve.species?.text)).toEqual(['σ', 'σ']);
    overlaps[1] = -0.9;
    const antibonding = buildScan(
      unlike.map((point, at) =>
        withLevels(point.distance, point.energy, [
          point.levels[0],
          { ...point.levels[1], overlap: overlaps[at] },
        ]),
      ),
      RANGE(0.4, 3.0, 5),
    );
    expect(antibonding.levels.curves[1].species?.text).toBe('σ*');
  });

  it('leaves room on the left for a starred name', () => {
    // Written right-aligned just outside the plot; a "σ*" is about 11 wide.
    const figure = buildScan(symmetric, RANGE(0.4, 3.0, 5));
    for (const curve of figure.levels.curves) {
      expect(curve.species!.x).toBeGreaterThanOrEqual(11);
    }
  });
});

// --- the correlation diagram ----------------------------------------------

/** One spin's rungs, from `[energy, orbitals on it, electrons in one of them]`. */
function rungs(rows: Array<[number, number, number]>): OrbitalLevel[] {
  let first = 0;
  return rows.map(([energy, count, occupation]) => {
    const rung = {
      spin: 'both' as const,
      first,
      count,
      occupation,
      energy,
      parity: null,
      inversion: null,
      partner: null,
    };
    first += count;
    return rung;
  });
}

/** Hydrogen: one orbital on each atom, and a bonding and antibonding rung. */
const H2_LEVELS = rungs([
  [-0.58, 1, 2],
  [0.67, 1, 0],
]);
const H2_ATOMS = [[-0.24], [-0.24]];
const H2_MAKEUP = [
  { shares: [0.5, 0.5], overlap: 0.6 },
  { shares: [0.5, 0.5], overlap: -0.9 },
];

/**
 * O2 in the shape the engine returns it: each spin's own rungs, the pi* filled
 * for the upper spin only, and the free atom 1s, 2s and three 2p.
 */
const O2_ATOMS = [
  [-18.7, -0.87, -0.34, -0.34, -0.34],
  [-18.7, -0.87, -0.34, -0.34, -0.34],
];
function spinRungs(
  spin: 'up' | 'down',
  rows: Array<[number, number, number]>,
): OrbitalLevel[] {
  return rungs(rows).map((rung) => ({ ...rung, spin }));
}
const O2_LEVELS = [
  ...spinRungs('up', [
    [-18.8, 1, 1],
    [-18.8, 1, 1],
    [-1.3, 1, 1],
    [-0.8, 1, 1],
    [-0.55, 1, 1],
    [-0.5, 2, 1],
    [-0.3, 2, 1],
    [0.3, 1, 0],
  ]),
  ...spinRungs('down', [
    [-18.7, 1, 1],
    [-18.7, 1, 1],
    [-1.25, 1, 1],
    [-0.7, 1, 1],
    [-0.48, 1, 1],
    [-0.45, 2, 1],
    [-0.1, 2, 0],
    [0.35, 1, 0],
  ]),
];
/** N2, closed: sigma(2s), sigma*(2s), pi, sigma, pi*, sigma* over a folded core. */
const N2_ATOMS = [
  [-14.0, -0.68, -0.26, -0.26, -0.26],
  [-14.0, -0.68, -0.26, -0.26, -0.26],
];
const N2_LEVELS = rungs([
  [-14.1, 1, 2],
  [-14.1, 1, 2],
  [-1.0, 1, 2],
  [-0.5, 1, 2],
  [-0.43, 2, 2],
  [-0.38, 1, 2],
  [-0.05, 2, 0],
  [0.6, 1, 0],
]);
const N2_MAKEUP = [0, 0, 0.3, -0.2, 0.3, 0.1, -0.3, -0.6].map((overlap) => ({
  shares: [0.5, 0.5],
  overlap,
}));
const O2_OVERLAPS = [0, 0, 0.3, -0.4, 0.2, 0.3, -0.2, -0.6];
const O2_MAKEUP = [...O2_OVERLAPS, ...O2_OVERLAPS].map((overlap) => ({
  shares: [0.5, 0.5],
  overlap,
}));

describe('the correlation diagram', () => {
  const figure = buildCorrelation(H2_ATOMS, ['H', 'H'], H2_LEVELS, H2_MAKEUP);

  it('is a free atom either side of the molecule', () => {
    expect(figure.columns.map((column) => column.key)).toEqual(['left', 'mo0', 'right']);
    expect(figure.columns[0].rungs).toHaveLength(1);
    expect(figure.columns[1].rungs).toHaveLength(2);
    expect(figure.columns[2].rungs).toHaveLength(1);
  });

  it('puts every column on one scale, so the heights can be read across', () => {
    const molecule = figure.columns[1].rungs.map((rung) => rung.y);
    const atom = figure.columns[0].rungs[0].y;
    // The bonding rung is below the atomic level and the antibonding one above.
    expect(Math.max(...molecule)).toBeGreaterThan(atom);
    expect(Math.min(...molecule)).toBeLessThan(atom);
  });

  it('joins both of hydrogen’s rungs to the one orbital each atom brought', () => {
    expect(figure.links).toHaveLength(4);
  });

  it('follows the electrons to the atom that holds them', () => {
    // Hydrogen fluoride, in the shape the engine returns it: fluorine's
    // innermost orbital, then its 2s, then the bond, then two lone pairs, then
    // the antibonding rung. Only the last two rungs have much hydrogen in them.
    const levels = rungs([
      [-24.0, 1, 2],
      [-1.2, 1, 2],
      [-0.5, 1, 2],
      [-0.4, 2, 2],
      [0.6, 1, 0],
    ]);
    const weights = [
      [0.0, 1.0],
      [0.1, 0.9],
      [0.35, 0.65],
      [0.0, 1.0],
      [0.55, 0.45],
    ].map((shares, at) => ({ shares, overlap: [0, 0.01, 0.3, 0, -0.4][at] }));
    const hf = buildCorrelation(
      [[-0.24], [-24.0, -1.1, -0.4, -0.4, -0.4]],
      ['H', 'F'],
      levels,
      weights,
    );
    // The innermost rung, and the atomic level it was made of, are folded away
    // together: one orbital cut, and fluorine's own innermost level gone with it.
    expect(hf.core?.orbitals).toBe(1);
    // Fluorine's 2s, and its 2p as one rung of three (V6-7).
    expect(hf.columns[2].rungs.map((rung) => rung.lines.length)).toEqual([1, 3]);
    // Hydrogen has one orbital to give, so exactly the rungs it is really in
    // reach it: the bond and the antibonding rung, not the lone pairs.
    const toHydrogen = hf.links.filter((link) => link.x1 < hf.width / 3);
    expect(toHydrogen).toHaveLength(2);
  });

  it('writes no energy either', () => {
    for (const text of correlationTexts(figure)) {
      expect(text).not.toMatch(/\d+\.\d+/);
      expect(text).not.toMatch(/[-−]/);
      for (const unit of ['Ha', 'eV', 'ハートリー', 'kJ']) expect(text).not.toContain(unit);
    }
  });

  it('labels the two rungs the electrons stop between', () => {
    const tags = figure.columns[1].rungs.map((rung) => rung.tag);
    expect(tags).toContain('HOMO');
    expect(tags).toContain('LUMO');
    expect(figure.columns[0].rungs.map((rung) => rung.tag)).toEqual(['']);
  });

  it('draws no lines at all until the compositions have arrived', () => {
    expect(buildCorrelation(H2_ATOMS, ['H', 'H'], H2_LEVELS, []).links).toEqual([]);
  });

  it('keeps the column headings clear of the top rung and what stands on it', () => {
    // V4-10: O2's "下向き" was written over the circles of the rung below it.
    // The circles and the tags stand 2.5 above a line and are about 9 tall.
    for (const shown of [figure, buildCorrelation(O2_ATOMS, ['O', 'O'], O2_LEVELS, O2_MAKEUP)]) {
      const top = Math.min(...shown.columns.flatMap((column) => column.rungs.map((r) => r.y)));
      for (const column of shown.columns) expect(column.headingY).toBeLessThan(top - 2.5 - 12);
    }
  });

  it('names the levels as the textbook does', () => {
    // The free atoms' orbitals, and a bonding and an antibonding sigma.
    expect(figure.columns[0].rungs.map((rung) => rung.name)).toEqual(['1s']);
    expect(figure.columns[2].rungs.map((rung) => rung.name)).toEqual(['1s']);
    expect(figure.columns[1].rungs.map((rung) => rung.name).sort()).toEqual(['σ', 'σ*']);
    // No name before the makeup has arrived, rather than a guess at the star.
    const early = buildCorrelation(H2_ATOMS, ['H', 'H'], H2_LEVELS, []);
    expect(early.columns[1].rungs.map((rung) => rung.name)).toEqual(['', '']);
  });

  it('names two like atoms’ rungs by symmetry, where the engine gives one', () => {
    const levels = H2_LEVELS.map((level, at) => ({ ...level, inversion: at === 0 ? 1 : -1 }));
    // A makeup that says the opposite, which the symmetry overrules.
    const contrary = H2_MAKEUP.map((makeup) => ({ ...makeup, overlap: -makeup.overlap }));
    const named = buildCorrelation(H2_ATOMS, ['H', 'H'], levels as OrbitalLevel[], contrary);
    const names = named.columns[1].rungs.map((rung) => rung.name);
    // Highest first: the ungerade sigma*, then the gerade sigma.
    expect(names).toEqual(['σ*', 'σ']);
  });

  it('makes every line of the molecule a pick of the ladder', () => {
    // V6-4: the diagram stands in for the ladder of two atoms, so pressing one
    // of its middle lines has to draw exactly what that line of the ladder did.
    const o2 = buildCorrelation(O2_ATOMS, ['O', 'O'], O2_LEVELS, O2_MAKEUP);
    const [, up, down] = o2.columns;
    const drawn = [up, down].flatMap((column) => column.rungs.flatMap((rung) => rung.picks));
    // The ladder's orbitals above the folded core, each once.
    const expected = O2_LEVELS.filter((level) => level.energy > -10).flatMap((level) =>
      Array.from({ length: level.count }, (_, k) => ({ index: level.first + k, spin: level.spin })),
    );
    const order = (a: OrbitalPick, b: OrbitalPick) =>
      a.spin.localeCompare(b.spin) || a.index - b.index;
    const bare = (drawn as OrbitalPick[]).map(({ index, spin }) => ({ index, spin }));
    expect(bare.sort(order)).toEqual([...expected].sort(order));
    // Both spins keep their own counting, and a pi's two lines are first and
    // first + 1, pointing the two ways across the bond (V6-7).
    for (const column of [up, down]) {
      const spin = column === up ? 'up' : 'down';
      for (const rung of column.rungs) {
        expect(rung.picks).toHaveLength(rung.lines.length);
        expect(rung.lineLabels).toHaveLength(rung.lines.length);
        const level = O2_LEVELS.find((l) => `${l.spin}:${l.first}` === rung.key)!;
        const ways = rung.count === 2 ? ['across', 'toward'] : [undefined];
        expect(rung.picks).toEqual(
          ways.map((along, k) => ({
            index: level.first + k,
            spin,
            ...(along === undefined ? {} : { along }),
          })),
        );
      }
      const pi = column.rungs.filter((rung) => rung.count === 2);
      expect(pi).toHaveLength(2);
      for (const rung of pi) {
        expect(rung.lineLabels[0]).toMatch(/、軸に垂直・画面の中$/);
        expect(rung.lineLabels[1]).toMatch(/、軸に垂直・手前$/);
      }
    }
  });

  it('names both spins of O2, facing each other between the two columns', () => {
    const o2 = buildCorrelation(O2_ATOMS, ['O', 'O'], O2_LEVELS, O2_MAKEUP);
    // 1s is folded away with the molecule's innermost pair; 2p once per height.
    expect(o2.columns[0].rungs.map((rung) => rung.name)).toEqual(['2s', '2p']);
    const [, up, down] = o2.columns;
    const names = (column: typeof up) => column.rungs.map((rung) => rung.name).reverse();
    expect(names(up)).toEqual(['σ', 'σ*', 'σ', 'π', 'π*', 'σ*']);
    expect(names(down)).toEqual(['σ', 'σ*', 'σ', 'π', 'π*', 'σ*']);
    // Names on the inner side of each spin's column, tags on the outer side.
    for (const rung of up.rungs) {
      expect(rung.nameAnchor).toBe('start');
      expect(rung.tagAnchor).toBe('end');
    }
    for (const rung of down.rungs) {
      expect(rung.nameAnchor).toBe('end');
      expect(rung.tagAnchor).toBe('start');
    }
    // Room for a "π*" from each side at one height, about 11 units apiece.
    const widest = (column: typeof up, pick: (rung: (typeof up.rungs)[0]) => number) =>
      column.rungs.filter((rung) => rung.count === 2).map(pick);
    expect(
      Math.min(...widest(down, (rung) => rung.nameX)) -
        Math.max(...widest(up, (rung) => rung.nameX)),
    ).toBeGreaterThanOrEqual(24);
    // And every word inside the figure's width.
    for (const column of o2.columns) {
      for (const rung of column.rungs) {
        expect(rung.nameX).toBeGreaterThanOrEqual(12);
        expect(rung.nameX).toBeLessThanOrEqual(o2.width - 12);
      }
    }
  });

  it('draws a free atom’s p set as one rung of three, each a way it points', () => {
    // V6-7. N2's shape, closed: the innermost pair folded off, and the atoms'
    // 1s with it - so the p set is still orbitals 2, 3 and 4 of the atom.
    const n2 = buildCorrelation(N2_ATOMS, ['N', 'N'], N2_LEVELS, N2_MAKEUP);
    for (const [side, column] of [
      [0, n2.columns[0]],
      [1, n2.columns[2]],
    ] as const) {
      const [s, p] = column.rungs;
      expect(column.rungs).toHaveLength(2);
      expect(s.picks).toEqual([{ index: 1, spin: 'both', atom: side }]);
      expect(p.count).toBe(3);
      expect(p.picks).toEqual([
        { index: 2, spin: 'both', atom: side, along: 'axis' },
        { index: 3, spin: 'both', atom: side, along: 'across' },
        { index: 4, spin: 'both', atom: side, along: 'toward' },
      ]);
      expect(p.lineLabels).toEqual([
        'N の原子の部屋、2p、結合の軸の向き',
        'N の原子の部屋、2p、軸に垂直・画面の中',
        'N の原子の部屋、2p、軸に垂直・手前',
      ]);
      // Three lines abreast, left to right, inside the rung and the atom's own
      // column, and the name over the middle one where there is no room outside.
      expect(p.lines).toHaveLength(3);
      expect([...p.lines].sort((a, b) => a - b)).toEqual(p.lines);
      expect(p.lines[0] - p.lineLength / 2).toBeCloseTo(p.x - p.half);
      expect(p.lines[2] + p.lineLength / 2).toBeCloseTo(p.x + p.half);
      expect(p.nameX).toBe(p.x);
      expect(p.nameAnchor).toBe('middle');
      for (const x of p.lines) {
        expect(x - p.lineLength / 2).toBeGreaterThan(0);
        expect(x + p.lineLength / 2).toBeLessThan(n2.width);
      }
      const middle = n2.columns[1].rungs.map((rung) => rung.x - rung.half);
      if (side === 0) expect(p.x + p.half).toBeLessThan(Math.min(...middle));
    }
  });

  it('names a free atom’s orbital by its column and its rung', () => {
    // V6-8: the words under the diagram for a line of either atom's column.
    const n2 = buildCorrelation(N2_ATOMS, ['N', 'N'], N2_LEVELS, N2_MAKEUP);
    const symbols = diagramEnds([{ z: 7 }, { z: 7 }], () => 'N');
    expect(atomPickWords(n2, { index: 2, spin: 'both', atom: 1, along: 'axis' }, symbols)).toBe(
      'N の原子の 2p（結合の軸の向き）。結合する前の、原子ひとつの部屋です。',
    );
    expect(atomPickWords(n2, { index: 1, spin: 'both', atom: 0 }, symbols)).toBe(
      'N の原子の 2s。結合する前の、原子ひとつの部屋です。',
    );
    // The figure gone, the atom is still named, and nothing is made up for the rest.
    expect(atomPickWords(null, { index: 4, spin: 'both', atom: 0, along: 'toward' }, symbols)).toBe(
      'N の原子の部屋（軸に垂直・手前）。結合する前の、原子ひとつの部屋です。',
    );
  });

  it('puts the ions at the ends as they were placed (V7-7)', () => {
    // H+ beside H: H+ has one level and no electron (`atomLevels`), H its 1s.
    const ends = diagramEnds([{ z: 1, charge: 1 }, { z: 1 }], () => 'H');
    expect(ends).toEqual([
      { heading: 'H⁺', kind: 'bare' },
      { heading: 'H', kind: 'atom' },
    ]);
    // Made-up heights, both above the molecule's lowest rung so neither is folded.
    const figure = buildCorrelation([[-0.5], [-0.24]], ends, H2_LEVELS, H2_MAKEUP);
    expect(figure.columns[0].heading).toBe('H⁺');
    expect(figure.columns[2].heading).toBe('H');
    expect(figure.columns[0].rungs[0].label).toContain('H⁺ のイオンの部屋');
    expect(figure.columns[2].rungs[0].label).toContain('H の原子の部屋');
    const pick = figure.columns[0].rungs[0].picks[0]!;
    expect(atomPickWords(figure, pick, ends)).toBe(
      'H⁺ の 1s。結合する前の、電子の入っていない、イオンひとつの部屋です。',
    );
    // An ion that keeps electrons is an ion's room, not an empty one: O- of OH-.
    const hydroxide = diagramEnds([{ z: 8, charge: -1 }, { z: 1 }], (z) => (z === 8 ? 'O' : 'H'));
    expect(hydroxide[0]).toEqual({ heading: 'O⁻', kind: 'ion' });
    expect(atomPickWords(null, { index: 0, spin: 'both', atom: 0 }, hydroxide)).toBe(
      'O⁻ の部屋。結合する前の、イオンひとつの部屋です。',
    );
    // And the words stay free of numbers other than the orbital's name.
    for (const text of correlationTexts(figure)) {
      expect(text).not.toMatch(/\d+\.\d+/);
      expect(text).not.toMatch(/[-−]/);
    }
  });

  it('joins the molecule to the same atomic levels as before the set became one rung', () => {
    // Each spin's column of O2 counts through the atom's orbitals from the
    // bottom: the sigma and sigma* of 2s use up the 2s, the other four rungs
    // the three 2p. Before V6-7 those four ended on 2p lines of their own; now
    // they end on the one rung, at its edge.
    const o2 = buildCorrelation(O2_ATOMS, ['O', 'O'], O2_LEVELS, O2_MAKEUP);
    expect(o2.links).toHaveLength(24);
    for (const [column, end] of [
      [o2.columns[0], (link: CorrelationLink) => [link.x1, link.y1]],
      [o2.columns[3], (link: CorrelationLink) => [link.x2, link.y2]],
    ] as const) {
      const [s, p] = column.rungs;
      const edge = column === o2.columns[0] ? 1 : -1;
      const landing = o2.links.map((link) => {
        const [x, y] = end(link);
        if (x === s.x + edge * s.half && y === s.y) return '2s';
        if (x === p.x + edge * p.half && y === p.y) return '2p';
        return 'elsewhere';
      });
      expect(landing.filter((at) => at === '2s')).toHaveLength(4);
      expect(landing.filter((at) => at === '2p')).toHaveLength(8);
    }
  });

  it('keeps an orbital apiece, with no way to point, where the sets have no names', () => {
    const odd = buildCorrelation([[-0.5, -0.3, -0.2], [-0.24]], ['X', 'H'], H2_LEVELS, []);
    const left = odd.columns[0].rungs;
    expect(left.map((rung) => rung.count)).toEqual([1, 1, 1]);
    expect(left.map((rung) => rung.picks)).toEqual([
      [{ index: 0, spin: 'both', atom: 0 }],
      [{ index: 1, spin: 'both', atom: 0 }],
      [{ index: 2, spin: 'both', atom: 0 }],
    ]);
  });

  it('writes no number in the new words either', () => {
    for (const shown of [
      buildCorrelation(N2_ATOMS, ['N', 'N'], N2_LEVELS, N2_MAKEUP),
      buildCorrelation(O2_ATOMS, ['O', 'O'], O2_LEVELS, O2_MAKEUP),
    ]) {
      const texts = correlationTexts(shown);
      expect(texts.some((text) => text.includes('軸に垂直・手前'))).toBe(true);
      for (const text of texts) {
        expect(text).not.toMatch(/\d+\.\d+/);
        expect(text).not.toMatch(/[-−]/);
        for (const unit of ['Ha', 'eV', 'ハートリー', 'kJ']) expect(text).not.toContain(unit);
      }
    }
  });
});

describe('the textbook names of a free atom’s orbitals', () => {
  it('reads them off the count, one name per degenerate set', () => {
    expect(atomicOrbitalNames([-0.24])).toEqual(['1s']);
    expect(atomicOrbitalNames([-18.7, -0.87, -0.34, -0.34, -0.34])).toEqual([
      '1s',
      '2s',
      '2p',
      '',
      '',
    ]);
    const argon = [-113, -10.8, -8.4, -8.4, -8.4, -0.9, -0.4, -0.4, -0.4];
    expect(atomicOrbitalNames(argon)).toEqual(['1s', '2s', '2p', '', '', '3s', '3p', '', '']);
  });

  it('names nothing rather than something wrong when the sets are not the table’s', () => {
    expect(atomicOrbitalNames([-18.7, -0.87, -0.34, -0.33, -0.34])).toEqual(['', '', '', '', '']);
    expect(atomicOrbitalNames([-18.7, -0.87, -0.34, -0.34])).toEqual(['', '', '', '']);
  });
});

describe('how much of an orbital sits on an atom', () => {
  it('splits the overlap populations between the two nuclei, and adds to one', () => {
    // A bond shared evenly: the same on the diagonal, the same off it.
    const shared = [0.7, 0.3, 0.3, 0.7];
    expect(atomFraction(shared, 2, 0)).toBeCloseTo(0.5, 12);
    expect(atomFraction(shared, 2, 1)).toBeCloseTo(0.5, 12);
  });

  it('follows a lopsided orbital to the atom it is on', () => {
    // Almost everything on the second nucleus, which is what a lone pair is.
    const lonePair = [0.02, 0.0, 0.0, 1.98];
    expect(atomFraction(lonePair, 2, 0)).toBeLessThan(0.05);
    expect(atomFraction(lonePair, 2, 1)).toBeGreaterThan(0.95);
  });

  it('answers zero for an orbital with no population anywhere', () => {
    expect(atomFraction([0, 0, 0, 0], 2, 0)).toBe(0);
  });
});

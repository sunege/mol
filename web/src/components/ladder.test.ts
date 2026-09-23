import { describe, expect, it } from 'vitest';
import { MIN_STEP, buildLadder, foldCore, layout, step, type Ladder } from './ladder';
import type { OrbitalLevel, SpinChannel } from '../worker/protocol';

/**
 * A spin's rungs, from `[energy, orbitals on it, electrons in one of them]`.
 *
 * Lowest first and numbered from the bottom, which is how the engine returns
 * them (`worker/protocol.ts`).
 */
function rungs(spin: SpinChannel, rows: Array<[number, number, number]>): OrbitalLevel[] {
  let first = 0;
  return rows.map(([energy, count, occupation]) => {
    const level = { spin, first, count, occupation, energy, parity: null, partner: null };
    first += count;
    return level;
  });
}

/**
 * Water: the oxygen's innermost pair, then everything else within 1.3 Hartree.
 *
 * Written here rather than measured, from the two ends that were
 * (`docs/dev-notes.md`, "v4-0 の実測"): the core at -18.27 and the valence
 * running from -0.83 to +0.43. What the ladder does with it turns on the gap
 * between those, not on the rungs in between.
 */
const WATER = rungs('both', [
  [-18.27, 1, 2],
  [-0.83, 1, 2],
  [-0.42, 1, 2],
  [-0.27, 1, 2],
  [-0.21, 1, 2],
  [0.31, 1, 0],
  [0.43, 1, 0],
]);

/**
 * Benzene: 36 orbitals on 24 rungs, six of them the carbons' innermost.
 *
 * The same shape as the measured one - six core orbitals near -9.59, valence
 * from -0.72 to +0.76, and a degenerate pair at each end of the electrons -
 * with the rungs in between spaced by hand.
 */
const BENZENE = rungs('both', [
  [-9.593, 1, 2],
  [-9.5925, 2, 2],
  [-9.592, 2, 2],
  [-9.5915, 1, 2],
  [-0.72, 1, 2],
  [-0.65, 1, 2],
  [-0.6, 2, 2],
  [-0.55, 1, 2],
  [-0.5, 2, 2],
  [-0.46, 1, 2],
  [-0.41, 1, 2],
  [-0.36, 2, 2],
  [-0.3, 2, 2],
  [-0.24, 2, 2],
  [-0.02, 2, 0],
  [0.12, 1, 0],
  [0.2, 2, 0],
  [0.28, 1, 0],
  [0.35, 1, 0],
  [0.42, 2, 0],
  [0.5, 1, 0],
  [0.58, 2, 0],
  [0.66, 1, 0],
  [0.76, 2, 0],
]);

/**
 * O2: eight rungs of each spin, nine electrons in one and seven in the other.
 *
 * The six rungs that carry the picture are the measured ones
 * (`docs/dev-notes.md`, "V4-3 の実装メモ"): the pi* at -0.0811 with an electron
 * in each of its two orbitals, the same pair empty at -0.0011 in the other
 * spin, and the pairing that crosses - the fifth rung of one spin is the sixth
 * of the other. The core and the rungs below the frontier are written here,
 * two of them 0.02 Hartree apart across the spins, which is what the single
 * cut has to cope with.
 */
const OXYGEN: OrbitalLevel[] = [
  ...withPartners(
    rungs('up', [
      [-18.4644, 1, 1],
      [-18.462, 1, 1],
      [-1.1134, 1, 1],
      [-0.6801, 1, 1],
      [-0.3507, 2, 1],
      [-0.339, 1, 1],
      [-0.0811, 2, 1],
      [0.3341, 1, 0],
    ]),
    { 4: 13, 5: 12, 6: 14 },
  ),
  ...withPartners(
    rungs('down', [
      [-18.444, 1, 1],
      [-18.442, 1, 1],
      [-1.05, 1, 1],
      [-0.62, 1, 1],
      [-0.2971, 1, 1],
      [-0.2808, 2, 1],
      [-0.0011, 2, 0],
      [0.37, 1, 0],
    ]),
    { 4: 5, 5: 4, 6: 6 },
  ),
];

/** Rungs of the other spin, as indices into the array they all arrive in. */
function withPartners(
  levels: OrbitalLevel[],
  partners: Record<number, number>,
): OrbitalLevel[] {
  return levels.map((level, index) =>
    index in partners ? { ...level, partner: partners[index] } : level,
  );
}

/** Two rungs and nothing between them: a bonding orbital and an empty one. */
const HYDROGEN = rungs('both', [
  [-0.58, 1, 2],
  [0.67, 1, 0],
]);

/** Every word the picture puts on screen, and nothing that it does not. */
function drawn(ladder: Ladder): string[] {
  return [
    ...ladder.columns.flatMap((column) => [
      column.heading ?? '',
      ...column.rungs.flatMap((rung) => [
        rung.tag,
        rung.mark,
        ...rung.orbitals.map((orbital) => orbital.label),
      ]),
    ]),
    ladder.core?.text ?? '',
  ];
}

/** The rungs of one column, by the spin whose ladder they are. */
const columnOf = (ladder: Ladder, spin: SpinChannel) =>
  ladder.columns.find((column) => column.spin === spin)!;

describe('folding the innermost electrons off the bottom', () => {
  it('cuts water below its one core orbital', () => {
    const { core, shown } = foldCore(WATER);
    expect(core).toBe(1);
    expect(shown).toHaveLength(6);
    expect(Math.min(...shown.map((level) => level.energy))).toBe(-0.83);
  });

  it('counts the orbitals it cut, not the rungs they sat on', () => {
    // Benzene's six carbons give six core orbitals, and they arrive as four
    // rungs because two pairs of them are degenerate.
    const { core, shown } = foldCore(BENZENE);
    expect(core).toBe(6);
    expect(shown).toHaveLength(20);
    expect(shown.every((level) => level.energy > -1)).toBe(true);
  });

  it('leaves a molecule whose orbitals are all of a piece alone', () => {
    // H2's two rungs are 1.25 Hartree apart with nothing above them to compare
    // that against, and its bonding orbital is not core.
    expect(foldCore(HYDROGEN)).toEqual({ core: 0, shown: HYDROGEN });
  });

  it('folds nothing that has no electrons in it', () => {
    const holed = rungs('both', [
      [-9.5, 1, 0],
      [-0.5, 1, 2],
      [-0.3, 1, 2],
      [0.2, 1, 0],
    ]);
    expect(foldCore(holed).core).toBe(0);
  });

  it('cuts an open-shell molecule once, at one height for both spins', () => {
    const { core, shown } = foldCore(OXYGEN);
    // Two core orbitals in each spin, and the cut is above all four of them:
    // the two spins' innermost rungs are 0.02 Hartree apart, and columns cut
    // at different heights cannot be read against each other.
    expect(core).toBe(4);
    expect(shown).toHaveLength(12);
    for (const spin of ['up', 'down'] as const) {
      const kept = shown.filter((level) => level.spin === spin);
      expect(kept).toHaveLength(6);
      expect(Math.min(...kept.map((level) => level.energy))).toBeLessThan(-1);
      expect(Math.min(...kept.map((level) => level.energy))).toBeGreaterThan(-2);
    }
  });
});

describe('where the rungs are drawn', () => {
  const shown = foldCore(BENZENE).shown;
  const ys = layout(shown, 340);

  it('keeps the order the energies came in', () => {
    for (let i = 1; i < ys.length; i++) expect(ys[i]).toBeLessThan(ys[i - 1]);
  });

  it('leaves room between every pair of them', () => {
    // To within the arithmetic: a push leaves them exactly a step apart.
    for (let i = 1; i < ys.length; i++) expect(ys[i - 1] - ys[i]).toBeGreaterThan(MIN_STEP - 0.01);
  });

  it('stays inside the band it was given', () => {
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...ys)).toBeLessThanOrEqual(340);
  });

  it('draws rungs of the same height at the same height', () => {
    // One spin's degenerate orbitals are one rung already; two rungs that can
    // land level with each other are one from each spin.
    const level = layout(
      [...rungs('up', [[-0.5, 1, 1], [-0.2, 1, 1]]), ...rungs('down', [[-0.5, 1, 1], [-0.1, 1, 0]])],
      200,
    );
    expect(level[0]).toBe(level[2]);
    expect(level[1]).not.toBe(level[3]);
  });

  it('keeps a wide gap wide while it pushes a narrow one open', () => {
    const ladder = buildLadder(BENZENE);
    const [column] = ladder.columns;
    const homo = column.rungs.find((rung) => rung.frontier === 'homo')!;
    const lumo = column.rungs.find((rung) => rung.frontier === 'lumo')!;
    // The gap the electrons stop at is the one thing this picture is read for,
    // and it is several times the closest two rungs come anywhere.
    expect(homo.y - lumo.y).toBeGreaterThan(3 * MIN_STEP);
  });
});

describe('the picture of a closed-shell molecule', () => {
  const ladder = buildLadder(WATER);

  it('is one column, with the folded core said in a line under it', () => {
    expect(ladder.columns).toHaveLength(1);
    expect(ladder.columns[0].heading).toBeNull();
    expect(ladder.core?.orbitals).toBe(1);
    expect(ladder.core?.text).toContain('1 本');
    expect(ladder.links).toEqual([]);
  });

  it('puts the cut below every rung that is drawn', () => {
    const lowest = Math.max(...ladder.columns[0].rungs.map((rung) => rung.y));
    expect(ladder.core!.y).toBeGreaterThan(lowest);
    expect(ladder.height).toBeGreaterThan(ladder.core!.textY);
  });

  it('labels the two rungs the electrons stop between, and no others', () => {
    const tagged = ladder.columns[0].rungs.filter((rung) => rung.tag !== '');
    expect(tagged.map((rung) => rung.tag)).toEqual(['LUMO', 'HOMO']);
  });

  it('draws one line per orbital, with its electrons above it', () => {
    const [column] = ladder.columns;
    expect(column.rungs.every((rung) => rung.orbitals.length === rung.level.count)).toBe(true);
    expect(column.rungs.find((rung) => rung.frontier === 'homo')!.mark).toBe('●●');
    expect(column.rungs.find((rung) => rung.frontier === 'lumo')!.mark).toBe('○');
  });
});

describe('the picture of a molecule with unpaired electrons', () => {
  const ladder = buildLadder(OXYGEN);
  const up = columnOf(ladder, 'up');
  const down = columnOf(ladder, 'down');

  it('is two columns, side by side and headed', () => {
    expect(ladder.columns).toHaveLength(2);
    expect(up.heading).toBe('上向きのスピン');
    expect(down.heading).toBe('下向きのスピン');
    expect(up.x).toBeLessThan(down.x);
  });

  it('fills the two lines of one spin’s pi* and leaves the other’s empty', () => {
    // Which is the whole of what O2 is here to show: one electron in each of
    // two orbitals at the same height, and the same two empty in the other
    // column because they are 0.08 Hartree higher there.
    const star = up.rungs.find((rung) => rung.frontier === 'homo')!;
    expect(star.level.count).toBe(2);
    expect(star.orbitals).toHaveLength(2);
    expect(star.mark).toBe('●');
    const empty = down.rungs.find((rung) => rung.level.first === star.level.first)!;
    expect(empty.frontier).toBe('lumo');
    expect(empty.mark).toBe('○');
    expect(empty.y).toBeLessThan(star.y);
  });

  it('cuts both columns at one height, below everything drawn', () => {
    expect(ladder.core?.orbitals).toBe(4);
    for (const column of ladder.columns) {
      expect(Math.max(...column.rungs.map((rung) => rung.y))).toBeLessThan(ladder.core!.y);
    }
  });

  it('joins the pairs across the gap, and lets the lines cross', () => {
    // The three rungs that have a partner, drawn once each from left to right.
    expect(ladder.links).toHaveLength(3);
    for (const link of ladder.links) expect(link.x1).toBeLessThan(link.x2);
    // Two of them cross: the fifth rung of one spin is the sixth of the other
    // (`docs/dev-notes.md`, "V4-3 の実装メモ"), and the line is drawn to show
    // exactly that.
    const crossing = ladder.links.some((a) =>
      ladder.links.some((b) => (a.y1 - b.y1) * (a.y2 - b.y2) < 0),
    );
    expect(crossing).toBe(true);
  });

  it('says which spin a line belongs to, since the heading is only a picture', () => {
    const star = up.rungs.find((rung) => rung.frontier === 'homo')!;
    expect(star.orbitals[0].label).toContain('上向きのスピン');
    expect(star.orbitals[0].label).toContain('電子が 1 つ');
    expect(star.orbitals[1].label).toContain('2 つめ');
  });
});

describe('walking the ladder with the arrow keys', () => {
  const ladder = buildLadder(OXYGEN);

  it('steps between the lines of the column the orbital is in', () => {
    const up = columnOf(ladder, 'up');
    const star = up.rungs.find((rung) => rung.frontier === 'homo')!;
    // Down from the first of the two degenerate orbitals is the second.
    expect(step(ladder, star.orbitals[0].pick, 1)).toEqual(star.orbitals[1].pick);
    // And up from it is the rung above, which is the top of the same column.
    const above = step(ladder, star.orbitals[0].pick, -1)!;
    expect(above.spin).toBe('up');
    expect(above.index).toBe(up.rungs[0].level.first);
  });

  it('stops at the ends, and knows nothing of an orbital that is not drawn', () => {
    const up = columnOf(ladder, 'up');
    const top = up.rungs[0].orbitals[0].pick;
    expect(step(ladder, top, -1)).toBeNull();
    // The core was folded away: its orbitals are no longer anywhere to step to.
    expect(step(ladder, { index: 0, spin: 'up' }, 1)).toBeNull();
  });
});

describe('what the picture is allowed to say', () => {
  const said = [WATER, BENZENE, OXYGEN, HYDROGEN].flatMap((levels) => drawn(buildLadder(levels)));

  it('writes no orbital energy, in any unit or any form', () => {
    // The heights are the whole of what the energies are for: LDA's values are
    // out by a factor of several, so a number read off this picture would be
    // wrong while the picture itself is right (`docs/plan-v4.md`, decision 3).
    for (const text of said) {
      expect(text).not.toMatch(/\d+\.\d+/);
      expect(text).not.toMatch(/[-−]/);
      for (const unit of ['Ha', 'eV', 'ハートリー', 'kJ']) expect(text).not.toContain(unit);
    }
  });

  it('names no DFT parameter either (requirement F4)', () => {
    const all = said.join(' ');
    for (const word of ['基底', 'STO-3G', '6-31G', '汎関数', 'LDA', '電荷', '多重度', 'DFT']) {
      expect(all).not.toContain(word);
    }
  });
});

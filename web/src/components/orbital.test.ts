import { describe, expect, it } from 'vitest';
import {
  LADDER_LABEL,
  ORBITAL_HEADING,
  ORBITAL_INTRO,
  ORBITAL_LOADING,
  ORBITAL_NEEDS_CALCULATION,
  ORBITAL_OTHER_LEVEL,
  ORBITAL_SCALE,
  ORBITAL_SURFACE_HINT,
  ORBITAL_TEASER,
  coreText,
  countNodes,
  degenerateText,
  describeBonds,
  describeLobes,
  describeNodes,
  frontierLabel,
  ladderRungLabel,
  occupationMark,
  occupationText,
  orbitalColumns,
  rungOf,
  spinHeading,
  verdictBySymmetry,
  type Bond,
} from './orbital';
import type { OrbitalLevel, SpinChannel } from '../worker/protocol';

/** A rung, with the fields this module does not read left at their quietest. */
function rung(
  spin: SpinChannel,
  first: number,
  count: number,
  occupation: number,
  energy = 0,
): OrbitalLevel {
  return {
    spin,
    first,
    count,
    occupation,
    energy,
    parity: null,
    inversion: null,
    partner: null,
  };
}

/**
 * Water: seven rungs, all of them one orbital, five of them full.
 * Measured (`docs/dev-notes.md`, "V4-3 の実装メモ").
 */
const WATER: OrbitalLevel[] = [
  rung('both', 0, 1, 2, -18.6),
  rung('both', 1, 1, 2, -0.9),
  rung('both', 2, 1, 2, -0.5),
  rung('both', 3, 1, 2, -0.3),
  rung('both', 4, 1, 2, -0.2),
  rung('both', 5, 1, 0, 0.3),
  rung('both', 6, 1, 0, 0.4),
];

/**
 * O2: eight rungs of each spin, nine electrons in one and seven in the other.
 *
 * The rungs that matter are the measured ones: the pi* is rung 6 of the upward
 * spin (two orbitals, one electron each) and rung 14 of the downward one (the
 * same two, empty), 0.08 Hartree apart. The two spins' rungs also come out in
 * different orders, which is why 4 pairs with 13 and 5 with 12.
 */
const OXYGEN: OrbitalLevel[] = [
  rung('up', 0, 1, 1, -20.7),
  rung('up', 1, 1, 1, -20.7),
  rung('up', 2, 1, 1, -1.4),
  rung('up', 3, 1, 1, -0.9),
  { ...rung('up', 4, 2, 1, -0.3507), partner: 13 },
  { ...rung('up', 6, 1, 1, -0.339), partner: 12 },
  { ...rung('up', 7, 2, 1, -0.0811), partner: 14 },
  rung('up', 9, 1, 0, 0.5),
  rung('down', 0, 1, 1, -20.6),
  rung('down', 1, 1, 1, -20.6),
  rung('down', 2, 1, 1, -1.3),
  rung('down', 3, 1, 1, -0.8),
  { ...rung('down', 4, 1, 1, -0.2971), partner: 5 },
  { ...rung('down', 5, 2, 1, -0.2808), partner: 4 },
  { ...rung('down', 7, 2, 0, -0.0011), partner: 6 },
  rung('down', 9, 1, 0, 0.6),
];

/** Electrons a column accounts for: the rung counts, not the rungs. */
const electrons = (rows: { level: OrbitalLevel }[]) =>
  rows.reduce((total, { level }) => total + level.count * level.occupation, 0);

/** Everything this module puts on screen, as one string. */
const said = [
  ORBITAL_HEADING,
  ORBITAL_TEASER,
  ORBITAL_INTRO,
  ORBITAL_NEEDS_CALCULATION,
  ORBITAL_LOADING,
  ORBITAL_OTHER_LEVEL,
  ORBITAL_SURFACE_HINT,
  ORBITAL_SCALE.low,
  ORBITAL_SCALE.high,
  frontierLabel('homo'),
  frontierLabel('lumo'),
  ...[0, 1, 2].flatMap((occupation) => [occupationMark(occupation), occupationText(occupation)]),
  ...[1, 2, 3].map(degenerateText),
  ...([...OXYGEN, ...WATER].map((level) => spinHeading(level.spin) ?? '')),
  // The ladder (V4-6): what it is as a whole, what it cut off the bottom, and
  // every form of the line that is read out for one of its lines.
  LADDER_LABEL,
  ...[1, 2, 6].map(coreText),
  ...[0, 1].flatMap((offset) =>
    [null, 'homo' as const, 'lumo' as const].flatMap((frontier) =>
      [1, 2].flatMap((count) =>
        [null, spinHeading('up'), spinHeading('down')].map((heading) =>
          ladderRungLabel(
            { level: rung('up', 0, count, count - offset), frontier },
            offset,
            heading,
          ),
        ),
      ),
    ),
  ),
  // The words about the orbital picked, which are the rest of what the section
  // puts on screen: what it does to the bonds, its nodes, and its blobs.
  describeBonds(
    populations(6, [
      [0, 1, 0.384],
      [1, 2, -0.312],
      [2, 3, 0.02],
      [3, 4, -0.09],
      [4, 5, 0.09],
    ]),
    [
      [0, 1],
      [1, 2],
      [2, 3],
      [3, 4],
      [4, 5],
    ],
    ['C', 'C', 'O', 'H', 'N', 'H'],
  ),
  describeBonds(
    populations(3, [
      [0, 1, -0.934],
      [0, 2, -0.934],
    ]),
    [
      [0, 1],
      [0, 2],
    ],
    ['O', 'H', 'H'],
  ),
  ...[0, 1, 2].map(describeNodes),
  ...[0, 1, 4].map((count) => describeLobes({ positive: count, negative: 0 })),
].join(' ');

describe('the ladder of a closed-shell molecule', () => {
  const [column, ...rest] = orbitalColumns(WATER);

  it('is one column, with no spin to tell apart', () => {
    expect(rest).toEqual([]);
    expect(column.spin).toBe('both');
    expect(column.heading).toBeNull();
    expect(column.rows).toHaveLength(7);
  });

  it('reads from the top, the way a ladder is drawn', () => {
    // They arrive lowest first, and the highest belongs at the top of the list.
    expect(column.rows.map((row) => row.level.first)).toEqual([6, 5, 4, 3, 2, 1, 0]);
  });

  it('puts the two labels either side of the electrons that are there', () => {
    const homo = column.rows.find((row) => row.frontier === 'homo');
    const lumo = column.rows.find((row) => row.frontier === 'lumo');
    expect(homo?.level.first).toBe(4);
    expect(lumo?.level.first).toBe(5);
    // And nothing else is labelled: a rung is named by what it is, not by how
    // far down the list it sits.
    expect(column.rows.filter((row) => row.frontier !== null)).toHaveLength(2);
  });
});

describe('the ladder of a molecule with unpaired electrons', () => {
  const columns = orbitalColumns(OXYGEN);
  const [up, down] = columns;

  it('keeps the two spins in columns of their own, with headings', () => {
    expect(columns).toHaveLength(2);
    expect(up.spin).toBe('up');
    expect(down.spin).toBe('down');
    expect(up.heading).toBe('上向きのスピン');
    expect(down.heading).toBe('下向きのスピン');
  });

  it('does not fold them together, so the electrons can be counted', () => {
    // Nine one way and seven the other is the whole of what the section has to
    // show for O2: the same two orbitals are full in one column and empty in
    // the other.
    expect(electrons(up.rows)).toBe(9);
    expect(electrons(down.rows)).toBe(7);
    expect(up.rows).toHaveLength(8);
    expect(down.rows).toHaveLength(8);
  });

  it('labels the frontier of each spin separately', () => {
    const upHomo = up.rows.find((row) => row.frontier === 'homo')?.level;
    const downLumo = down.rows.find((row) => row.frontier === 'lumo')?.level;
    // The pi*: two orbitals with one electron each in the upward spin, and the
    // same two empty in the downward one.
    expect(upHomo).toMatchObject({ first: 7, count: 2, occupation: 1 });
    expect(downLumo).toMatchObject({ first: 7, count: 2, occupation: 0 });
    // Which is the picture only because the two are shown apart: folded
    // together they would be one half-filled rung and nothing to see.
    expect(up.rows.find((row) => row.frontier === 'lumo')?.level.first).toBe(9);
    expect(down.rows.find((row) => row.frontier === 'homo')?.level.first).toBe(5);
  });
});

describe('which rung is the frontier', () => {
  it('follows the electrons rather than the order of the list', () => {
    // A rung left empty below a full one is not what a molecule of this app
    // settles into, but the labels are read off the occupations either way.
    const holed = [
      rung('both', 0, 1, 2),
      rung('both', 1, 1, 0),
      rung('both', 2, 1, 2),
      rung('both', 3, 1, 0),
    ];
    const [column] = orbitalColumns(holed);
    expect(column.rows.find((row) => row.frontier === 'homo')?.level.first).toBe(2);
    expect(column.rows.find((row) => row.frontier === 'lumo')?.level.first).toBe(1);
  });

  it('labels nothing where there is nothing to label', () => {
    // Every orbital full: a basis with no room left has no lowest empty one.
    const [full] = orbitalColumns([rung('both', 0, 1, 2), rung('both', 1, 1, 2)]);
    expect(full.rows.map((row) => row.frontier)).toEqual(['homo', null]);
    const [empty] = orbitalColumns([rung('both', 0, 1, 0)]);
    expect(empty.rows.map((row) => row.frontier)).toEqual(['lumo']);
  });
});

describe('what a row says', () => {
  it('shows the electrons on the rung as circles', () => {
    expect(occupationMark(2)).toBe('●●');
    expect(occupationMark(1)).toBe('●');
    expect(occupationMark(0)).toBe('○');
    expect(occupationText(0)).toContain('空');
  });

  it('says how many orbitals share a rung, and nothing when it is one', () => {
    expect(degenerateText(1)).toBe('');
    expect(degenerateText(2)).toBe('同じ高さの軌道が 2 つ');
    expect(degenerateText(3)).toBe('同じ高さの軌道が 3 つ');
  });

  it('reads a line of the ladder aloud, since the line itself has no text', () => {
    const homo = { level: rung('up', 4, 2, 1), frontier: 'homo' as const };
    expect(ladderRungLabel(homo, 1, spinHeading('up'))).toBe(
      '上向きのスピン、電子が 1 つ、HOMO、同じ高さの軌道が 2 つの 2 つめ',
    );
    // One column, one orbital on the rung, and neither end of the electrons:
    // what is left is what the picture shows, which is the electrons in it.
    expect(ladderRungLabel({ level: rung('both', 2, 1, 2), frontier: null }, 0, null)).toBe(
      '電子が 2 つ',
    );
  });

  it('counts what the ladder folded off the bottom, and says what it was', () => {
    expect(coreText(1)).toContain('1 本');
    expect(coreText(6)).toContain('6 本');
    expect(coreText(6)).toBe('ここより下に 6 本（閉殻の内殻電子）');
    expect(LADDER_LABEL).toBe('分子軌道の準位');
  });

  it('numbers no rung, from either end', () => {
    // "The fourth from the top" is a fact about the list, and counting from the
    // bottom would be one about the basis.
    for (const word of ['番目', '本目', '番']) expect(said).not.toContain(word);
  });
});

/**
 * A square of overlap populations, from the pairs that are not zero.
 *
 * Symmetric, the way the engine's own is: a population belongs to a pair of
 * nuclei rather than pointing from one to the other.
 */
function populations(atoms: number, pairs: Array<[number, number, number]>): Float64Array {
  const matrix = new Float64Array(atoms * atoms);
  for (const [a, b, value] of pairs) {
    matrix[a * atoms + b] = value;
    matrix[b * atoms + a] = value;
  }
  return matrix;
}

/** Ethylene, as the viewer joins it up: the double bond, and two H on each C. */
const ETHYLENE_BONDS: Bond[] = [
  [0, 1],
  [0, 2],
  [0, 3],
  [1, 4],
  [1, 5],
];
const ETHYLENE_SYMBOLS = ['C', 'C', 'H', 'H', 'H', 'H'];

/** Benzene: the ring, and then the hydrogen hanging off each carbon of it. */
const BENZENE_BONDS: Bond[] = [
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 4],
  [4, 5],
  [5, 0],
  [0, 6],
  [1, 7],
  [2, 8],
  [3, 9],
  [4, 10],
  [5, 11],
];

/**
 * The probes of an ethylene pi orbital whose two carbons carry these signs.
 *
 * Built from the shape rather than copied out of a calculation: what the count
 * reads is which sign each nucleus carries, and a hydrogen carries a fraction
 * of the carbon it hangs off - it is standing in the tail of that carbon's
 * lobe and has nothing of its own up there. The magnitudes say only that the
 * hydrogens are the small ones.
 */
function ethyleneProbes(left: number, right: number): Float64Array {
  return new Float64Array([left, right, left, left, right, right].map((sign, i) =>
    i < 2 ? sign * 0.25 : sign * 0.03,
  ));
}

/** The same for benzene, from the signs around the ring. */
function benzeneProbes(ring: readonly number[]): Float64Array {
  return new Float64Array([...ring.map((sign) => sign * 0.2), ...ring.map((sign) => sign * 0.02)]);
}

describe('counting the nodes of a pi system', () => {
  it('counts none where the lobes are all one sign, and one where they are not', () => {
    // Ethylene's pi has one lobe over both carbons, its pi* one over each; the
    // hydrogens follow the carbon they hang off either way.
    expect(countNodes(ethyleneProbes(1, 1), ETHYLENE_BONDS)).toBe(0);
    expect(countNodes(ethyleneProbes(1, -1), ETHYLENE_BONDS)).toBe(1);
    // The overall sign is a convention, so turning the whole orbital over
    // cannot change the answer.
    expect(countNodes(ethyleneProbes(-1, -1), ETHYLENE_BONDS)).toBe(0);
    expect(countNodes(ethyleneProbes(-1, 1), ETHYLENE_BONDS)).toBe(1);
  });

  it('gives both halves of benzene’s highest occupied pair one node', () => {
    // The two are an arbitrary rotation of one rung and do not look alike: one
    // has a lobe on every carbon, the other has two carbons sitting on the node
    // and reading nothing at all. Walking the ring crosses every node twice,
    // and the nucleus with no sign is stepped over rather than counted - which
    // is what makes these two agree.
    expect(countNodes(benzeneProbes([1, 1, -1, -1, -1, 1]), BENZENE_BONDS)).toBe(1);
    expect(countNodes(benzeneProbes([0, 1, 1, 0, -1, -1]), BENZENE_BONDS)).toBe(1);
    // And the pair above them, which turns over at every bond: three nodes
    // would be six crossings, but this ring only has six bonds to cross.
    expect(countNodes(benzeneProbes([1, -1, 1, -1, 1, -1]), BENZENE_BONDS)).toBe(3);
  });

  it('says nothing where there is nothing to count', () => {
    // A molecule with no plane has no probes at all, and an orbital with no
    // amplitude anywhere above the nuclei has no row of signs.
    expect(countNodes(null, ETHYLENE_BONDS)).toBeNull();
    expect(countNodes(new Float64Array(6), ETHYLENE_BONDS)).toBeNull();
  });
});

describe('what an orbital does to the bonds', () => {
  const water = ['O', 'H', 'H'];
  const waterBonds: Bond[] = [
    [0, 1],
    [0, 2],
  ];

  it('calls an orbital that is none of the bonds nonbonding', () => {
    // Water's highest occupied orbital is the lone pair: none of it is between
    // the nuclei, and its population across both O-H bonds is zero.
    const lone = populations(3, [
      [0, 1, -0.00001],
      [0, 2, -0.00001],
    ]);
    expect(describeBonds(lone, waterBonds, water)).toBe('O–H 非結合性。');
  });

  it('names the bonds it is antibonding in', () => {
    const antibonding = populations(3, [
      [0, 1, -0.934],
      [0, 2, -0.934],
    ]);
    expect(describeBonds(antibonding, waterBonds, water)).toBe('O–H 反結合性。');
  });

  it('names what it is bonding in first, and what it is nonbonding in last', () => {
    // Ethylene's pi: it is the double bond and has nothing to do with the C-H
    // bonds, which is the sentence rather than a footnote to it.
    const pi = populations(6, [
      [0, 1, 0.384],
      [0, 2, 0],
      [0, 3, 0],
      [1, 4, 0],
      [1, 5, 0],
    ]);
    const said = describeBonds(pi, ETHYLENE_BONDS, ETHYLENE_SYMBOLS);
    expect(said).toBe('C–C 結合性、C–H 非結合性。');
    // Hydrogen goes last in a label, and the pairs are spoken of by kind: one
    // clause for the four C-H bonds rather than four.
    expect(said).not.toContain('H–C');
    expect(said.match(/C–H/g)).toHaveLength(1);
  });

  it('does not pick a side where one kind of bond is doing both', () => {
    // A ring's pi orbital strengthens some of its bonds and weakens others.
    const ring = populations(6, [
      [0, 1, 0.12],
      [1, 2, -0.06],
      [2, 3, 0.12],
      [3, 4, 0.12],
      [4, 5, -0.06],
      [5, 0, 0.12],
    ]);
    const bonds: Bond[] = [
      [0, 1],
      [1, 2],
      [2, 3],
      [3, 4],
      [4, 5],
      [5, 0],
    ];
    const said = describeBonds(ring, bonds, ['C', 'C', 'C', 'C', 'C', 'C']);
    expect(said).toBe('C–C 結合性と反結合性が混在。');
  });

  it('lets the symmetry of two like atoms decide, where there is one', () => {
    // Nitrogen's 3sigma_g: a population slightly on the antibonding side, and
    // still the bonding orbital every textbook calls it (dev-notes, "V4-10 の確認").
    const n2 = populations(2, [[0, 1, -0.063]]);
    const bond: Bond[] = [[0, 1]];
    expect(describeBonds(n2, bond, ['N', 'N'])).toBe('N–N 反結合性。');
    const bySymmetry = verdictBySymmetry(1, 1);
    expect(describeBonds(n2, bond, ['N', 'N'], bySymmetry)).toBe('N–N 結合性。');
  });

  it('reads sigma_g and pi_u as bonding, sigma_u and pi_g as antibonding', () => {
    expect(verdictBySymmetry(1, 1)).toBe('bonding');
    expect(verdictBySymmetry(1, -1)).toBe('antibonding');
    expect(verdictBySymmetry(2, -1)).toBe('bonding');
    expect(verdictBySymmetry(2, 1)).toBe('antibonding');
    expect(verdictBySymmetry(1, null)).toBeNull();
    expect(verdictBySymmetry(3, 1)).toBeNull();
  });

  it('has nothing to say about a molecule with no bonds drawn', () => {
    expect(describeBonds(new Float64Array(1), [], ['O'])).toBe('');
  });
});

describe('what the picture is made of', () => {
  it('counts the blobs on screen, and says that is what they are', () => {
    expect(describeLobes({ positive: 2, negative: 2 })).toContain('4');
    expect(describeLobes({ positive: 2, negative: 2 })).toContain('しきい値');
    expect(describeLobes({ positive: 1, negative: 0 })).toContain('ひとかたまり');
    // A threshold above the whole orbital cuts nothing, and there is then
    // nothing to say rather than "nought blobs".
    expect(describeLobes({ positive: 0, negative: 0 })).toBe('');
  });

  it('finds the rung an orbital sits on, in its own spin’s ladder', () => {
    // The pi* of O2 is two orbitals on one rung of each spin, and the fourth
    // orbital of one spin is not the fourth of the other.
    expect(rungOf(OXYGEN, { index: 8, spin: 'up' })?.first).toBe(7);
    expect(rungOf(OXYGEN, { index: 4, spin: 'down' })?.first).toBe(4);
    expect(rungOf(OXYGEN, { index: 4, spin: 'up' })?.count).toBe(2);
    expect(rungOf(WATER, { index: 99, spin: 'both' })).toBeNull();
    expect(rungOf(null, { index: 0, spin: 'both' })).toBeNull();
    expect(rungOf(WATER, null)).toBeNull();
  });
});

describe('what the section is allowed to say', () => {
  it('names no DFT parameter, anywhere inside it (requirement F4)', () => {
    const forbidden = ['基底', 'STO-3G', '6-31G', '汎関数', 'LDA', 'VWN', '電荷', '多重度', 'DFT'];
    for (const word of forbidden) {
      expect(said).not.toContain(word);
      expect(said.toLowerCase()).not.toContain(word.toLowerCase());
    }
  });

  it('writes no orbital energy, in any unit', () => {
    // The order and the spacings are right and the values are not, so only the
    // picture is shown.
    for (const unit of ['Ha', 'eV', 'ハートリー', 'kJ']) expect(said).not.toContain(unit);
  });

  it('says where the ladder comes from when the other level was chosen', () => {
    expect(ORBITAL_OTHER_LEVEL).toBe('軌道は「形を探す」で計算したときに見られます。');
  });

  it('warns that the two colours are not more electrons and fewer', () => {
    expect(ORBITAL_SURFACE_HINT).toContain('符号');
    expect(ORBITAL_SURFACE_HINT).toContain('青');
  });
});

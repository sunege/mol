import { describe, expect, it } from 'vitest';
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
  spinHeading,
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
  return { spin, first, count, occupation, energy, parity: null, partner: null };
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
  MEMBER_GROUP_LABEL,
  frontierLabel('homo'),
  frontierLabel('lumo'),
  ...[0, 1, 2].flatMap((occupation) => [occupationMark(occupation), occupationText(occupation)]),
  ...[1, 2, 3].map(degenerateText),
  ...[0, 1, 2].flatMap((offset) => [memberLabel(offset, 1), memberLabel(offset, 3)]),
  ...([...OXYGEN, ...WATER].map((level) => spinHeading(level.spin) ?? '')),
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

  it('numbers the buttons only inside a rung that has several', () => {
    expect(memberLabel(0, 1)).toBe('見る');
    expect(memberLabel(0, 2)).toBe('1');
    expect(memberLabel(1, 2)).toBe('2');
    expect(MEMBER_GROUP_LABEL).not.toBe('');
  });

  it('numbers no rung, from either end', () => {
    // "The fourth from the top" is a fact about the list, and counting from the
    // bottom would be one about the basis.
    for (const word of ['番目', '本目', '番']) expect(said).not.toContain(word);
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

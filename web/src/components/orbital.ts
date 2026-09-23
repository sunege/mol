/**
 * The words of the molecular-orbital section: the ladder of orbitals, and what
 * picking one of them puts on screen.
 *
 * The section is closed until someone opens it, so none of this is on the
 * default screen (`docs/plan-v4.md`, decision 1). Requirement F4 still holds
 * inside it: nothing here names a basis, a functional, a charge or a
 * multiplicity. What it does show is the picture itself - which rungs hold
 * electrons, which are empty, which of them are the same height, and for a
 * molecule with unpaired electrons the two spins side by side - because that
 * is the thing being taught rather than a parameter of how it was computed
 * (decision 2). Reading the multiplicity off the two columns is the point of
 * them, not a leak.
 *
 * Three things are deliberately absent.
 *
 * Orbital energies are never written as numbers. LDA's are out by a factor of
 * several - water's highest occupied orbital comes out near -1.6 eV against an
 * ionisation energy of 12.6 eV - so the number would be wrong while the picture
 * built from the order and the spacings is right (decision 3).
 *
 * No rung is numbered, either: "the fourth from the top" is a fact about the
 * list on screen rather than about the molecule, and counting from the bottom
 * would be a fact about the basis, which is exactly what F4 keeps off the
 * screen. A rung is named by what it is - the highest with electrons in it, the
 * lowest without - and otherwise by its own picture.
 *
 * And a degenerate set is one rung rather than several. What the engine returns
 * inside such a set is an arbitrary rotation of it, so a single one of them is
 * not something the molecule has (`OrbitalLevel`); the row says how many there
 * are and lets the user step between them.
 */
import type { OrbitalLevel, SpinChannel } from '../worker/protocol';
import { levelLabel } from './level';

/** The heading of the section, which is also what the closed summary says. */
export const ORBITAL_HEADING = '分子軌道';

/** The line under the closed section: what is inside, in one sentence. */
export const ORBITAL_TEASER = '電子が入る「部屋」を 1 つずつ、形と色で見られます。';

/**
 * The line above the ladder: how to read it.
 *
 * It names HOMO and LUMO because those two are what the labels on the rungs
 * say, and a label nobody has been told the meaning of is worse than none.
 */
export const ORBITAL_INTRO =
  '上にある部屋ほど高く、電子は低いほうから順に入ります。● が電子、○ は空の部屋です。' +
  '電子が入っているいちばん高い部屋を HOMO、空のいちばん低い部屋を LUMO と呼びます。';

/** Nothing has been solved for the molecule on screen, so there is no ladder. */
export const ORBITAL_NEEDS_CALCULATION =
  '「安定な形にする」か「この形のまま計算」を押すと、電子の部屋がここに並びます。';

/** The ladder is a round trip to the worker, and a cheap one. */
export const ORBITAL_LOADING = '読み込み中…';

/**
 * The whole of the section for a result at the other level (decision 4).
 *
 * The orbitals of the smaller description are the textbook's own - one per
 * atomic orbital, and 36 of them for benzene against 102 - so they are the ones
 * worth drawing one at a time. The other level's answer is not shown as a
 * worse ladder; it is not shown at all.
 */
export const ORBITAL_OTHER_LEVEL = `軌道は「${levelLabel('shape')}」で計算したときに見られます。`;

/**
 * The line under the threshold slider, while an orbital is on screen.
 *
 * Its job is to stop the two colours being read as more electrons and fewer,
 * which is what they mean for the deformation density in the section above.
 */
export const ORBITAL_SURFACE_HINT =
  '選んだ部屋 1 つの形です。青と赤は符号の違いで、電子の濃さではありません。';

/**
 * The ends of the threshold slider, which say something different here.
 *
 * A density's slider runs from the cloud around the whole molecule to the dense
 * core at the nuclei. An orbital has no core to speak of: it is an amplitude
 * with lobes, and raising the threshold shrinks each lobe towards where it is
 * strongest rather than walking in towards a nucleus.
 */
export const ORBITAL_SCALE = { low: 'ふくらみ全体', high: '強いところ' };

/** Names the buttons that step between the orbitals of one rung. */
export const MEMBER_GROUP_LABEL = '同じ高さの軌道';

/**
 * The orbital on screen: which one, and whose ladder counts it.
 *
 * `index` is the orbital's place within its own spin channel - an
 * {@link OrbitalLevel}'s `first` plus an offset into its `count` - which is
 * what the isosurface request wants, and why the spin travels with it: the two
 * ladders both count from zero (`worker/protocol.ts`).
 */
export interface OrbitalPick {
  index: number;
  spin: SpinChannel;
}

/** Whether two picks are the same orbital, either of them possibly none. */
export function samePick(a: OrbitalPick | null, b: OrbitalPick | null): boolean {
  if (a === null || b === null) return a === b;
  return a.index === b.index && a.spin === b.spin;
}

/** Which end of the occupied orbitals a rung is, when it is either. */
export type Frontier = 'homo' | 'lumo';

/** One rung as the list shows it. */
export interface OrbitalRow {
  level: OrbitalLevel;
  /** Set on the highest rung with electrons and the lowest without. */
  frontier: Frontier | null;
}

/** One spin's ladder: the only column there is, or one of two. */
export interface OrbitalColumn {
  spin: SpinChannel;
  /** Null for a molecule with one column, which needs no heading. */
  heading: string | null;
  /** Highest rung first, which is the way a ladder is drawn. */
  rows: OrbitalRow[];
}

/**
 * The electrons on a rung, as circles: two, one, or an empty one.
 *
 * One mark for the rung rather than one per orbital on it, because a degenerate
 * rung holds the same number in each of them - what the row says beside it is
 * how many orbitals that is ({@link degenerateText}).
 */
export function occupationMark(occupation: number): string {
  if (occupation >= 2) return '●●';
  return occupation >= 1 ? '●' : '○';
}

/** The same, in words, for anything that has to read the mark aloud. */
export function occupationText(occupation: number): string {
  if (occupation >= 2) return '電子が 2 つ';
  return occupation >= 1 ? '電子が 1 つ' : '空の部屋';
}

/** How many orbitals share the rung, or nothing at all when it is one. */
export function degenerateText(count: number): string {
  return count >= 2 ? `同じ高さの軌道が ${count} つ` : '';
}

/**
 * What the button on a rung says: which of the several, or just "look".
 *
 * The numbers run inside the rung and mean nothing outside it, which is why
 * they appear only where there is something to choose between.
 */
export function memberLabel(offset: number, count: number): string {
  return count >= 2 ? `${offset + 1}` : '見る';
}

export function frontierLabel(frontier: Frontier): string {
  return frontier === 'homo' ? 'HOMO' : 'LUMO';
}

/** The heading of a spin's column, or null where there is only one column. */
export function spinHeading(spin: SpinChannel): string | null {
  if (spin === 'up') return '上向きのスピン';
  return spin === 'down' ? '下向きのスピン' : null;
}

/**
 * Splits the rungs the engine returned into the columns the panel draws.
 *
 * A closed-shell molecule has one column and no heading. One with unpaired
 * electrons has two, and they are never folded into one: the same orbital sits
 * at genuinely different heights in the two spins - O2's pi* is about 0.08
 * Hartree lower in the spin that fills it - and it is that difference which
 * puts one electron in each of two orbitals there (decision 7).
 *
 * Within a column the rungs are reversed, because they arrive lowest first and
 * a ladder is read from the top.
 */
export function orbitalColumns(levels: readonly OrbitalLevel[]): OrbitalColumn[] {
  const spins: SpinChannel[] = [];
  for (const level of levels) if (!spins.includes(level.spin)) spins.push(level.spin);
  return spins.map((spin) => {
    const rungs = levels.filter((level) => level.spin === spin);
    const homo = lastIndex(rungs, (level) => level.occupation > 0);
    const lumo = rungs.findIndex((level) => level.occupation <= 0);
    return {
      spin,
      heading: spins.length > 1 ? spinHeading(spin) : null,
      rows: rungs
        .map((level, index) => ({
          level,
          frontier: index === homo ? ('homo' as const) : index === lumo ? ('lumo' as const) : null,
        }))
        .reverse(),
    };
  });
}

function lastIndex<T>(items: readonly T[], holds: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i--) if (holds(items[i])) return i;
  return -1;
}

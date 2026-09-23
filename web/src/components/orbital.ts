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
 * not something the molecule has (`OrbitalLevel`); the ladder draws the whole
 * set at one height, a line each, and lets the user step between them
 * (`components/ladder.ts`).
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
 * The electrons in one orbital, as circles: two, one, or an empty one.
 *
 * One mark per orbital rather than one per rung, because the ladder draws a
 * line for each of them and a degenerate rung holds the same number in every
 * one - which is how the two half-filled orbitals of O2's pi* are read off the
 * picture rather than counted in words.
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

export function frontierLabel(frontier: Frontier): string {
  return frontier === 'homo' ? 'HOMO' : 'LUMO';
}

/** The heading of a spin's column, or null where there is only one column. */
export function spinHeading(spin: SpinChannel): string | null {
  if (spin === 'up') return '上向きのスピン';
  return spin === 'down' ? '下向きのスピン' : null;
}

/**
 * What the ladder as a whole is, for anyone who cannot see it.
 *
 * Every line in it is a button of its own ({@link ladderRungLabel}); this names
 * the thing they are arranged into.
 */
export const LADDER_LABEL = '分子軌道の準位';

/**
 * The rungs folded off the bottom of the ladder, in one line.
 *
 * The electrons that stay on one atom sit far below every other rung - about 17
 * Hartree below in water, 9 in benzene - so a ladder drawn to scale with them
 * on it squashes everything else into a single line. They are cut away and
 * counted instead, which loses nothing of what is being taught: an orbital that
 * is one atom's innermost shell is not a room the molecule's electrons moved
 * into (`components/ladder.ts`).
 */
export function coreText(orbitals: number): string {
  return `ここより下に ${orbitals} 本（原子に張りついた電子）`;
}

/**
 * One line of the ladder, read aloud.
 *
 * The line itself carries no text - the picture says what it is by where it
 * sits and what is drawn above it - so everything a sighted reader takes from
 * its place has to be in this label: which spin's ladder it belongs to where
 * there are two, how many electrons are in it, whether it is either end of the
 * occupied ones, and which of the several orbitals at that height it is.
 */
export function ladderRungLabel(row: OrbitalRow, offset: number, heading: string | null): string {
  const said = heading === null ? [] : [heading];
  said.push(occupationText(row.level.occupation));
  if (row.frontier !== null) said.push(frontierLabel(row.frontier));
  if (row.level.count >= 2) said.push(`${degenerateText(row.level.count)}の ${offset + 1} つめ`);
  return said.join('、');
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

/**
 * A pair of atoms the viewer draws a bond between, as indices into the molecule.
 *
 * Whose bonds these are matters: they are `scene/bonds.ts`'s guess from the
 * geometry, made for drawing, and the engine has never seen them. The engine
 * answers about every pair of nuclei ({@link OrbitalCharacter.populations}) and
 * the words below read the pairs the user can see out of that.
 */
export type Bond = readonly [number, number];

/**
 * An overlap population smaller than this counts as doing nothing to the bond.
 *
 * Measured on the molecules to hand, in the smaller description
 * (`docs/dev-notes.md`, "v4-0 の実測"): water's lone pair is -0.0000 across both
 * O-H bonds, and everything that is doing something is an order of magnitude
 * above that - water's two bonding orbitals +0.298 and +0.335, its lowest empty
 * one -0.934, ethylene's pi +0.384 and pi* -0.312, the pi* O2 puts its unpaired
 * electrons in -0.180. The smallest of them is -0.118 (water's third orbital,
 * mildly antibonding), so anywhere between zero and a tenth divides the two
 * groups; this sits an order of magnitude above the noise of the first and
 * comfortably below the second. It is a threshold on a Mulliken population,
 * which is a convention for dividing electrons between atoms rather than a
 * measurement.
 *
 * With more molecules the gap closes (`docs/dev-notes.md`, "V4-9 の実測", every
 * orbital of ethylene, benzene, NH3, CH4 and formaldehyde): the bonds' values
 * run on without a break from 0.005 to 0.1. Kept here because it is still in
 * the widest opening near it, between ethylene's -0.0488 (the C-C of an
 * orbital that is about its C-H bonds) and benzene's -0.0542, and because
 * what it decides reads right on both sides: NH3's lone pair (-0.041) does
 * nothing to its N-H bonds, and both of benzene's lowest empty orbitals weaken
 * C-C. What no value can fix is the two orbitals of a degenerate rung saying
 * different things - benzene's HOMO pair differs at 0.05, and raising this to
 * 0.07 to mend it breaks the pair of its second valence rung instead - because
 * the split inside the rung is arbitrary and so are its members' populations.
 */
export const BOND_POPULATION_THRESHOLD = 0.05;

/**
 * An amplitude below this fraction of the orbital's largest carries no sign.
 *
 * The probes stand one Bohr off the plane above every nucleus, hydrogens
 * included, and a hydrogen reads the tail of its neighbour's lobe rather than
 * anything of its own - 11% of the largest in ethylene's pi, which is why this
 * floor is well below that and is not what makes the count come out right. What
 * it is for is the nucleus that sits on a node of the orbital, where the probe
 * reads a number that is zero up to the arithmetic and whose sign means
 * nothing (`countNodes`).
 */
export const AMPLITUDE_FLOOR = 0.05;

/** Nothing this orbital does to any bond the viewer is drawing. */
export const NO_BOND_EFFECT = 'どの結合も強めていません（弱めてもいません）。';

/** The rung the picked orbital sits on, which is what knows whether it is pi. */
export function rungOf(
  levels: readonly OrbitalLevel[] | null,
  pick: OrbitalPick | null,
): OrbitalLevel | null {
  if (levels === null || pick === null) return null;
  return (
    levels.find(
      (level) =>
        level.spin === pick.spin &&
        pick.index >= level.first &&
        pick.index < level.first + level.count,
    ) ?? null
  );
}

/** `C–H`, `O–H`, `C–C`: hydrogen last, and the rest in alphabetical order. */
function bondLabel(one: string, other: string): string {
  const swap = one === 'H' ? other !== 'H' : other !== 'H' && other < one;
  return swap ? `${other}–${one}` : `${one}–${other}`;
}

/** What an orbital does to the bonds of one kind, summed over all of them. */
type BondVerdict = 'bonding' | 'antibonding' | 'mixed' | 'none';

/**
 * Which bonds the orbital is holding together and which it is pulling apart.
 *
 * The sign and the size of the overlap population, never the number itself: the
 * value is a convention for splitting electrons between atoms rather than a
 * measurement, and it moves by a factor of two when the description changes,
 * while its sign does not (`docs/dev-notes.md`, "v4-0 の実測"). A number would
 * invite reading a difference between two of them, which is exactly what it
 * cannot carry.
 *
 * Bonds are spoken of by kind rather than one by one - "C–C" rather than six
 * separate carbon pairs - because that is how a molecule is talked about, and
 * because six clauses would not fit the panel. Where one kind is doing both
 * things at once, which is what a pi orbital of a ring does, it says so instead
 * of picking a side.
 */
export function describeBonds(
  populations: ArrayLike<number>,
  bonds: readonly Bond[],
  symbols: readonly string[],
): string {
  const atoms = symbols.length;
  const kinds = new Map<string, { strengthens: number; weakens: number; strongest: number }>();
  for (const [a, b] of bonds) {
    if (a >= atoms || b >= atoms) continue;
    const population = populations[a * atoms + b] ?? 0;
    const label = bondLabel(symbols[a], symbols[b]);
    const kind = kinds.get(label) ?? { strengthens: 0, weakens: 0, strongest: 0 };
    if (population > BOND_POPULATION_THRESHOLD) kind.strengthens += 1;
    else if (population < -BOND_POPULATION_THRESHOLD) kind.weakens += 1;
    kind.strongest = Math.max(kind.strongest, Math.abs(population));
    kinds.set(label, kind);
  }
  if (kinds.size === 0) return '';
  // Loudest first, which puts the bonds it leaves alone at the end.
  const ordered = [...kinds].sort(([, a], [, b]) => b.strongest - a.strongest);
  if (ordered.every(([, kind]) => kind.strengthens === 0 && kind.weakens === 0)) {
    return NO_BOND_EFFECT;
  }
  return (
    ordered
      .map(([label, kind], index) =>
        bondClause(label, verdictOf(kind), index === ordered.length - 1),
      )
      .join('、') + '。'
  );
}

function verdictOf(kind: { strengthens: number; weakens: number }): BondVerdict {
  if (kind.strengthens > 0 && kind.weakens > 0) return 'mixed';
  if (kind.strengthens > 0) return 'bonding';
  return kind.weakens > 0 ? 'antibonding' : 'none';
}

/** One clause, in the form that ends the sentence or the one that carries on. */
function bondClause(label: string, verdict: BondVerdict, last: boolean): string {
  switch (verdict) {
    case 'bonding':
      return last ? `${label} を強めています` : `${label} を強め`;
    case 'antibonding':
      return last ? `${label} を弱めています` : `${label} を弱め`;
    case 'mixed':
      return last
        ? `${label} は強めるところと弱めるところがあります`
        : `${label} は強めるところと弱めるところがあり`;
    case 'none':
      return last ? `${label} には効いていません` : `${label} には効いておらず`;
  }
}

/**
 * How many nodes the pi system has, or null where the question does not arise.
 *
 * A node is where the orbital changes sign, and counting them in general is not
 * something anyone does: the number of surfaces an arbitrary orbital vanishes on
 * is not a thing the textbooks count. What they do count is the nodes of a flat
 * conjugated system's pi orbitals, where the answer is read off a row of lobes
 * sitting on the nuclei - and that is all this counts. The caller asks only for
 * a rung the reflection calls pi; a molecule with no plane has no amplitudes to
 * pass and gets null here.
 *
 * The count is sign changes between neighbouring nuclei, halved for a ring
 * because walking all the way round it crosses every node twice. A nucleus
 * sitting on a node of its own reads about zero and carries no sign
 * ({@link AMPLITUDE_FLOOR}); it is stepped over rather than counted as a change,
 * so its two neighbours are compared with each other - which is what makes the
 * two halves of benzene's degenerate highest occupied pair come out the same.
 */
export function countNodes(
  amplitudes: ArrayLike<number> | null,
  bonds: readonly Bond[],
): number | null {
  if (amplitudes === null) return null;
  const atoms = amplitudes.length;
  let largest = 0;
  for (let i = 0; i < atoms; i++) largest = Math.max(largest, Math.abs(amplitudes[i]));
  if (largest === 0) return null;
  const floor = largest * AMPLITUDE_FLOOR;
  const signs = Array.from({ length: atoms }, (_, i) =>
    Math.abs(amplitudes[i]) < floor ? 0 : Math.sign(amplitudes[i]),
  );
  if (signs.filter((sign) => sign !== 0).length < 2) return null;

  const neighbours: number[][] = Array.from({ length: atoms }, () => []);
  for (const [a, b] of bonds) {
    if (a >= atoms || b >= atoms || a === b) continue;
    neighbours[a].push(b);
    neighbours[b].push(a);
  }

  let changes = 0;
  for (let start = 0; start < atoms; start++) {
    if (signs[start] === 0) continue;
    for (const end of signedNeighbours(start, signs, neighbours)) {
      // Each pair once: the walk is symmetric, so the other end finds this one.
      if (end > start && signs[end] !== signs[start]) changes += 1;
    }
  }
  // A ring is the only shape where the bonds outnumber the atoms, hydrogens and
  // all: every atom brings one bond with it, and closing a loop adds one more.
  const ring = bonds.length >= atoms;
  return ring ? Math.round(changes / 2) : changes;
}

/** The atoms an atom meets along the bonds, stepping over the unsigned ones. */
function signedNeighbours(
  start: number,
  signs: readonly number[],
  neighbours: readonly number[][],
): number[] {
  const found: number[] = [];
  const seen = new Set<number>([start]);
  const queue = [...neighbours[start]];
  while (queue.length > 0) {
    const at = queue.pop()!;
    if (seen.has(at)) continue;
    seen.add(at);
    if (signs[at] !== 0) found.push(at);
    else queue.push(...neighbours[at]);
  }
  return found;
}

/** How many nodes were counted, in words. */
export function describeNodes(count: number): string {
  return count === 0
    ? '節 0 枚: 並んだ原子の上で色が変わりません。'
    : `節 ${count} 枚: 並んだ原子の上で色が変わるところがあります。`;
}

/**
 * How many separate blobs the surface came out in, at the threshold it is cut
 * at now.
 *
 * Which is why it says so: the number is a fact about the picture on screen and
 * not about the orbital, and raising the threshold pulls a lobe apart into two
 * while lowering it runs them together ({@link IsoMesh.lobes}).
 */
export function describeLobes(lobes: { positive: number; negative: number }): string {
  const total = lobes.positive + lobes.negative;
  if (total === 0) return '';
  return total === 1
    ? 'いまのしきい値では、ひとかたまりです。'
    : `いまのしきい値では、かたまりが ${total} つに分かれています。`;
}

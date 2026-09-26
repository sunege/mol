/**
 * Ions (v7): what a charge on an atom allows, and every word and mark it puts
 * on screen.
 *
 * The charge sits on the atom (`SceneAtom.charge`, -1 / 0 / +1), but the engine
 * solves only for the molecule's total, so most of what is decided here is
 * about the total: whether any electrons are left, and whether it is inside
 * the range the engine was measured to handle (V7-0). The one per-atom rule is
 * that a noble gas cannot take an extra electron.
 *
 * The charge is shown (requirement F4, read again for v7: the user put it
 * there, so it is part of what they built, not a setting of the method) - a
 * mark on the atom and a superscript after the formula. Nothing here says how
 * the engine treats it: no multiplicity, basis or functional, and no computed
 * per-atom charge.
 */
import type { SegmentedOption } from './controls';
import type { AtomCharge, SceneAtom } from '../scene/viewer';

/**
 * The range of the molecule's total charge (V7-0). +3 pulls a molecule apart
 * during optimisation (CH4 3+ throws off its hydrogens) and +4 does not solve
 * at all; -2 is where a sulfate still solves plainly. A single atom stays
 * within -1 / 0 / +1 whatever the total.
 */
export const MIN_TOTAL_CHARGE = -2;
export const MAX_TOTAL_CHARGE = 2;

/**
 * He, Ne and Ar: their minimal basis has nowhere for an extra electron to go,
 * so the engine would silently drop it (and refuses it since V7-1). No noble
 * gas anion exists anyway.
 */
const NO_ANION: ReadonlySet<number> = new Set([2, 10, 18]);

export function totalCharge(atoms: readonly SceneAtom[]): number {
  return atoms.reduce((sum, atom) => sum + (atom.charge ?? 0), 0);
}

/** The molecule's electrons: the nuclear charges less the charge put on it. */
export function electronCount(atoms: readonly SceneAtom[]): number {
  return atoms.reduce((sum, atom) => sum + atom.z - (atom.charge ?? 0), 0);
}

/** The three buttons of the ion row, as values a `Segmented` can hold. */
export type IonChoice = 'minus' | 'neutral' | 'plus';

const CHARGE_OF: Record<IonChoice, AtomCharge> = { minus: -1, neutral: 0, plus: 1 };

export function chargeOfChoice(choice: IonChoice): AtomCharge {
  return CHARGE_OF[choice];
}

export function choiceOfCharge(charge: AtomCharge | undefined): IonChoice {
  return charge === -1 ? 'minus' : charge === 1 ? 'plus' : 'neutral';
}

/** Names the row for a screen reader. */
export const ION_GROUP_LABEL = 'イオン';

/** Short enough that the three fit on one line of the panel. */
export const ION_OPTIONS: readonly SegmentedOption<IonChoice>[] = [
  { value: 'minus', label: '− にする' },
  { value: 'neutral', label: '中性' },
  { value: 'plus', label: '+ にする' },
];

/**
 * Which of -1 / 0 / +1 the atom at `index` could be made into. The one it is
 * now is always allowed (pressing it changes nothing); another is not when it
 * would leave the molecule without a single electron, take the total outside
 * {@link MIN_TOTAL_CHARGE}..{@link MAX_TOTAL_CHARGE}, or give a noble gas an
 * extra electron.
 */
export function chargeChoices(
  atoms: readonly SceneAtom[],
  index: number,
): Record<IonChoice, boolean> {
  const atom = atoms[index];
  if (atom === undefined) throw new RangeError(`no atom ${index}`);
  const now = atom.charge ?? 0;
  const total = totalCharge(atoms);
  const electrons = electronCount(atoms);
  const allowed = (charge: AtomCharge): boolean => {
    if (charge === now) return true;
    const nextTotal = total - now + charge;
    if (electrons + now - charge < 1) return false;
    if (nextTotal < MIN_TOTAL_CHARGE || nextTotal > MAX_TOTAL_CHARGE) return false;
    return !(charge < 0 && NO_ANION.has(atom.z));
  };
  return { minus: allowed(-1), neutral: allowed(0), plus: allowed(1) };
}

/** {@link ION_OPTIONS} with the ones that cannot be chosen disabled, ready for `Segmented`. */
export function ionOptions(
  atoms: readonly SceneAtom[],
  index: number,
): SegmentedOption<IonChoice>[] {
  const allowed = chargeChoices(atoms, index);
  return ION_OPTIONS.map((option) => ({ ...option, disabled: !allowed[option.value] }));
}

const SUPERSCRIPT_DIGITS = '⁰¹²³⁴⁵⁶⁷⁸⁹';

/** The superscript after a formula: ⁺ ⁻ ²⁺ ²⁻, and nothing for a neutral molecule. */
export function chargeSuffix(total: number): string {
  if (total === 0) return '';
  const size = Math.abs(total);
  const digits =
    size === 1 ? '' : String(size).replace(/\d/g, (d) => SUPERSCRIPT_DIGITS[Number(d)]);
  return digits + (total > 0 ? '⁺' : '⁻');
}

/** H₃O + 1 → H₃O⁺. The formula is `hillFormula`'s as it is; the charge only follows it. */
export function formulaWithCharge(formula: string, total: number): string {
  return formula + chargeSuffix(total);
}

/** The mark on an atom in the 3D view: + or − (U+2212), nothing when neutral. */
export function badgeText(charge: AtomCharge | undefined): string | null {
  if (charge === 1) return '+';
  if (charge === -1) return '−';
  return null;
}

/** Whether any atom was made negative, which is when the caveat below is shown. */
export function hasAnion(atoms: readonly SceneAtom[]): boolean {
  return atoms.some((atom) => (atom.charge ?? 0) < 0);
}

/** Whether any atom carries a charge at all, which changes the deformation density's words. */
export function hasIons(atoms: readonly SceneAtom[]): boolean {
  return atoms.some((atom) => (atom.charge ?? 0) !== 0);
}

/**
 * Shown while a negative charge is placed (V7-0). It blames the method, not
 * the anion: OH-, F-, Cl-, CN- and NH2- really do keep their extra electron,
 * and it is this way of calculating that puts it too loosely - which holds for
 * a single and a double charge alike.
 */
export const ANION_CAVEAT =
  '陰イオンの余分な電子は、この計算のしかたが苦手とするところです。形は出ますが、余分な電子の広がり方は目安として見てください。';

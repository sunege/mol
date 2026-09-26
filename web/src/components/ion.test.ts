import { describe, expect, it } from 'vitest';
import {
  ANION_CAVEAT,
  ION_GROUP_LABEL,
  ION_OPTIONS,
  MAX_TOTAL_CHARGE,
  MIN_TOTAL_CHARGE,
  badgeText,
  chargeChoices,
  chargeOfChoice,
  chargeSuffix,
  choiceOfCharge,
  electronCount,
  formulaWithCharge,
  hasAnion,
  hasIons,
  ionOptions,
  totalCharge,
} from './ion';
import type { AtomCharge, SceneAtom } from '../scene/viewer';

const at = (z: number, charge?: AtomCharge): SceneAtom =>
  charge === undefined ? { z, pos: [0, 0, 0] } : { z, pos: [0, 0, 0], charge };

describe('totals', () => {
  it('adds the charges and takes them from the electrons', () => {
    const hydronium = [at(8), at(1), at(1), at(1, 1)];
    expect(totalCharge(hydronium)).toBe(1);
    expect(electronCount(hydronium)).toBe(10);
    expect(totalCharge([at(11, 1), at(17, -1)])).toBe(0);
    expect(electronCount([at(11, 1), at(17, -1)])).toBe(28);
  });
});

describe('which charges can be put on an atom', () => {
  it('never leaves a molecule without electrons', () => {
    expect(chargeChoices([at(1)], 0)).toEqual({ minus: true, neutral: true, plus: false });
    const h2 = [at(1, 1), at(1)];
    expect(chargeChoices(h2, 1).plus).toBe(false);
    expect(chargeChoices(h2, 1).minus).toBe(true);
  });

  it('always allows the charge the atom has now', () => {
    for (const charge of [-1, 0, 1] as AtomCharge[]) {
      const atoms = [at(8, charge), at(1), at(1)];
      expect(chargeChoices(atoms, 0)[choiceOfCharge(charge)]).toBe(true);
    }
  });

  it('allows the total up to the limit and not past it', () => {
    // Four hydrogens and a carbon: the total can be walked one atom at a time.
    const up = [at(6), at(1, 1), at(1), at(1), at(1)];
    expect(chargeChoices(up, 2).plus).toBe(true);
    up[2] = at(1, 1);
    expect(totalCharge(up)).toBe(MAX_TOTAL_CHARGE);
    expect(chargeChoices(up, 3).plus).toBe(false);
    expect(chargeChoices(up, 3).minus).toBe(true);

    const down = [at(16), at(8, -1), at(8), at(8), at(8)];
    expect(chargeChoices(down, 2).minus).toBe(true);
    down[2] = at(8, -1);
    expect(totalCharge(down)).toBe(MIN_TOTAL_CHARGE);
    expect(chargeChoices(down, 3).minus).toBe(false);
    expect(chargeChoices(down, 3).plus).toBe(true);
    // Moving a charge from one atom to another keeps the total, so the atom
    // already charged can always go back to neutral.
    expect(chargeChoices(down, 1).neutral).toBe(true);
  });

  it('never gives a noble gas an extra electron', () => {
    for (const z of [2, 10, 18]) {
      expect(chargeChoices([at(z)], 0)).toEqual({ minus: false, neutral: true, plus: true });
    }
    expect(chargeChoices([at(9)], 0).minus).toBe(true);
  });

  it('refuses an atom that is not there', () => {
    expect(() => chargeChoices([at(1)], 1)).toThrow(RangeError);
  });

  it('hands Segmented the same answer as disabled options', () => {
    const options = ionOptions([at(1)], 0);
    expect(options.map((o) => o.value)).toEqual(ION_OPTIONS.map((o) => o.value));
    expect(options.map((o) => o.disabled)).toEqual([false, false, true]);
    // The shared options are not changed by it.
    expect(ION_OPTIONS.every((o) => o.disabled === undefined)).toBe(true);
  });

  it('maps each button to its charge and back', () => {
    for (const option of ION_OPTIONS) {
      expect(choiceOfCharge(chargeOfChoice(option.value))).toBe(option.value);
    }
    expect(choiceOfCharge(undefined)).toBe('neutral');
  });
});

describe('the charge after a formula', () => {
  it('follows the formula as a superscript', () => {
    expect(formulaWithCharge('H₃O', 1)).toBe('H₃O⁺');
    expect(formulaWithCharge('OH', -1)).toBe('OH⁻');
    expect(formulaWithCharge('O₄S', -2)).toBe('O₄S²⁻');
    expect(formulaWithCharge('H₄N₂', 2)).toBe('H₄N₂²⁺');
    expect(formulaWithCharge('H₂O', 0)).toBe('H₂O');
    expect(chargeSuffix(0)).toBe('');
  });
});

describe('the mark on an atom', () => {
  it('is + or a real minus sign, and nothing when neutral', () => {
    expect(badgeText(1)).toBe('+');
    expect(badgeText(-1)).toBe('−');
    expect(badgeText(0)).toBeNull();
    expect(badgeText(undefined)).toBeNull();
  });
});

describe('the anion caveat', () => {
  it('is shown whenever any atom is negative', () => {
    expect(hasAnion([at(8, -1), at(1)])).toBe(true);
    expect(hasAnion([at(11, 1), at(17, -1)])).toBe(true);
    expect(hasAnion([at(8), at(1, 1)])).toBe(false);
    expect(hasIons([at(8), at(1, 1)])).toBe(true);
    expect(hasIons([at(8), at(1, 0)])).toBe(false);
  });
});

describe('the words', () => {
  const said = [
    ION_GROUP_LABEL,
    ...ION_OPTIONS.map((o) => o.label),
    ANION_CAVEAT,
    ...[-2, -1, 1, 2].map((t) => formulaWithCharge('H₃O', t)),
  ].join(' ');

  it('fit the three buttons on one line', () => {
    for (const option of ION_OPTIONS) expect(option.label.length).toBeLessThanOrEqual(5);
  });

  it('put no number and no name of the method on screen (requirement F4)', () => {
    expect(said).not.toMatch(/\d/);
    for (const word of ['基底', 'STO-3G', '6-31G', '汎関数', 'LDA', 'VWN', '多重度', 'DFT']) {
      expect(said.toLowerCase()).not.toContain(word.toLowerCase());
    }
  });
});

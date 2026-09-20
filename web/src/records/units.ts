/**
 * The energy unit the structure log shows.
 *
 * Total energies are in Hartree, and there is no point putting one on screen:
 * -227.264326 says nothing to a class, and two of them differ in the sixth
 * digit. What is worth showing is how much deeper one shape is than another,
 * which is a number chemistry already has a unit for - kJ/mol, where a hydrogen
 * bond is about 20 and a C-C bond about 350.
 *
 * The factor is one mole of Hartrees. Like every other constant in this project
 * it is generated rather than typed: `units.json` comes from
 * `scripts/gen_reference.py` (`write_units`), out of `scipy.constants`.
 */
import units from './units.json';

/** Kilojoules per mole in one Hartree per particle. */
export const HARTREE_TO_KJ_PER_MOL: number = units.hartreeToKilojoulesPerMole;

/** Where that number came from, for anyone who wonders whether to trust it. */
export const UNITS_SOURCE: string = units.source;

/** An energy difference in Hartree, as the interface says it. */
export function kilojoulesPerMole(hartree: number): number {
  return hartree * HARTREE_TO_KJ_PER_MOL;
}

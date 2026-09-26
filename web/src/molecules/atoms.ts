/**
 * Atoms rebuilt from the flat arrays the engine and the records work in.
 *
 * Both used to live in `App.tsx` and rebuilt each atom as `{ z, pos }`, which
 * was the whole of an atom until v7 put a charge on it. Every structure that
 * comes back - each step of a relaxation, a record opened, a candidate taken
 * from the search - passes through one of these, so this is where the charge
 * has to survive: lose it here and an H3O+ quietly comes back as H3O.
 *
 * A neutral atom carries no `charge` at all rather than `charge: 0`, so atoms
 * that never had one keep the shape they always had.
 */
import type { AtomCharge, SceneAtom } from '../scene/viewer';

type Vec3 = [number, number, number];

function positionAt(xyz: ArrayLike<number>, i: number): Vec3 {
  return [xyz[3 * i], xyz[3 * i + 1], xyz[3 * i + 2]];
}

function atom(z: number, pos: Vec3, charge: number | undefined): SceneAtom {
  return charge ? { z, pos, charge: charge as AtomCharge } : { z, pos };
}

/**
 * The same atoms at new positions, which is what a finished relaxation returns.
 *
 * Elements and charges never change - only the optimiser's coordinates do - so
 * both come from the structure that went in.
 */
export function withPositions(atoms: readonly SceneAtom[], xyz: ArrayLike<number>): SceneAtom[] {
  return atoms.map((a, i) => atom(a.z, positionAt(xyz, i), a.charge));
}

/**
 * Atoms from the flattened pair the records and the search both keep, with a
 * charge per atom when there is one (absent means all neutral, as every record
 * written before v7 is).
 */
export function atomsFromFlat(
  z: ArrayLike<number>,
  xyz: ArrayLike<number>,
  charges?: ArrayLike<number>,
): SceneAtom[] {
  return Array.from({ length: z.length }, (_, i) =>
    atom(z[i], positionAt(xyz, i), charges?.[i]),
  );
}

import type { SceneAtom } from './viewer';

/** Atoms closer than the scaled sum of their covalent radii get a bond drawn. */
export const BOND_TOLERANCE = 1.25;

/**
 * Bonds inferred purely from geometry, for rendering.
 *
 * This is a display heuristic, not chemistry: the engine never sees it, and it
 * says nothing about bond order. Two atoms are joined when their separation is
 * within `BOND_TOLERANCE` of the sum of their covalent radii.
 */
export function findBonds(
  atoms: SceneAtom[],
  covalentRadius: (z: number) => number,
): Array<[number, number]> {
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i < atoms.length; i++) {
    for (let j = i + 1; j < atoms.length; j++) {
      const limit = (covalentRadius(atoms[i].z) + covalentRadius(atoms[j].z)) * BOND_TOLERANCE;
      const dx = atoms[i].pos[0] - atoms[j].pos[0];
      const dy = atoms[i].pos[1] - atoms[j].pos[1];
      const dz = atoms[i].pos[2] - atoms[j].pos[2];
      if (Math.hypot(dx, dy, dz) <= limit) pairs.push([i, j]);
    }
  }
  return pairs;
}

/**
 * Starting geometries offered in the UI.
 *
 * These are experimental (or, for benzene, idealised) structures in Angstrom.
 * They double as the manual test set: water and methane for the closed-shell
 * path, O2 for the automatic triplet detection, benzene for the performance
 * target.
 */
import type { SceneAtom } from '../scene/viewer';

export interface Preset {
  id: string;
  /** Formula as shown in the UI. */
  label: string;
  atoms: SceneAtom[];
}

/** Idealised planar ring: C-C 1.39 A, C-H 1.09 A. */
function benzene(): SceneAtom[] {
  const atoms: SceneAtom[] = [];
  const rC = 1.39;
  const rH = rC + 1.09;
  for (let i = 0; i < 6; i++) {
    const angle = (i * Math.PI) / 3;
    atoms.push({ z: 6, pos: [rC * Math.cos(angle), rC * Math.sin(angle), 0] });
  }
  for (let i = 0; i < 6; i++) {
    const angle = (i * Math.PI) / 3;
    atoms.push({ z: 1, pos: [rH * Math.cos(angle), rH * Math.sin(angle), 0] });
  }
  return atoms;
}

export const PRESETS: Preset[] = [
  {
    id: 'h2o',
    label: 'H₂O',
    atoms: [
      { z: 8, pos: [0, 0, 0.1173] },
      { z: 1, pos: [0, 0.7572, -0.4693] },
      { z: 1, pos: [0, -0.7572, -0.4693] },
    ],
  },
  {
    id: 'o2',
    label: 'O₂',
    atoms: [
      { z: 8, pos: [0, 0, -0.604] },
      { z: 8, pos: [0, 0, 0.604] },
    ],
  },
  {
    id: 'nh3',
    label: 'NH₃',
    atoms: [
      { z: 7, pos: [0, 0, 0.1173] },
      { z: 1, pos: [0, 0.9377, -0.2739] },
      { z: 1, pos: [0.8121, -0.4689, -0.2739] },
      { z: 1, pos: [-0.8121, -0.4689, -0.2739] },
    ],
  },
  {
    id: 'ch4',
    label: 'CH₄',
    atoms: [
      { z: 6, pos: [0, 0, 0] },
      { z: 1, pos: [0.6276, 0.6276, 0.6276] },
      { z: 1, pos: [-0.6276, -0.6276, 0.6276] },
      { z: 1, pos: [-0.6276, 0.6276, -0.6276] },
      { z: 1, pos: [0.6276, -0.6276, -0.6276] },
    ],
  },
  { id: 'c6h6', label: 'C₆H₆', atoms: benzene() },
];

/**
 * Flattens atoms into the arrays the worker expects - the only place they are
 * made. `charges` is always there, all zeros for a neutral molecule, so the
 * caller never has to decide whether to send it.
 */
export function toWorkerArrays(atoms: SceneAtom[]): {
  z: Uint8Array;
  xyz: Float64Array;
  charges: Int8Array;
} {
  const z = new Uint8Array(atoms.length);
  const xyz = new Float64Array(atoms.length * 3);
  const charges = new Int8Array(atoms.length);
  atoms.forEach((atom, i) => {
    z[i] = atom.z;
    xyz.set(atom.pos, i * 3);
    charges[i] = atom.charge ?? 0;
  });
  return { z, xyz, charges };
}

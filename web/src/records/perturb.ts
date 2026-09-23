/**
 * The small random nudge that takes a flat structure off its plane before it is
 * relaxed.
 *
 * The forces on a symmetric structure are symmetric, so an optimiser started on
 * one never leaves it: the part of the gradient that would break the symmetry is
 * exactly zero, and what the optimiser settles on is whatever the energy does
 * *within* that symmetry - a saddle as readily as a minimum. This matters here
 * because clicking builds symmetric structures without meaning to. A plain click
 * places an atom where the pointer crosses a camera-facing plane through the
 * molecule's centre (`scene/viewer.ts`), so a molecule built without turning the
 * camera is exactly planar, to the last digit. Relaxing a flat methane keeps it
 * flat and reports it settled, 834 kJ/mol above the tetrahedron it should have
 * found; a flat ammonia stays flat, 39 kJ/mol up (`docs/dev-notes.md`, "P9 の実測").
 *
 * So a flat structure is nudged off its plane before it is handed to the
 * optimiser. The nudge is not a model of anything - it is only there to let the
 * optimiser see the directions the plane was hiding.
 *
 * It is worth being narrow about when to do it, because it is not free: a
 * structure with no symmetry left takes the optimiser many more steps to bring
 * to a stop (benzene, three steps and 25 seconds as it is, fifteen steps and 70
 * seconds nudged). Two things keep that off the cases that cannot benefit:
 *
 * - **only flat structures** ({@link isFlat}). A molecule built with Shift, or
 *   with the camera turned between clicks, has no plane, and nothing else about
 *   clicking makes an exact symmetry.
 * - **only structures the user built or edited** ({@link needsNudge}): a preset,
 *   a structure opened from the log, and the structure a relaxation has just
 *   produced are all shapes we supplied rather than ones that came out of the
 *   camera plane, and their symmetry is the molecule's own. Benzene really is
 *   flat, and nudging it only costs the lecture a minute.
 */

/**
 * How far each atom is moved, in Angstrom.
 *
 * Measured rather than guessed (`docs/dev-notes.md`, "P9 の実測"). Large enough
 * that what is left of the symmetry-breaking force once the structure has come
 * back down still exceeds the optimiser's convergence threshold: below this, a
 * flat ammonia settles back into its plane for some of the directions it is
 * pushed in, and a third of the nudges at 0.02 A left it flat. Small enough to
 * be a tremble rather than an edit - a twentieth of an Angstrom is 5% of a bond,
 * and it is the structure the user built that the panel compares against.
 */
export const PERTURB_AMPLITUDE = 0.05;

/**
 * How far off a common plane an atom may be for the structure to still count as
 * flat, in Angstrom.
 *
 * A structure built by clicking is flat to the last digit, so any tolerance at
 * all would do for that; this one is wide enough to also catch a structure whose
 * plane is nearly exact - where the force that would break it is small enough
 * for the optimiser to stop before it acts on it. It is about the line the
 * engine draws for a molecular plane when it decides whether a molecule has a pi
 * system (0.06 Bohr, `crates/dft-core/src/bonding.rs`).
 */
export const FLATNESS_TOLERANCE = 0.03;

/**
 * Below this, being in a plane says nothing: any three points are, and so is
 * anything with fewer. The engine draws the same line for the same reason
 * (`MIN_ATOMS_FOR_A_PLANE`, `crates/dft-core/src/bonding.rs`).
 */
export const MIN_ATOMS_FOR_A_PLANE = 4;

type Vec3 = [number, number, number];

/**
 * Whether `xyz` (Angstrom, three per atom) should be nudged before it is
 * relaxed: it is flat, and it is a structure the user built or edited.
 *
 * `handBuilt` is the second half of the rule above, and the caller has to keep
 * it: what a structure is, geometrically, does not say where it came from. It
 * is false for a preset, for a structure opened from the log or from a
 * candidate, and for the structure a relaxation has just produced.
 *
 * That last one is not only about symmetry, it is about time. Relaxing a flat
 * molecule leaves it flat, so pressing 安定な形にする again - which is what
 * measuring a shape that has just been found amounts to - would nudge a
 * structure that is already at the bottom of its valley and make the optimiser
 * walk back down from a hundredth of an Angstrom away. Benzene measured from
 * the shape it settled into takes five steps and three minutes; nudged first it
 * takes eighteen and six (`docs/dev-notes.md`, "v3 の実測").
 */
export function needsNudge(xyz: Float64Array, handBuilt: boolean): boolean {
  return handBuilt && isFlat(xyz);
}

/**
 * Whether every atom of `xyz` (Angstrom, three per atom) lies in one plane.
 *
 * False for a structure with too few atoms to have a plane, and for one whose
 * atoms are in a straight line - a line lies in many planes, and none of them is
 * a symmetry the optimiser could be trapped in.
 */
export function isFlat(xyz: Float64Array): boolean {
  const atoms = atomsOf(xyz);
  if (atoms.length < MIN_ATOMS_FOR_A_PLANE) return false;

  // The widest triangle in the structure, so the plane is the best determined
  // one rather than whichever three atoms happen to come first.
  let [a, b] = [atoms[0], atoms[1]];
  let widest = -1;
  for (let i = 0; i < atoms.length; i++) {
    for (let j = i + 1; j < atoms.length; j++) {
      const span = norm(sub(atoms[j], atoms[i]));
      if (span > widest) [widest, a, b] = [span, atoms[i], atoms[j]];
    }
  }
  if (widest <= 0) return false; // every atom in the same place

  const along = scale(sub(b, a), 1 / widest);
  let apex = atoms[0];
  let offLine = -1;
  for (const atom of atoms) {
    const d = sub(atom, a);
    const off = norm(sub(d, scale(along, dot(d, along))));
    if (off > offLine) [offLine, apex] = [off, atom];
  }
  // A straight line, within the same tolerance: no plane to speak of.
  if (offLine <= FLATNESS_TOLERANCE) return false;

  // Those three atoms give a plane; every atom then has to fit the plane that
  // fits them all, which for a structure that is flat to a hundredth of an
  // Angstrom is not quite the same one.
  const normal = bestFitNormal(atoms, scale(cross(along, sub(apex, a)), 1 / offLine));
  return atoms.every((atom) => Math.abs(dot(sub(atom, a), normal)) <= FLATNESS_TOLERANCE);
}

/**
 * The normal of the plane that fits `atoms` best, starting from `guess`.
 *
 * The direction the atoms are least spread along, which is the eigenvector of
 * the smallest eigenvalue of their covariance `M`. Iterating `trace(M) I - M`
 * turns that into the *largest* eigenvalue, which a few multiplications find:
 * for a structure that is anywhere near flat the two directions in the plane
 * carry all the spread, so each pass halves what is left of the error, and the
 * guess is already close. A structure that is not flat converges to nothing in
 * particular, which only makes the plane fit worse than the guess did and the
 * answer "not flat" surer.
 */
function bestFitNormal(atoms: Vec3[], guess: Vec3): Vec3 {
  const centre = scale(
    atoms.reduce((sum, atom) => [sum[0] + atom[0], sum[1] + atom[1], sum[2] + atom[2]] as Vec3),
    1 / atoms.length,
  );
  const m = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (const atom of atoms) {
    const d = sub(atom, centre);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) m[i][j] += d[i] * d[j];
  }
  const trace = m[0][0] + m[1][1] + m[2][2];
  let v = guess;
  for (let pass = 0; pass < 32; pass++) {
    const next: Vec3 = [0, 0, 0];
    for (let i = 0; i < 3; i++) {
      next[i] = trace * v[i];
      for (let j = 0; j < 3; j++) next[i] -= m[i][j] * v[j];
    }
    const length = norm(next);
    if (length === 0) return v;
    v = scale(next, 1 / length);
  }
  return v;
}

/**
 * `xyz` (Angstrom, three per atom) with every atom moved `amplitude` in a
 * direction drawn from `seed`.
 *
 * Every atom moves exactly as far as every other; only the directions are
 * random, and they are spread evenly over the sphere rather than over a cube, so
 * the nudge has no axis of its own to line up with the molecule's.
 */
export function perturb(xyz: Float64Array, amplitude: number, seed: number): Float64Array {
  const random = randomFrom(seed);
  const out = new Float64Array(xyz.length);
  for (let i = 0; i + 2 < xyz.length; i += 3) {
    // Uniform on the sphere: the height is what is drawn evenly, not the angle.
    const cosTheta = 2 * random() - 1;
    const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta));
    const phi = 2 * Math.PI * random();
    out[i] = xyz[i] + amplitude * sinTheta * Math.cos(phi);
    out[i + 1] = xyz[i + 1] + amplitude * sinTheta * Math.sin(phi);
    out[i + 2] = xyz[i + 2] + amplitude * cosTheta;
  }
  return out;
}

/**
 * A seed for one relaxation's nudge.
 *
 * Pressing the button again nudges differently, which is the point: a structure
 * that stayed on its plane gets a new set of directions to fall in.
 */
export function randomSeed(): number {
  return Math.floor(Math.random() * 0x100000000);
}

/**
 * mulberry32, a small seeded generator, in place of `Math.random` so that a test
 * can say which nudge it is talking about. Nothing here rests on its statistics
 * beyond "evenly spread, and not the same for two atoms in a row".
 */
function randomFrom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
  };
}

function atomsOf(xyz: Float64Array): Vec3[] {
  const atoms: Vec3[] = [];
  for (let i = 0; i + 2 < xyz.length; i += 3) atoms.push([xyz[i], xyz[i + 1], xyz[i + 2]]);
  return atoms;
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

/**
 * Distances, bond angles and dihedral angles between picked atoms, for the
 * observe mode's readout and labels.
 *
 * Pure geometry in Angstrom and degrees: the viewer calls it on every frame an
 * animation draws, and the panel calls it on the structure a relaxation started
 * from, so the two always agree on what the same atoms measure.
 */
import type { SceneAtom } from './viewer';

export type Vec3 = readonly [number, number, number];

/** What two, three or four picked atoms measure. */
export type MeasurementKind = 'distance' | 'angle' | 'dihedral';

export interface Measurement {
  kind: MeasurementKind;
  /**
   * Angstrom for a distance, degrees for the two angles. `null` when the atoms
   * do not define one: two of them on top of each other, or - for a dihedral -
   * three of them in a straight line, where there is no plane to measure from.
   */
  value: number | null;
}

/** The most atoms a measurement uses. Picking one more starts a new one. */
export const MAX_MEASURED = 4;

/**
 * How close to a straight line three atoms may be before the plane through
 * them, and with it a dihedral, is taken to be undefined.
 *
 * Mathematically only an exact line has no plane, but near one the plane is
 * set by how far the end atom sits off the line, and that offset is soon
 * smaller than the precision of a relaxed structure. A linear molecule the
 * optimiser has brought to within a fraction of a degree of straight would
 * otherwise show a dihedral that is noise, and changes wildly with it.
 */
export const COLLINEAR_TOLERANCE_DEGREES = 1;

/** Separations below this (Angstrom) are coincident atoms: no direction between them. */
const COINCIDENT = 1e-6;

/** Digits shown, chosen so the value visibly creeps while a structure relaxes. */
export const DECIMALS: Record<MeasurementKind, number> = {
  distance: 3,
  angle: 1,
  dihedral: 1,
};

export const UNITS: Record<MeasurementKind, string> = {
  distance: ' Å',
  angle: '°',
  dihedral: '°',
};

const DEGREES = 180 / Math.PI;

function sub(a: Vec3, b: Vec3): [number, number, number] {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a: Vec3, b: Vec3): [number, number, number] {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function norm(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}

/** Distance between two points, in their own units. */
export function distance(a: Vec3, b: Vec3): number {
  return norm(sub(a, b));
}

/**
 * The angle a–b–c in degrees, with `b` at the vertex, from 0 to 180.
 * `null` when `a` or `c` sits on `b`.
 */
export function angle(a: Vec3, b: Vec3, c: Vec3): number | null {
  const u = sub(a, b);
  const v = sub(c, b);
  if (norm(u) < COINCIDENT || norm(v) < COINCIDENT) return null;
  // atan2 of the sine and cosine rather than acos of the cosine: acos loses
  // all its digits near 0 and 180 degrees, which is where linear molecules are.
  return Math.atan2(norm(cross(u, v)), dot(u, v)) * DEGREES;
}

/**
 * The dihedral (torsion) angle a–b–c–d in degrees, from −180 (exclusive) to 180.
 *
 * Signed as IUPAC defines it: looking along b→c, the angle is positive when the
 * bond b–a has to turn clockwise to cover c–d. `null` when a–b–c or b–c–d is
 * within {@link COLLINEAR_TOLERANCE_DEGREES} of a straight line, or any two
 * consecutive atoms coincide.
 */
export function dihedral(a: Vec3, b: Vec3, c: Vec3, d: Vec3): number | null {
  const b1 = sub(b, a);
  const b2 = sub(c, b);
  const b3 = sub(d, c);
  const l1 = norm(b1);
  const l2 = norm(b2);
  const l3 = norm(b3);
  if (l1 < COINCIDENT || l2 < COINCIDENT || l3 < COINCIDENT) return null;

  // Normals of the planes a-b-c and b-c-d. Their lengths are l1 l2 sin(abc)
  // and l2 l3 sin(bcd), so a short one is a nearly straight triple.
  const n1 = cross(b1, b2);
  const n2 = cross(b2, b3);
  const minSine = Math.sin(COLLINEAR_TOLERANCE_DEGREES / DEGREES);
  if (norm(n1) < minSine * l1 * l2 || norm(n2) < minSine * l2 * l3) return null;

  // The cosine and sine of the angle between the two planes, both scaled by
  // |n1| |n2|; the sine's sign is what carries the handedness.
  const x = dot(n1, n2);
  const y = l2 * dot(b1, n2);
  const value = Math.atan2(y, x) * DEGREES;
  // atan2 can land on -180 exactly; the IUPAC range is closed at +180.
  return value <= -180 ? 180 : value;
}

/**
 * Measures two, three or four points: a distance, an angle at the second, or
 * the dihedral about the middle two. `null` for any other number of points.
 */
export function measure(points: readonly Vec3[]): Measurement | null {
  switch (points.length) {
    case 2:
      return { kind: 'distance', value: distance(points[0], points[1]) };
    case 3:
      return { kind: 'angle', value: angle(points[0], points[1], points[2]) };
    case 4:
      return { kind: 'dihedral', value: dihedral(points[0], points[1], points[2], points[3]) };
    default:
      return null;
  }
}

/**
 * Where the label for a measurement of these points goes: the middle of a
 * distance, the middle of the bond a dihedral turns about, and for an angle a
 * point `angleOffset` out from the vertex into the angle, so the label sits
 * between the two arms instead of on top of the atom. A straight angle has no
 * inside, so its label goes on the vertex. `null` for any other number of
 * points.
 */
export function measurementAnchor(points: readonly Vec3[], angleOffset: number): Vec3 | null {
  const midpoint = (p: Vec3, q: Vec3): Vec3 => [
    (p[0] + q[0]) / 2,
    (p[1] + q[1]) / 2,
    (p[2] + q[2]) / 2,
  ];
  switch (points.length) {
    case 2:
      return midpoint(points[0], points[1]);
    case 3: {
      const [a, b, c] = points;
      const u = sub(a, b);
      const v = sub(c, b);
      const lu = norm(u);
      const lv = norm(v);
      if (lu < COINCIDENT || lv < COINCIDENT) return b;
      const bisector: Vec3 = [u[0] / lu + v[0] / lv, u[1] / lu + v[1] / lv, u[2] / lu + v[2] / lv];
      const length = norm(bisector);
      // Unit arms that nearly cancel: the angle is all but straight.
      if (length < 1e-6) return b;
      const s = angleOffset / length;
      return [b[0] + bisector[0] * s, b[1] + bisector[1] * s, b[2] + bisector[2] * s];
    }
    case 4:
      return midpoint(points[1], points[2]);
    default:
      return null;
  }
}

/**
 * {@link measure} over atoms picked by index, in the order they were picked.
 * `null` when there are too few or too many, or one of them no longer exists.
 */
export function measureAtoms(
  atoms: readonly SceneAtom[],
  indices: readonly number[],
): Measurement | null {
  if (indices.some((i) => !Number.isInteger(i) || i < 0 || i >= atoms.length)) return null;
  return measure(indices.map((i) => atoms[i].pos));
}

/**
 * The number part of a readout, at the precision its kind is shown with, or
 * `—` when there is nothing to show.
 *
 * Two values that only differ in how they round are written the same way, so a
 * label does not flicker while an animation moves through them: a rounded zero
 * never gets a minus sign, and a dihedral that rounds to −180 is written as the
 * +180 it is the same angle as.
 */
export function formatValue(kind: MeasurementKind, value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  const decimals = DECIMALS[kind];
  const scale = 10 ** decimals;
  let rounded = Math.round(value * scale) / scale;
  if (kind === 'dihedral' && rounded <= -180) rounded = 180;
  if (Object.is(rounded, -0)) rounded = 0;
  return rounded.toFixed(decimals);
}

/** The readout with its unit, e.g. `1.540 Å` or `109.5°`; `—` when undefined. */
export function formatMeasurement(measurement: Measurement): string {
  const number = formatValue(measurement.kind, measurement.value);
  return measurement.value === null ? number : `${number}${UNITS[measurement.kind]}`;
}

/**
 * The picked atoms after clicking atom `index` in observe mode.
 *
 * A picked atom is dropped (the ones after it keep their order); a new one is
 * added at the end. Once four are picked, a fifth starts a new measurement from
 * that atom rather than being refused, so the user never has to clear first.
 */
export function toggleMeasured(current: readonly number[], index: number): number[] {
  if (current.includes(index)) return current.filter((i) => i !== index);
  if (current.length >= MAX_MEASURED) return [index];
  return [...current, index];
}

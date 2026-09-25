/**
 * Which way "along the bond", "across it in the screen" and "across it towards
 * me" point, as vectors (V6-7).
 *
 * A degenerate set of orbitals - an atom's 2p, a diatomic's pi - is drawn one
 * member at a time, turned to point a named way ({@link Along}). The names are
 * about the bond and the screen together, so the vector is only known once both
 * are: the two nuclei, and the camera at the moment the line is pressed. The
 * caller works it out then and keeps it; turning the view afterwards does not
 * turn the orbital, which would redraw it every frame of a drag.
 *
 * Plain vectors in and out, so it is tested without a scene.
 */
import type { Along } from './orbital';

export type Vec3 = [number, number, number];

/**
 * The camera's own axes in the world: `right` and `up` across the screen, and
 * `forward` the way it looks - into the screen, so the viewer is at `-forward`.
 */
export interface CameraAxes {
  right: Vec3;
  up: Vec3;
  forward: Vec3;
}

/**
 * A camera square on to the world, standing in for the viewer's when there is
 * none (no WebGL): right is +x, up is +y, looking down -z.
 */
export const STANDARD_CAMERA: CameraAxes = { right: [1, 0, 0], up: [0, 1, 0], forward: [0, 0, -1] };

/**
 * The vector a pressed line is turned to, or null for a line that is not one
 * of a set (V6-8).
 *
 * Worked out once, from the two atoms on screen and the camera at the moment
 * of the press, and kept with the pick: the surface is cut again at every
 * threshold, and turning the view in between must not turn the orbital. Only a
 * molecule of two atoms has a bond for the names to be about; anything else
 * gets no direction, and the engine draws its own member of the set.
 */
export function pickDirection(
  along: Along | undefined,
  atoms: readonly { pos: Vec3 }[],
  camera: CameraAxes | null,
): Vec3 | null {
  if (along === undefined || atoms.length !== 2) return null;
  return directionOf(along, atoms[0].pos, atoms[1].pos, camera ?? STANDARD_CAMERA);
}

/** Whether two kept directions are the same one, either of them possibly none. */
export function sameDirection(a: Vec3 | null, b: Vec3 | null): boolean {
  if (a === null || b === null) return a === b;
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

/**
 * How short `axis × forward` may get before the bond counts as seen end on.
 *
 * It is a sine: 0.1 is within about 6 degrees of the line of sight. Closer than
 * that, "across the bond, in the screen" is every direction in the screen at
 * once, and the cross product picks one of them by how the last few degrees
 * happen to lean; the screen's own up is what the viewer would call it instead.
 */
const END_ON = 0.1;

/**
 * A unit vector for `along`, from the bond `from` → `to` and the camera.
 *
 * - `axis`: along the bond, from `from` to `to`.
 * - `across`: perpendicular to it, in the plane of the screen (`axis × forward`),
 *   or the screen's up with the bond's part taken out when the bond is seen end
 *   on ({@link END_ON}).
 * - `toward`: perpendicular to both, on the viewer's side; where the bond lies
 *   along the line of sight that side is level with the screen, and the
 *   screen's right decides instead.
 */
export function directionOf(along: Along, from: Vec3, to: Vec3, camera: CameraAxes): Vec3 {
  const axis = unit(sub(to, from)) ?? unit(camera.right) ?? [1, 0, 0];
  if (along === 'axis') return axis;
  const cut = cross(axis, camera.forward);
  const across =
    (norm(cut) >= END_ON ? unit(cut) : null) ??
    unit(sub(camera.up, scale(axis, dot(camera.up, axis)))) ??
    perpendicular(axis);
  if (along === 'across') return across;
  const toward = cross(axis, across);
  const facing = -dot(toward, camera.forward);
  const side = Math.abs(facing) > 1e-9 ? facing : dot(toward, camera.right);
  return side < 0 ? scale(toward, -1) : toward;
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function scale(a: Vec3, by: number): Vec3 {
  return [a[0] * by, a[1] * by, a[2] * by];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function norm(a: Vec3): number {
  return Math.sqrt(dot(a, a));
}

/** `a` scaled to length one, or null where it has no direction. */
function unit(a: Vec3): Vec3 | null {
  const length = norm(a);
  return length > 1e-12 && Number.isFinite(length) ? scale(a, 1 / length) : null;
}

/** Some unit vector perpendicular to `a`: only for a camera whose up is its forward. */
function perpendicular(a: Vec3): Vec3 {
  const other: Vec3 = Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  return unit(cross(a, other)) ?? [0, 1, 0];
}

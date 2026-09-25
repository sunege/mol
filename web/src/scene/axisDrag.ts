/**
 * The arithmetic behind the axis handles: dragging the selected atom along one
 * world axis (X, Y or Z) only.
 *
 * The pointer gives a ray from the camera; the atom may only move on the line
 * through where it started, along the axis. It goes to the point of that line
 * nearest the ray - but by the difference from where the press landed on the
 * line, not to that point itself, so grabbing a handle near its tip does not
 * make the atom jump to the tip.
 *
 * Plain arrays and no three.js, so the viewer's WebGL-free parts can be tested
 * in Node like `gestures.ts`.
 */

export type Vec3 = [number, number, number];

/**
 * Above this `|cos|` between the ray and the axis, the axis is too nearly
 * edge-on to the view: the nearest point runs off towards infinity as the two
 * lines turn parallel, so a small twitch of the pointer would throw the atom
 * across the scene. The atom stays put until the view turns.
 */
export const EDGE_ON_COSINE = 0.995;

/** The handle's length on screen, in CSS pixels. */
export const HANDLE_PIXELS = 60;

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/**
 * Where on the line `point + s·axis` the pointer's ray comes nearest: that `s`,
 * or `null` while the axis points (almost) along the ray.
 *
 * The ray is treated as the whole line: only its direction matters, not its
 * length, and `rayDir` need not be a unit vector. `s` is in units of `axis`
 * (a world axis is a unit vector, so for the handles it is a distance).
 */
export function axisParameter(
  rayOrigin: Vec3,
  rayDir: Vec3,
  point: Vec3,
  axis: Vec3,
): number | null {
  // Minimise |w + s·axis − t·rayDir|² over s and t, with w = point − rayOrigin:
  // both derivatives vanish where the joining segment is square to both lines.
  const w: Vec3 = [point[0] - rayOrigin[0], point[1] - rayOrigin[1], point[2] - rayOrigin[2]];
  const aa = dot(axis, axis);
  const ad = dot(axis, rayDir);
  const dd = dot(rayDir, rayDir);
  if (aa === 0 || dd === 0) return null;
  if (Math.abs(ad) / Math.sqrt(aa * dd) > EDGE_ON_COSINE) return null;
  const aw = dot(axis, w);
  const dw = dot(rayDir, w);
  return (ad * dw - dd * aw) / (aa * dd - ad * ad);
}

/**
 * The atom's position after the pointer has moved the nearest point from `s0`
 * (where the press landed) to `s`. `start` is where the atom was at the press.
 */
export function axisDragPosition(start: Vec3, axis: Vec3, s0: number, s: number): Vec3 {
  const ds = s - s0;
  return [start[0] + ds * axis[0], start[1] + ds * axis[1], start[2] + ds * axis[2]];
}

/**
 * The world length that looks `px` pixels long at `distance` from a
 * perspective camera, so the handles stay one size on screen however far the
 * view is zoomed. `fovDeg` is the vertical field of view (three.js's `fov`).
 */
export function handleLength(
  distance: number,
  fovDeg: number,
  viewportHeightPx: number,
  px = HANDLE_PIXELS,
): number {
  const visibleHeight = 2 * distance * Math.tan((fovDeg * Math.PI) / 360);
  return (visibleHeight * px) / viewportHeightPx;
}

/**
 * Where an ion's + / − mark goes (V7-5): on the rim of the atom's sphere, at
 * its upper right as the camera sees it, like the badge on an app icon. Half
 * of the mark covers the sphere and half sticks out, so it reads as belonging
 * to that atom and not to a neighbour.
 *
 * The directions are the camera's, not the world's, so the mark stays at the
 * upper right however the molecule is turned. That means placing it again
 * whenever the camera moves, which the viewer does every frame.
 *
 * Plain arrays and no three.js, so it can be tested in Node like `axisDrag.ts`.
 */

import type { Vec3 } from './axisDrag';

/**
 * The mark's centre for an atom at `center` drawn with `radius`, given the
 * camera's unit right and up vectors: the point of the sphere's outline at 45°
 * between the two.
 */
export function badgeAnchor(center: Vec3, radius: number, right: Vec3, up: Vec3): Vec3 {
  const reach = radius / Math.SQRT2;
  return [
    center[0] + reach * (right[0] + up[0]),
    center[1] + reach * (right[1] + up[1]),
    center[2] + reach * (right[2] + up[2]),
  ];
}

import { describe, expect, it } from 'vitest';
import {
  STANDARD_CAMERA,
  directionOf,
  pickDirection,
  sameDirection,
  type CameraAxes,
  type Vec3,
} from './orient';

/** A camera square on to the world: x to the right, y up, looking down -z. */
const STANDARD: CameraAxes = STANDARD_CAMERA;

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const length = (a: Vec3) => Math.sqrt(dot(a, a));

function expectVec(actual: Vec3, expected: Vec3) {
  actual.forEach((value, k) => expect(value).toBeCloseTo(expected[k], 12));
}

describe('which way a named direction points', () => {
  it('reads a bond across the screen as the textbook draws it', () => {
    const from: Vec3 = [-1, 0, 0];
    const to: Vec3 = [1.2, 0, 0];
    expectVec(directionOf('axis', from, to, STANDARD), [1, 0, 0]);
    // x × (−z) = +y: up the screen.
    expectVec(directionOf('across', from, to, STANDARD), [0, 1, 0]);
    // Out of the screen, at the viewer.
    expectVec(directionOf('toward', from, to, STANDARD), [0, 0, 1]);
  });

  it('points along the bond from the first atom to the second', () => {
    expectVec(directionOf('axis', [0, 2, 0], [0, 0, 0], STANDARD), [0, -1, 0]);
  });

  it('takes the screen’s up for a bond seen end on', () => {
    const from: Vec3 = [0, 0, 0];
    const to: Vec3 = [0, 0, 1];
    expectVec(directionOf('across', from, to, STANDARD), [0, 1, 0]);
    // And the one left over is level with the screen, so its right decides.
    expectVec(directionOf('toward', from, to, STANDARD), [1, 0, 0]);
    // Nearly end on is still end on: the cross product would lean by noise.
    const tilted: Vec3 = [0.02, 0, 1];
    const across = directionOf('across', from, tilted, STANDARD);
    expect(across[1]).toBeGreaterThan(0.99);
  });

  it('gives three unit vectors at right angles for any bond and camera', () => {
    const turned: CameraAxes = {
      right: [Math.SQRT1_2, 0, -Math.SQRT1_2],
      up: [0, 1, 0],
      forward: [-Math.SQRT1_2, 0, -Math.SQRT1_2],
    };
    const bonds: Array<[Vec3, Vec3]> = [
      [
        [0.3, -0.2, 0.5],
        [1.1, 0.9, -0.4],
      ],
      [
        [0, 0, 0],
        [-0.5, 2, 0.3],
      ],
    ];
    for (const camera of [STANDARD, turned]) {
      for (const [from, to] of bonds) {
        const axis = directionOf('axis', from, to, camera);
        const across = directionOf('across', from, to, camera);
        const toward = directionOf('toward', from, to, camera);
        for (const v of [axis, across, toward]) expect(length(v)).toBeCloseTo(1, 12);
        expect(dot(axis, across)).toBeCloseTo(0, 12);
        expect(dot(axis, toward)).toBeCloseTo(0, 12);
        expect(dot(across, toward)).toBeCloseTo(0, 12);
        // In the plane of the screen, and on the viewer's side.
        expect(dot(across, camera.forward)).toBeCloseTo(0, 12);
        expect(-dot(toward, camera.forward)).toBeGreaterThan(0);
      }
    }
  });
});

describe('the direction a pressed line is kept with', () => {
  const pair = [{ pos: [0, 0, 0] as Vec3 }, { pos: [0, 0, 1.2] as Vec3 }];
  // Looking down the x axis from +x, with y up: the bond (along z) lies across
  // the screen, and the viewer is on the +x side.
  const side: CameraAxes = { right: [0, 0, -1], up: [0, 1, 0], forward: [-1, 0, 0] };

  it('is none for a line that is not one of a set', () => {
    expect(pickDirection(undefined, pair, side)).toBeNull();
  });

  it('is none unless exactly two atoms are on screen', () => {
    const three = [...pair, { pos: [1, 0, 0] as Vec3 }];
    expect(pickDirection('axis', three, side)).toBeNull();
    expect(pickDirection('axis', pair.slice(0, 1), side)).toBeNull();
  });

  it('turns to the camera it is given', () => {
    expectVec(pickDirection('axis', pair, side)!, [0, 0, 1]);
    expectVec(pickDirection('toward', pair, side)!, [1, 0, 0]);
    const across = pickDirection('across', pair, side)!;
    expect(Math.abs(dot(across, [0, 1, 0]))).toBeCloseTo(1, 12);
  });

  it('falls back to a camera square on to the world when there is no viewer', () => {
    expectVec(pickDirection('toward', pair, null)!, directionOf('toward', pair[0].pos, pair[1].pos, STANDARD));
    // The bond is seen end on from there, and the answer is still a direction.
    expect(length(pickDirection('toward', pair, null)!)).toBeCloseTo(1, 12);
  });
});

describe('whether a line pressed again points another way', () => {
  it('compares the vectors, and none only with none', () => {
    expect(sameDirection(null, null)).toBe(true);
    expect(sameDirection([0, 0, 1], null)).toBe(false);
    expect(sameDirection(null, [0, 0, 1])).toBe(false);
    expect(sameDirection([0, 0, 1], [0, 0, 1])).toBe(true);
    expect(sameDirection([0, 0, 1], [0, 1, 0])).toBe(false);
  });
});

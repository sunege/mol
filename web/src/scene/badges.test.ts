import { describe, expect, it } from 'vitest';
import type { Vec3 } from './axisDrag';
import { badgeAnchor } from './badges';

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

describe('badgeAnchor', () => {
  it('puts the mark on the outline, equally right and up', () => {
    const center: Vec3 = [1, -2, 0.5];
    const offset = sub(badgeAnchor(center, 0.4, [1, 0, 0], [0, 1, 0]), center);
    expect(Math.hypot(...offset)).toBeCloseTo(0.4, 12);
    expect(offset[0]).toBeCloseTo(offset[1], 12);
    expect(offset[0]).toBeGreaterThan(0);
    expect(offset[2]).toBe(0);
  });

  it("follows the camera's axes, not the world's", () => {
    // Looking down the world X axis from +X: right is -Z, up is +Y.
    const right: Vec3 = [0, 0, -1];
    const up: Vec3 = [0, 1, 0];
    const forward: Vec3 = [-1, 0, 0];
    const center: Vec3 = [0, 0, 0];
    const offset = sub(badgeAnchor(center, 0.5, right, up), center);
    // Across the view, so the same distance from the atom on screen however
    // far the camera is.
    expect(dot(offset, forward)).toBeCloseTo(0, 12);
    expect(dot(offset, right)).toBeCloseTo(0.5 / Math.SQRT2, 12);
    expect(dot(offset, up)).toBeCloseTo(0.5 / Math.SQRT2, 12);
  });
});

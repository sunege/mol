import { describe, expect, it } from 'vitest';
import { axisDragPosition, axisParameter, handleLength, type Vec3 } from './axisDrag';

const X: Vec3 = [1, 0, 0];
const Y: Vec3 = [0, 1, 0];
const Z: Vec3 = [0, 0, 1];
const ORIGIN: Vec3 = [0, 0, 0];

function along(p: Vec3, d: Vec3, t: number): Vec3 {
  return [p[0] + t * d[0], p[1] + t * d[1], p[2] + t * d[2]];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function minus(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

describe('axisParameter', () => {
  it('lands where the ray crosses the axis', () => {
    // The axis through (1, 2, 3) along y; a ray straight down the z axis at
    // x = 1, y = 5 goes through (1, 5, 3), three along from the start.
    expect(axisParameter([1, 5, 10], [0, 0, -1], [1, 2, 3], Y)).toBeCloseTo(3, 12);
    // A diagonal axis: the ray down onto (3, 3, 0) crosses it 3√2 from the origin.
    const diagonal: Vec3 = [Math.SQRT1_2, Math.SQRT1_2, 0];
    expect(axisParameter([3, 3, 4], [0, 0, -1], ORIGIN, diagonal)).toBeCloseTo(3 * Math.SQRT2, 12);
  });

  it('takes the nearest point when the ray passes the axis by', () => {
    // Straight down from (2, 1, 5) misses the x axis by 1 in y, above x = 2.
    expect(axisParameter([2, 1, 5], [0, 0, -1], ORIGIN, X)).toBeCloseTo(2, 12);
  });

  it('gives the point where the joining segment is square to both lines', () => {
    const origin: Vec3 = [4, -3, 7];
    const dir: Vec3 = [-0.3, 0.5, -1];
    const point: Vec3 = [0.5, 1, -2];
    const s = axisParameter(origin, dir, point, Z);
    expect(s).not.toBeNull();
    const onAxis = along(point, Z, s!);
    // The ray's own nearest point to that one, found from the ray's side.
    const t = dot(minus(onAxis, origin), dir) / dot(dir, dir);
    const joining = minus(along(origin, dir, t), onAxis);
    expect(dot(joining, Z)).toBeCloseTo(0, 12);
    expect(dot(joining, dir)).toBeCloseTo(0, 12);
  });

  it('does not care how long the ray direction is', () => {
    const origin: Vec3 = [1, 2, 3];
    const dir: Vec3 = [0.2, -0.4, -1];
    const long: Vec3 = [dir[0] * 7, dir[1] * 7, dir[2] * 7];
    expect(axisParameter(origin, long, ORIGIN, X)).toBeCloseTo(axisParameter(origin, dir, ORIGIN, X)!, 12);
  });

  it('refuses while the axis points along the view, either way round', () => {
    expect(axisParameter([0, 0, 10], [0, 0, -1], ORIGIN, Z)).toBeNull();
    expect(axisParameter([0, 0, -10], [0, 0, 1], ORIGIN, Z)).toBeNull();
    // cos = 1/√1.0025 ≈ 0.9988: still edge-on.
    expect(axisParameter([1, 0, 10], [0.05, 0, -1], ORIGIN, Z)).toBeNull();
    // cos = 1/√1.0121 ≈ 0.9940: steep, but the atom can follow.
    expect(axisParameter([1, 0, 10], [0.11, 0, -1], ORIGIN, Z)).not.toBeNull();
  });

  it('refuses a zero direction', () => {
    expect(axisParameter([1, 1, 1], [0, 0, 0], ORIGIN, X)).toBeNull();
    expect(axisParameter([1, 1, 1], [0, 0, -1], ORIGIN, [0, 0, 0])).toBeNull();
  });
});

describe('axisDragPosition', () => {
  it('moves the atom by how far the nearest point moved, not to it', () => {
    const start: Vec3 = [1, -2, 0.5];
    expect(axisDragPosition(start, Y, 3, 3)).toEqual(start);
    const moved = axisDragPosition(start, Y, 3, 4.25);
    expect(moved[0]).toBeCloseTo(1, 12);
    expect(moved[1]).toBeCloseTo(-0.75, 12);
    expect(moved[2]).toBeCloseTo(0.5, 12);
    const back = axisDragPosition(start, X, 0.5, -1);
    expect(back[0]).toBeCloseTo(-0.5, 12);
    expect(back[1]).toBeCloseTo(-2, 12);
  });

  it('follows the pointer: a press off the atom does not make it jump', () => {
    // The atom at (2, 0, 0); the press lands on the x handle's tip at x = 2.6.
    const start: Vec3 = [2, 0, 0];
    const s0 = axisParameter([2.6, 0.3, 8], [0, 0, -1], start, X)!;
    expect(s0).toBeCloseTo(0.6, 12);
    // The pointer moves 1 to the right: so does the atom, from where it was.
    const s = axisParameter([3.6, 0.3, 8], [0, 0, -1], start, X)!;
    const moved = axisDragPosition(start, X, s0, s);
    expect(moved[0]).toBeCloseTo(3, 12);
    expect(moved[1]).toBe(0);
    expect(moved[2]).toBe(0);
  });
});

describe('handleLength', () => {
  it('is 60 px worth of the view at that distance', () => {
    // A 90° view is 2·10 tall at distance 10; 60 of 600 px is a tenth of it.
    expect(handleLength(10, 90, 600)).toBeCloseTo(2, 12);
    expect(handleLength(10, 90, 600, 30)).toBeCloseTo(1, 12);
  });

  it('grows with the distance, so it keeps its size on screen', () => {
    const near = handleLength(4, 50, 800);
    expect(handleLength(8, 50, 800)).toBeCloseTo(2 * near, 12);
    expect(handleLength(12, 50, 800)).toBeCloseTo(3 * near, 12);
    // A taller viewport shows the same length in more pixels.
    expect(handleLength(4, 50, 1600)).toBeCloseTo(near / 2, 12);
  });
});

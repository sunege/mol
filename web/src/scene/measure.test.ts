import { describe, expect, it } from 'vitest';
import {
  COLLINEAR_TOLERANCE_DEGREES,
  MAX_MEASURED,
  angle,
  dihedral,
  distance,
  formatMeasurement,
  formatValue,
  measure,
  measureAtoms,
  measurementAnchor,
  toggleMeasured,
  type Vec3,
} from './measure';

// Every expected value here is built, not remembered: the points are placed by
// rotating vectors through known angles, so the angle that comes back has to be
// the one that went in. The rotations are done with Rodrigues' formula written
// out below, independently of the cross products `measure.ts` uses.

type V = [number, number, number];

const add = (a: Vec3, b: Vec3): V => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: Vec3, s: number): V => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (a: Vec3): V => scale(a, 1 / Math.hypot(...a));
const rad = (degrees: number) => (degrees * Math.PI) / 180;

/** Rotates `v` by `degrees` about the unit axis `k`, right-handed. */
function rotate(v: Vec3, k: Vec3, degrees: number): V {
  const t = rad(degrees);
  const [kx, ky, kz] = k;
  const kxv: V = [ky * v[2] - kz * v[1], kz * v[0] - kx * v[2], kx * v[1] - ky * v[0]];
  return add(add(scale(v, Math.cos(t)), scale(kxv, Math.sin(t))), scale(k, dot(k, v) * (1 - Math.cos(t))));
}

/** Small deterministic generator, so a failure names the same case every run. */
function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A rigid motion drawn at random: the test geometries are built along the axes,
 * where a sign error could hide behind a zero component, and then moved
 * somewhere arbitrary.
 */
function randomPlacement(next: () => number): (p: Vec3) => V {
  const axis = unit([next() - 0.5, next() - 0.5, next() - 0.5]);
  const turn = 360 * next();
  const shift: V = [10 * next() - 5, 10 * next() - 5, 10 * next() - 5];
  return (p) => add(rotate(p, axis, turn), shift);
}

/**
 * Four points whose dihedral is `phi` by construction: b at the origin, c up
 * the z axis, a leaning off along x, and d leaning off the same way but turned
 * by `phi` about b→c (right-handed, i.e. counterclockwise seen from the tip of
 * the axis). The bond angles at b and c are `alpha` and `beta`.
 */
function torsion(phi: number, alpha = 110, beta = 105): [V, V, V, V] {
  const z: V = [0, 0, 1];
  const b: V = [0, 0, 0];
  const c: V = [0, 0, 1.5];
  // b→a makes `alpha` with b→c; c→d makes `beta` with c→b.
  const a = rotate(scale(z, 1.1), [0, 1, 0], alpha);
  const d = add(c, rotate(rotate(scale(z, -1.0), [0, 1, 0], -beta), z, phi));
  return [a, b, c, d];
}

/**
 * The dihedral read off a Newman projection, following the IUPAC wording
 * directly: stand at b, look towards c, and see how far - and which way round
 * on the screen - the front bond b–a has to turn to cover the back bond c–d.
 * Clockwise is positive.
 *
 * The screen has x to the right and y up, as seen by that viewer, so on it a
 * positive 2-D cross product is counterclockwise.
 */
function newmanAngle(a: Vec3, b: Vec3, c: Vec3, d: Vec3): number {
  const forward = unit(add(c, scale(b, -1)));
  const helper: V = Math.abs(forward[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const up = unit(add(helper, scale(forward, -dot(helper, forward))));
  // A viewer looking along `forward` with `up` overhead has this on the right.
  const right: V = [
    forward[1] * up[2] - forward[2] * up[1],
    forward[2] * up[0] - forward[0] * up[2],
    forward[0] * up[1] - forward[1] * up[0],
  ];
  const front = add(a, scale(b, -1));
  const back = add(d, scale(c, -1));
  const f = [dot(front, right), dot(front, up)];
  const k = [dot(back, right), dot(back, up)];
  const counterclockwise = Math.atan2(f[0] * k[1] - f[1] * k[0], f[0] * k[0] + f[1] * k[1]);
  return (-counterclockwise * 180) / Math.PI;
}

describe('distance', () => {
  it('is the length that was laid off between the points', () => {
    const next = random(1);
    for (let n = 0; n < 20; n++) {
      const from: V = [4 * next() - 2, 4 * next() - 2, 4 * next() - 2];
      const direction = unit([next() - 0.5, next() - 0.5, next() - 0.5]);
      const length = 0.5 + 2 * next();
      expect(distance(from, add(from, scale(direction, length)))).toBeCloseTo(length, 12);
    }
  });
});

describe('angle', () => {
  it('is the angle one arm was turned through, at the middle point', () => {
    const next = random(2);
    for (const theta of [0.3, 30, 60, 90, 104.5, 109.4712206, 120, 150, 179.7]) {
      const place = randomPlacement(next);
      const arm: V = [1.2, 0, 0];
      const a = place(arm);
      const b = place([0, 0, 0]);
      // A shorter second arm: the angle must not depend on the lengths.
      const c = place(scale(rotate(arm, [0, 0, 1], theta), 0.7));
      expect(angle(a, b, c)).toBeCloseTo(theta, 9);
      expect(angle(c, b, a)).toBeCloseTo(theta, 9);
    }
  });

  it('puts the vertex at the second point', () => {
    // A right isosceles triangle: 90 degrees at the corner, 45 at the others.
    const corner: V = [0, 0, 0];
    const p: V = [1, 0, 0];
    const q: V = [0, 1, 0];
    expect(angle(p, corner, q)).toBeCloseTo(90, 12);
    expect(angle(corner, p, q)).toBeCloseTo(45, 12);
  });

  it('is exact for a straight line, where it is defined', () => {
    expect(angle([-1, 0, 0], [0, 0, 0], [2, 0, 0])).toBeCloseTo(180, 12);
    expect(angle([1, 0, 0], [0, 0, 0], [2, 0, 0])).toBeCloseTo(0, 12);
  });

  it('is undefined when an end sits on the vertex', () => {
    expect(angle([0, 0, 0], [0, 0, 0], [1, 0, 0])).toBeNull();
    expect(angle([1, 0, 0], [0, 0, 0], [0, 0, 0])).toBeNull();
  });
});

describe('dihedral', () => {
  it('is the angle the back bond was turned through, over the whole range', () => {
    const next = random(3);
    for (let phi = -179; phi <= 180; phi += 7) {
      const place = randomPlacement(next);
      const points = torsion(phi).map(place) as [V, V, V, V];
      expect(dihedral(...points)).toBeCloseTo(phi, 8);
    }
  });

  it('does not depend on the bond angles or lengths', () => {
    const next = random(4);
    for (const [alpha, beta] of [
      [95, 170],
      [60, 60],
      [120, 150],
      [175, 5],
    ]) {
      const place = randomPlacement(next);
      const points = torsion(-63, alpha, beta).map(place) as [V, V, V, V];
      expect(dihedral(...points)).toBeCloseTo(-63, 8);
    }
  });

  it('is positive when the front bond turns clockwise to cover the back one', () => {
    // The sign convention, checked against a Newman projection built from the
    // definition rather than against the construction above.
    const next = random(5);
    for (let n = 0; n < 50; n++) {
      const points: V[] = Array.from({ length: 4 }, () => [
        3 * next(),
        3 * next(),
        3 * next(),
      ]);
      const value = dihedral(points[0], points[1], points[2], points[3]);
      if (value === null) continue;
      expect(value).toBeCloseTo(newmanAngle(points[0], points[1], points[2], points[3]), 8);
    }
    // And for the constructed ones: a right-handed turn about b→c is clockwise
    // to someone looking along b→c, so it is the positive direction.
    const [a, b, c, d] = torsion(60);
    expect(newmanAngle(a, b, c, d)).toBeCloseTo(60, 8);
    expect(dihedral(a, b, c, d)).toBeGreaterThan(0);
  });

  it('reads the same from either end, and flips sign in a mirror', () => {
    const next = random(6);
    for (let phi = -170; phi <= 170; phi += 34) {
      const [a, b, c, d] = torsion(phi).map(randomPlacement(next));
      expect(dihedral(d, c, b, a)).toBeCloseTo(phi, 8);
      const mirror = (p: V): V => [-p[0], p[1], p[2]];
      expect(dihedral(mirror(a), mirror(b), mirror(c), mirror(d))).toBeCloseTo(-phi, 8);
    }
  });

  it('gives eclipsed as 0 and anti as +180, never -180', () => {
    expect(dihedral(...torsion(0))).toBeCloseTo(0, 10);
    const anti = torsion(180);
    expect(dihedral(...anti)).toBeCloseTo(180, 10);
    // Nudged either way across 180: one side is just under +180, the other
    // just above -180.
    expect(dihedral(...torsion(179.9))).toBeCloseTo(179.9, 8);
    expect(dihedral(...torsion(-179.9))).toBeCloseTo(-179.9, 8);
    // An exactly anti arrangement whose signed zeros make atan2 see (-0, -1),
    // which it answers with -180.
    expect(dihedral([1, 0, 0], [0, 0, -0], [0, 0, 1], [-1, 0, 1])).toBe(180);
  });

  it('is undefined when three consecutive atoms are in a line', () => {
    // A straight a-b-c: no plane through them to turn.
    expect(dihedral(...torsion(40, 180, 100))).toBeNull();
    expect(dihedral(...torsion(40, 0, 100))).toBeNull();
    // A straight b-c-d.
    expect(dihedral(...torsion(40, 100, 180))).toBeNull();
  });

  it('treats a triple within the tolerance of straight as straight', () => {
    const inside = 180 - COLLINEAR_TOLERANCE_DEGREES / 2;
    const outside = 180 - COLLINEAR_TOLERANCE_DEGREES * 2;
    expect(dihedral(...torsion(40, inside, 100))).toBeNull();
    expect(dihedral(...torsion(40, 100, inside))).toBeNull();
    expect(dihedral(...torsion(40, outside, 100))).toBeCloseTo(40, 8);
    expect(dihedral(...torsion(40, 100, outside))).toBeCloseTo(40, 8);
  });

  it('is undefined when consecutive atoms coincide', () => {
    const [a, b, c, d] = torsion(30);
    expect(dihedral(b, b, c, d)).toBeNull();
    expect(dihedral(a, b, b, d)).toBeNull();
    expect(dihedral(a, b, c, c)).toBeNull();
  });
});

describe('measure', () => {
  it('measures whatever the number of points calls for', () => {
    const [a, b, c, d] = torsion(-75, 100, 115);
    expect(measure([a, b])).toEqual({ kind: 'distance', value: distance(a, b) });
    expect(measure([a, b, c])).toEqual({ kind: 'angle', value: angle(a, b, c) });
    expect(measure([a, b, c, d])).toEqual({ kind: 'dihedral', value: dihedral(a, b, c, d) });
    expect(measure([])).toBeNull();
    expect(measure([a])).toBeNull();
    expect(measure([a, b, c, d, a])).toBeNull();
  });

  it('measures atoms in the order they were picked', () => {
    const [a, b, c] = torsion(0, 70);
    const atoms = [a, b, c].map((pos) => ({ z: 6, pos }));
    expect(measureAtoms(atoms, [0, 1, 2])?.value).toBeCloseTo(70, 9);
    // The vertex is whichever atom was picked second.
    expect(measureAtoms(atoms, [1, 0, 2])?.value).toBeCloseTo(angle(b, a, c)!, 12);
  });

  it('measures nothing once a picked atom is gone', () => {
    const atoms = [
      { z: 1, pos: [0, 0, 0] as V },
      { z: 1, pos: [0, 0, 0.74] as V },
    ];
    expect(measureAtoms(atoms, [0, 2])).toBeNull();
    expect(measureAtoms(atoms, [-1, 0])).toBeNull();
    expect(measureAtoms(atoms, [0])).toBeNull();
    expect(measureAtoms(atoms, [0, 1])?.value).toBeCloseTo(0.74, 12);
  });
});

describe('measurementAnchor', () => {
  it('labels a distance at its middle and a dihedral at its middle bond', () => {
    const [a, b, c, d] = torsion(50);
    const mid = (p: V, q: V): V => scale(add(p, q), 0.5);
    for (const [got, want] of [
      [measurementAnchor([a, b], 0.5)!, mid(a, b)],
      [measurementAnchor([a, b, c, d], 0.5)!, mid(b, c)],
    ]) {
      for (let k = 0; k < 3; k++) expect(got[k]).toBeCloseTo(want[k], 12);
    }
  });

  it('labels an angle inside it, on the bisector, at the given distance', () => {
    const next = random(7);
    for (const theta of [40, 90, 109.5, 170]) {
      const place = randomPlacement(next);
      const vertex = place([0, 0, 0]);
      const arm: V = [1.1, 0, 0];
      const a = place(arm);
      // Arms of different lengths: the label must still split the angle evenly.
      const c = place(scale(rotate(arm, [0, 0, 1], theta), 1.8));
      const anchor = measurementAnchor([a, vertex, c], 0.6)!;
      expect(distance(anchor, vertex)).toBeCloseTo(0.6, 12);
      expect(angle(a, vertex, anchor)).toBeCloseTo(theta / 2, 9);
      expect(angle(anchor, vertex, c)).toBeCloseTo(theta / 2, 9);
    }
  });

  it('puts the label of a straight angle on the vertex', () => {
    const vertex: V = [1, 2, 3];
    expect(measurementAnchor([[0, 2, 3], vertex, [2.5, 2, 3]], 0.6)).toEqual(vertex);
  });

  it('has no anchor for other numbers of points', () => {
    expect(measurementAnchor([], 0.5)).toBeNull();
    expect(measurementAnchor([[0, 0, 0]], 0.5)).toBeNull();
  });
});

describe('formatting', () => {
  it('shows distances to 3 places and angles to 1, with units', () => {
    expect(formatMeasurement({ kind: 'distance', value: 1.5396 })).toBe('1.540 Å');
    expect(formatMeasurement({ kind: 'angle', value: 109.4712 })).toBe('109.5°');
    expect(formatMeasurement({ kind: 'dihedral', value: -60.04 })).toBe('-60.0°');
  });

  it('shows an undefined value as a dash, without a unit', () => {
    expect(formatMeasurement({ kind: 'dihedral', value: null })).toBe('—');
    expect(formatValue('angle', null)).toBe('—');
    expect(formatValue('distance', Number.NaN)).toBe('—');
  });

  it('never writes -0 or -180, so a label does not flicker between spellings', () => {
    expect(formatValue('dihedral', -0.04)).toBe('0.0');
    expect(formatValue('dihedral', 0.04)).toBe('0.0');
    expect(formatValue('distance', -0.0001)).toBe('0.000');
    expect(formatValue('dihedral', -179.97)).toBe('180.0');
    expect(formatValue('dihedral', 179.97)).toBe('180.0');
    expect(formatValue('dihedral', -179.94)).toBe('-179.9');
  });
});

describe('toggleMeasured', () => {
  it('adds atoms in order, up to four', () => {
    let picked: number[] = [];
    for (const index of [5, 2, 7, 0]) picked = toggleMeasured(picked, index);
    expect(picked).toEqual([5, 2, 7, 0]);
    expect(picked).toHaveLength(MAX_MEASURED);
  });

  it('drops an atom clicked again, keeping the order of the rest', () => {
    expect(toggleMeasured([5, 2, 7], 2)).toEqual([5, 7]);
    expect(toggleMeasured([5], 5)).toEqual([]);
  });

  it('starts a new measurement from a fifth atom', () => {
    expect(toggleMeasured([5, 2, 7, 0], 3)).toEqual([3]);
    // Clicking one of the four still drops it rather than starting over.
    expect(toggleMeasured([5, 2, 7, 0], 7)).toEqual([5, 2, 0]);
  });

  it('does not modify the list it was given', () => {
    const picked = [1, 2];
    toggleMeasured(picked, 3);
    toggleMeasured(picked, 1);
    expect(picked).toEqual([1, 2]);
  });
});

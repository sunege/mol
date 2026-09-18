/**
 * The animation a calculation that will not converge turns into.
 *
 * Requirement F5 says a molecule the engine cannot solve must not produce an
 * error message. It produces this instead: the atoms fly apart, and then the
 * structure the user built comes back. That is not a cosmetic choice dressed up
 * as physics - it is what a diverging self-consistent field is telling you.
 * There is no bound arrangement of electrons for these nuclei in these places,
 * so the picture of nuclei flying away from each other is the honest one, and it
 * says "try putting them somewhere else" without a single word of chemistry.
 *
 * The frames are keyframes, not screen frames: {@link FramePlayer} interpolates
 * between them, so the count here sets the shape of the motion and not its
 * smoothness. Phase 5 feeds the same player with the steps of a geometry
 * optimisation, which is why this produces a list of positions rather than
 * driving the scene itself.
 */

/** One keyframe: `[x0, y0, z0, x1, ...]` in Angstrom, as the scene wants it. */
export type Frame = Float32Array;

export interface DivergenceOptions {
  /** Keyframes spent flying apart. */
  scatterFrames?: number;
  /** Keyframes spent coming back. */
  returnFrames?: number;
  /**
   * How far the atoms travel at the peak, as a multiple of the molecule's own
   * radius. Large enough to leave the frame, which is the point.
   */
  spread?: number;
  /**
   * How far each atom is turned about the centre at the peak, in radians. Zero
   * would make the whole thing a uniform zoom, which reads as the camera pulling
   * back rather than as the molecule coming apart.
   */
  tumble?: number;
}

const DEFAULTS: Required<DivergenceOptions> = {
  scatterFrames: 22,
  returnFrames: 14,
  spread: 4.5,
  tumble: 0.9,
};

/**
 * The smallest radius used to scale the motion, in Angstrom.
 *
 * A single atom, or a molecule whose atoms all sit near its centre, has no
 * radius worth multiplying; without a floor its explosion would be invisible.
 */
const MINIMUM_RADIUS = 1.2;

/**
 * Keyframes for a molecule coming apart and reassembling.
 *
 * Deterministic: the same geometry always produces the same animation, so what
 * the user sees can be reproduced from the structure alone.
 */
export function divergenceFrames(
  positions: ArrayLike<number>,
  options: DivergenceOptions = {},
): Frame[] {
  const { scatterFrames, returnFrames, spread, tumble } = { ...DEFAULTS, ...options };
  const count = Math.floor(positions.length / 3);
  if (count === 0) return [];

  const centre = centroid(positions, count);
  // Directions are fixed once, from the starting geometry, so every atom flies
  // straight out along its own radius instead of curving as the centre moves.
  const outward: [number, number, number][] = [];
  let radius = 0;
  for (let i = 0; i < count; i++) {
    const d: [number, number, number] = [
      positions[3 * i] - centre[0],
      positions[3 * i + 1] - centre[1],
      positions[3 * i + 2] - centre[2],
    ];
    const length = Math.hypot(d[0], d[1], d[2]);
    radius = Math.max(radius, length);
    outward.push(length > 1e-6 ? [d[0] / length, d[1] / length, d[2] / length] : fallbackDirection(i));
  }
  const distance = Math.max(radius, MINIMUM_RADIUS) * spread;

  const frames: Frame[] = [];
  // Flying apart accelerates: displacement goes as t^2, which is what constant
  // outward force looks like and what makes the motion read as a divergence
  // rather than a drift.
  for (let step = 0; step <= scatterFrames; step++) {
    const t = step / scatterFrames;
    frames.push(frameAt(positions, count, centre, outward, distance * t * t, tumble * t * t));
  }
  // Coming back eases in and out, so the reversal at the top has no kink in it
  // and the molecule settles rather than snapping into place.
  for (let step = 1; step <= returnFrames; step++) {
    const t = step / returnFrames;
    const remaining = 1 - smoothstep(t);
    frames.push(frameAt(positions, count, centre, outward, distance * remaining, tumble * remaining));
  }
  return frames;
}

/** The total duration of a keyframe list at a given frame interval. */
export function totalDurationMs(frames: Frame[], frameMs: number): number {
  return Math.max(0, frames.length - 1) * frameMs;
}

function frameAt(
  positions: ArrayLike<number>,
  count: number,
  centre: [number, number, number],
  outward: [number, number, number][],
  distance: number,
  tumble: number,
): Frame {
  const frame = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    // Each atom turns by its own multiple of the angle, so the cloud shears
    // apart instead of rotating as one rigid body.
    const angle = tumble * (1 + (i % 3) * 0.5) * (i % 2 === 0 ? 1 : -1);
    const [x, y, z] = rotateAboutY(
      positions[3 * i] - centre[0],
      positions[3 * i + 1] - centre[1],
      positions[3 * i + 2] - centre[2],
      angle,
    );
    frame[3 * i] = centre[0] + x + outward[i][0] * distance;
    frame[3 * i + 1] = centre[1] + y + outward[i][1] * distance;
    frame[3 * i + 2] = centre[2] + z + outward[i][2] * distance;
  }
  return frame;
}

function centroid(positions: ArrayLike<number>, count: number): [number, number, number] {
  const centre: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < count; i++) {
    centre[0] += positions[3 * i];
    centre[1] += positions[3 * i + 1];
    centre[2] += positions[3 * i + 2];
  }
  return [centre[0] / count, centre[1] / count, centre[2] / count];
}

/** Where an atom sitting exactly on the centre flies off to. */
function fallbackDirection(index: number): [number, number, number] {
  // A golden-ratio sequence over the sphere: deterministic, needs no knowledge
  // of how many atoms there are, and gives no two of them the same direction.
  const conjugate = 0.618_033_988_749_895;
  const y = 2 * (((index + 0.5) * conjugate) % 1) - 1;
  const r = Math.sqrt(Math.max(0, 1 - y * y));
  const theta = Math.PI * (3 - Math.sqrt(5)) * index;
  return [Math.cos(theta) * r, y, Math.sin(theta) * r];
}

function rotateAboutY(
  x: number,
  y: number,
  z: number,
  angle: number,
): [number, number, number] {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [c * x + s * z, y, -s * x + c * z];
}

/** Smooth start and smooth stop: zero slope at both ends. */
function smoothstep(t: number): number {
  const clamped = Math.min(1, Math.max(0, t));
  return clamped * clamped * (3 - 2 * clamped);
}

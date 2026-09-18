import { describe, expect, it } from 'vitest';
import { divergenceFrames } from './divergence';
import { PRESETS, toWorkerArrays } from '../molecules/presets';

/** Distance of each atom from the centroid of a frame. */
function radii(frame: Float32Array): number[] {
  const count = frame.length / 3;
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (let i = 0; i < count; i++) {
    cx += frame[3 * i] / count;
    cy += frame[3 * i + 1] / count;
    cz += frame[3 * i + 2] / count;
  }
  return Array.from({ length: count }, (_, i) =>
    Math.hypot(frame[3 * i] - cx, frame[3 * i + 1] - cy, frame[3 * i + 2] - cz),
  );
}

const water = () => toWorkerArrays(PRESETS.find((p) => p.id === 'h2o')!.atoms).xyz;

describe('divergenceFrames', () => {
  it('starts on the molecule and ends back on it', () => {
    // The user built this structure; a failed calculation must not destroy it.
    const start = water();
    const frames = divergenceFrames(start);
    expect(frames.length).toBeGreaterThan(10);
    for (let i = 0; i < start.length; i++) {
      expect(frames[0][i]).toBeCloseTo(start[i], 5);
      expect(frames.at(-1)![i]).toBeCloseTo(start[i], 5);
    }
  });

  it('pushes every atom outwards, further each frame, then brings them back', () => {
    const frames = divergenceFrames(water());
    const spans = frames.map((frame) => Math.max(...radii(frame)));
    const peak = spans.indexOf(Math.max(...spans));
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThan(frames.length - 1);
    // Strictly outward up to the peak...
    for (let i = 1; i <= peak; i++) {
      expect(spans[i]).toBeGreaterThan(spans[i - 1]);
    }
    // ...and strictly back in afterwards.
    for (let i = peak + 1; i < frames.length; i++) {
      expect(spans[i]).toBeLessThan(spans[i - 1]);
    }
    // Far enough out to read as a molecule coming apart rather than drifting.
    expect(spans[peak]).toBeGreaterThan(4 * spans[0]);
  });

  it('accelerates rather than moving at a constant speed', () => {
    // A diverging calculation is not a drift; the motion has to look driven.
    const frames = divergenceFrames(water(), { scatterFrames: 20, returnFrames: 1 });
    const spans = frames.map((frame) => Math.max(...radii(frame)));
    const early = spans[5] - spans[4];
    const late = spans[19] - spans[18];
    expect(late).toBeGreaterThan(2 * early);
  });

  it('moves a single atom sitting at the centre', () => {
    // Nothing to fly away from, but the animation still has to happen: this is
    // the only signal the user gets that the calculation failed.
    const frames = divergenceFrames(new Float32Array([0, 0, 0]));
    const distances = frames.map((f) => Math.hypot(f[0], f[1], f[2]));
    expect(Math.max(...distances)).toBeGreaterThan(1);
    expect(distances.at(-1)).toBeCloseTo(0, 5);
  });

  it('is deterministic', () => {
    const a = divergenceFrames(water());
    const b = divergenceFrames(water());
    expect(a.map((f) => [...f])).toEqual(b.map((f) => [...f]));
  });

  it('handles an empty molecule', () => {
    expect(divergenceFrames(new Float32Array(0))).toEqual([]);
  });
});

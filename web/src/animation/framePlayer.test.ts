import { describe, expect, it } from 'vitest';
import { FramePlayer, interpolate, type Frame, type Scheduler } from './framePlayer';

/**
 * A scheduler the test drives by hand: nothing happens until `advance` is
 * called, so the playback clock can be checked without waiting for real
 * milliseconds or for a browser to exist.
 */
function manualScheduler() {
  let time = 0;
  let queued: (() => void) | null = null;
  const scheduler: Scheduler = {
    now: () => time,
    request: (callback) => {
      queued = callback;
      return 1;
    },
    cancel: () => {
      queued = null;
    },
  };
  return {
    scheduler,
    get idle() {
      return queued === null;
    },
    /** Moves time forward and runs the callback that was waiting, if any. */
    advance(ms: number) {
      time += ms;
      const callback = queued;
      queued = null;
      callback?.();
    },
  };
}

const frame = (...values: number[]): Frame => new Float32Array(values);

describe('interpolate', () => {
  it('returns the endpoints exactly', () => {
    const a = frame(0, 0, 0);
    const b = frame(1, 2, 3);
    expect(interpolate(a, b, 0)).toBe(a);
    expect(interpolate(a, b, 1)).toBe(b);
  });

  it('blends halfway', () => {
    const half = interpolate(frame(0, 0, 0), frame(2, 4, -6), 0.5);
    expect([...half]).toEqual([1, 2, -3]);
  });
});

describe('FramePlayer', () => {
  it('interpolates between keyframes at the display rate', () => {
    const clock = manualScheduler();
    const seen: number[] = [];
    const player = new FramePlayer({
      frameMs: 100,
      scheduler: clock.scheduler,
      onFrame: (positions) => seen.push(positions[0]),
    });

    player.push(frame(0), frame(10));
    // Pushing starts playback immediately, at the first keyframe.
    expect(seen).toEqual([0]);
    // A display frame a quarter of the way through the interval lands a quarter
    // of the way between the keyframes: the screen is not tied to the queue.
    clock.advance(25);
    clock.advance(25);
    expect(seen).toEqual([0, 2.5, 5]);
  });

  it('holds the last frame and reports being caught up', () => {
    const clock = manualScheduler();
    const seen: number[] = [];
    let idle = 0;
    const player = new FramePlayer({
      frameMs: 100,
      scheduler: clock.scheduler,
      onFrame: (positions) => seen.push(positions[0]),
      onIdle: () => idle++,
    });

    player.push(frame(0), frame(10));
    clock.advance(100);
    expect(seen.at(-1)).toBe(10);
    expect(idle).toBe(1);
    expect(player.playing).toBe(false);
    expect(clock.idle).toBe(true);

    // More frames restart it from where it stopped rather than from the
    // beginning: this is what phase 5 needs when optimisation steps trickle in.
    player.push(frame(20));
    expect(player.playing).toBe(true);
    clock.advance(50);
    expect(seen.at(-1)).toBe(15);
  });

  it('does not drift when a callback arrives late', () => {
    // Two whole intervals pass between display frames - a stalled tab, or a
    // long garbage collection. The player must skip to the right place rather
    // than replaying what was missed.
    const clock = manualScheduler();
    const seen: number[] = [];
    const player = new FramePlayer({
      frameMs: 100,
      scheduler: clock.scheduler,
      onFrame: (positions) => seen.push(positions[0]),
    });

    player.push(frame(0), frame(10), frame(20), frame(30));
    clock.advance(250);
    expect(seen.at(-1)).toBe(25);
    expect(player.pending).toBe(2);
  });

  it('drops played frames so a long run does not accumulate', () => {
    const clock = manualScheduler();
    const player = new FramePlayer({
      frameMs: 100,
      scheduler: clock.scheduler,
      onFrame: () => {},
    });
    player.push(frame(0), frame(1), frame(2));
    clock.advance(200);
    expect(player.pending).toBe(1);
    player.push(frame(3));
    // One consumed frame stays as the interpolation's starting point; the two
    // before it are gone.
    expect(player.pending).toBe(2);
  });

  it('stops dead when told to', () => {
    const clock = manualScheduler();
    const seen: number[] = [];
    const player = new FramePlayer({
      frameMs: 100,
      scheduler: clock.scheduler,
      onFrame: (positions) => seen.push(positions[0]),
    });
    player.push(frame(0), frame(10));
    player.stop();
    expect(player.playing).toBe(false);
    expect(clock.idle).toBe(true);
    clock.advance(1000);
    // Only the frame emitted by `push` itself; nothing after the stop.
    expect(seen).toEqual([0]);
  });
});

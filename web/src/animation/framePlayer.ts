/**
 * Plays a queue of keyframes at a steady rate, interpolating between them.
 *
 * The engine produces geometries when it produces them - a divergence animation
 * arrives all at once, and from phase 5 the steps of an optimisation arrive one
 * at a time, seconds apart or milliseconds apart depending on the molecule. The
 * player decouples that from what the screen does: frames go in at whatever rate
 * they are produced, and positions come out at the display's rate, so a slow
 * calculation never turns into a stuttering animation.
 *
 * Time and scheduling are injected rather than taken from the global object, so
 * the playback clock can be tested without a browser or a real second passing.
 */

/** One keyframe: coordinates in Angstrom, three per atom. */
export type Frame = Float32Array;

/** The two things the player needs from its environment. */
export interface Scheduler {
  now(): number;
  request(callback: () => void): number;
  cancel(handle: number): void;
}

/** The browser's animation clock, which is what production uses. */
export const animationFrameScheduler: Scheduler = {
  now: () => performance.now(),
  request: (callback) => requestAnimationFrame(callback),
  cancel: (handle) => cancelAnimationFrame(handle),
};

export interface FramePlayerOptions {
  /** Milliseconds one keyframe takes to give way to the next. */
  frameMs: number;
  /** Called with interpolated positions, at the scheduler's rate. */
  onFrame: (positions: Frame) => void;
  /**
   * Called once the last frame in the queue has been reached and the player has
   * stopped. Pushing more frames starts it again, so this means "caught up",
   * not "finished for good".
   */
  onIdle?: () => void;
  scheduler?: Scheduler;
}

export class FramePlayer {
  #frames: Frame[] = [];
  /** Index of the frame currently on screen. */
  #cursor = 0;
  /** When the frame at the cursor became current. */
  #anchor = 0;
  #handle: number | null = null;
  #options: Required<Omit<FramePlayerOptions, 'onIdle'>> & Pick<FramePlayerOptions, 'onIdle'>;

  constructor(options: FramePlayerOptions) {
    this.#options = { scheduler: animationFrameScheduler, ...options };
  }

  get playing(): boolean {
    return this.#handle !== null;
  }

  /** Frames waiting to be shown, the one on screen included. */
  get pending(): number {
    return this.#frames.length - this.#cursor;
  }

  /**
   * Adds keyframes to the end of the queue and starts playing if it was idle.
   *
   * Frames already played are dropped here rather than as they are consumed, so
   * a long optimisation does not accumulate its whole history in memory.
   */
  push(...frames: Frame[]) {
    if (frames.length === 0) return;
    if (this.#cursor > 0) {
      this.#frames = this.#frames.slice(this.#cursor);
      this.#cursor = 0;
    }
    this.#frames.push(...frames);
    if (this.#handle === null) {
      this.#anchor = this.#options.scheduler.now();
      this.#tick();
    }
  }

  /** Stops playback and throws away everything queued. */
  stop() {
    if (this.#handle !== null) {
      this.#options.scheduler.cancel(this.#handle);
      this.#handle = null;
    }
    this.#frames = [];
    this.#cursor = 0;
  }

  #tick = () => {
    this.#handle = null;
    const { scheduler, frameMs, onFrame, onIdle } = this.#options;

    // Advance past every keyframe whose time has passed. The anchor moves by
    // exactly one frame interval each time rather than to "now", so a late
    // callback does not make the animation drift.
    let t = frameMs > 0 ? (scheduler.now() - this.#anchor) / frameMs : Infinity;
    while (t >= 1 && this.#cursor + 1 < this.#frames.length) {
      this.#cursor += 1;
      this.#anchor += frameMs;
      t -= 1;
    }

    const current = this.#frames[this.#cursor];
    if (this.#cursor + 1 < this.#frames.length) {
      onFrame(interpolate(current, this.#frames[this.#cursor + 1], Math.min(1, t)));
      this.#handle = scheduler.request(this.#tick);
      return;
    }

    // Caught up with the producer. Show the last frame and go quiet; a later
    // push restarts from here.
    onFrame(current);
    onIdle?.();
  };
}

/** Straight-line blend between two keyframes. */
export function interpolate(from: Frame, to: Frame, t: number): Frame {
  if (t <= 0) return from;
  if (t >= 1) return to;
  const blended = new Float32Array(from.length);
  for (let i = 0; i < from.length; i++) {
    blended[i] = from[i] + (to[i] - from[i]) * t;
  }
  return blended;
}

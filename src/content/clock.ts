/**
 * Where caption timing comes from.
 *
 * Film captions are timed against the video: a cue holds while the viewer is
 * paused, shortens at 2× speed, and ends the moment they seek. A meeting page
 * has no single playback timeline — Meet renders many small tiles and no
 * element whose `currentTime` tracks the conversation — so its captions are
 * timed against the wall clock instead.
 */
export interface ClockSource {
  /** Monotonic-enough milliseconds used for cue timing and reading holds. */
  nowMs(): number;
  /**
   * How fast this clock runs relative to wall time. A reading hold measured in
   * clock milliseconds is divided by this to get a real `setTimeout` delay.
   */
  rate(): number;
}

/** Playback position of a media element, in milliseconds. */
export class MediaClock implements ClockSource {
  constructor(private readonly video: HTMLVideoElement) {}

  nowMs(): number {
    return this.video.currentTime * 1_000;
  }

  rate(): number {
    return this.video.playbackRate > 0 ? this.video.playbackRate : 1;
  }
}

/**
 * Wall clock for pages without a usable media timeline. `performance.now()`
 * rather than `Date.now()` so a system clock adjustment mid-meeting cannot
 * make a caption look like it ended hours ago.
 */
export class WallClock implements ClockSource {
  nowMs(): number {
    return performance.now();
  }

  rate(): number {
    return 1;
  }
}

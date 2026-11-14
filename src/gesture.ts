// Touch on a pile has two jobs: sliding a finger along it points at cards (the touch stand-in
// for a mouse hover), and holding the finger still takes the card it points at (the stand-in
// for a click). A hold is time spent within a small slop circle; leaving the circle restarts
// the wait from the new point.

/** Time a finger must rest on a pile to take the card under it. */
export const HOLD_MS = 380;
/** Movement, in CSS px, that still counts as resting. */
export const HOLD_SLOP_PX = 8;

export class Hold {
  private ax = 0;
  private ay = 0;
  private since = 0;

  constructor(
    private readonly ms = HOLD_MS,
    private readonly slop = HOLD_SLOP_PX,
  ) {}

  /** Starts the wait at (x, y) at time `t`. */
  start(x: number, y: number, t: number): void {
    this.ax = x;
    this.ay = y;
    this.since = t;
  }

  /** Records a move; returns true when it left the slop circle and restarted the wait. */
  move(x: number, y: number, t: number): boolean {
    if (Math.hypot(x - this.ax, y - this.ay) <= this.slop) return false;
    this.start(x, y, t);
    return true;
  }

  /** Milliseconds left until the hold completes at time `t`. */
  remaining(t: number): number {
    return Math.max(0, this.since + this.ms - t);
  }
}

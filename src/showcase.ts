// Showcase, in the manner of poke-holo.simey.me: a tapped card flies to the middle of the
// screen, grows and spins a full turn on the way; tapping it again flips it over to its back,
// tapping anywhere else (or Escape) sends it home. Three springs drive it: how far open the
// card is, the spin and the flip. The result is an extra transform on top of the physics,
// read by view.ts `cardFrame`, so both renderers show the same thing.

/** Spring with stiffness `k` and damping `c` (per second): $\ddot x = k(x^* - x) - c\dot x$. */
class Spring {
  /** Every spring here starts at rest at 0. */
  x = 0;
  v = 0;
  target = 0;

  constructor(
    private readonly k: number,
    private readonly c: number,
  ) {}

  step(dt: number): void {
    this.v += (this.k * (this.target - this.x) - this.c * this.v) * dt;
    this.x += this.v * dt;
  }

  get isSettled(): boolean {
    return Math.abs(this.target - this.x) < 1e-3 && Math.abs(this.v) < 1e-3;
  }

  snap(): void {
    this.x = this.target;
    this.v = 0;
  }
}

/** The showcase transform of the open card, in layout px and degrees. */
export interface ShowFrame {
  /** Open progress (0 at home, 1 in the middle; the spring overshoots a little). */
  readonly t: number;
  /** Offset from the card's home to the middle of the viewport, reached at `t` = 1. */
  readonly x: number;
  readonly y: number;
  /** Scale reached at `t` = 1. */
  readonly scale: number;
  /** Extra rotateY: the opening spin plus the flip. */
  readonly ry: number;
}

/** Fixed physics step, so the springs behave the same at 60 and 120 Hz. */
const STEP = 1 / 240;

export class Showcase {
  id: string | undefined;
  private readonly open = new Spring(90, 15);
  private readonly spin = new Spring(60, 11);
  private readonly flip = new Spring(140, 17);
  private last = 0;
  private acc = 0;

  /** Opens card `id`, closing any other one at once. */
  show(id: string): void {
    if (this.id !== id) {
      this.open.x = 0;
      this.open.v = 0;
      this.flip.target = 0;
      this.flip.snap();
    }
    this.id = id;
    this.open.target = 1;
    // Reopened while closing: start back out from rest, not against the closing motion.
    this.open.v = Math.max(0, this.open.v);
    // A full turn that unwinds as the card arrives.
    this.spin.x = 360;
    this.spin.v = 0;
    this.spin.target = 0;
  }

  /** Turns the open card over. */
  turn(): void {
    this.flip.target = this.flip.target === 0 ? 180 : 0;
  }

  /**
   * Sends the card home. Closed mid-opening, the card would carry its outward speed on and
   * stall before turning back; it turns back from rest instead.
   */
  close(): void {
    this.open.target = 0;
    this.open.v = Math.min(0, this.open.v);
    this.flip.target = 0;
  }

  get isOpen(): boolean {
    return this.id !== undefined && this.open.target === 1;
  }

  /** Steps the springs to `now` (ms); returns whether anything still moves. */
  tick(now: number): boolean {
    const dt = this.last === 0 ? 0 : Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    if (this.id === undefined) return false;
    this.acc += dt;
    while (this.acc >= STEP) {
      this.open.step(STEP);
      this.spin.step(STEP);
      this.flip.step(STEP);
      this.acc -= STEP;
    }
    const isMoving = !(this.open.isSettled && this.spin.isSettled && this.flip.isSettled);
    if (!isMoving && this.open.target === 0) this.id = undefined;
    return isMoving;
  }

  /**
   * The open card's transform: `toCentre` is the offset from its home to the viewport's
   * middle, `fit` the scale at which it fills the screen.
   */
  frameOf(id: string, toCentre: { x: number; y: number }, fit: number): ShowFrame | undefined {
    if (id !== this.id) return undefined;
    const t = this.open.x;
    return {
      t,
      x: toCentre.x,
      y: toCentre.y,
      scale: fit,
      ry: this.spin.x * Math.min(1, Math.max(0, t)) + this.flip.x,
    };
  }

  /** Whether the open card shows its back. */
  get isTurned(): boolean {
    return this.flip.target === 180;
  }
}

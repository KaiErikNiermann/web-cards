import { beforeEach, describe, expect, it } from "vitest";

import { DECKS, SECTION_IDS, type SectionId } from "./data";
import { Hold } from "./gesture";
import { CardTable, FOLD_DWELL_MS, MOVE_DWELL_MS, type PointerSample } from "./physics";

// Desktop geometry: full-size cards 220 × 308 with a 32 px gap, one section row per 400 px.
const W = 220;
const H = 308;
const GAP = 32;
const STEP = 40;
const PAD = 49;
const ROW_W = 1000;
const PER_ROW = 3;
const SECTION_SPAN = 2000;
/** Top of the stack section's first line. */
const STACK_Y = SECTION_IDS.indexOf("stack") * SECTION_SPAN;

/** Lays every section out as a wrapping grid, as the flex rows do. */
function setup(t: CardTable): void {
  for (const [si, sec] of SECTION_IDS.entries()) {
    t.rows.set(sec, { left: 0, right: ROW_W });
    const deck = DECKS[sec];
    for (const [k, c] of deck.entries()) {
      const col = k % PER_ROW;
      const line = Math.floor(k / PER_ROW);
      t.homes.set(c.id, {
        x: col * (W + GAP) + W / 2,
        y: si * SECTION_SPAN + line * (H + GAP) + H / 2,
      });
      t.meta.set(c.id, { sec, w: W, h: H, step: STEP, pad: PAD });
      t.ph(c.id);
    }
  }
}

const ids = (t: CardTable, sec: SectionId): string[][] => t.piles[sec].map((p) => [...p.ids]);

/** A mouse sample on the pointer's starting line; the tests drag sideways. */
const sample = (x: number): PointerSample => ({
  clientX: x,
  clientY: 0,
  pointerId: 1,
  pointerType: "mouse",
});

const box = { left: 0, top: 0, width: W, height: H };

/** Where a card is drawn: home, slot and drag offsets, and a pile member's lift. */
function drawn(t: CardTable, id: string): { x: number; y: number } {
  const p = t.ph(id);
  const h = t.homes.get(id) ?? { x: 0, y: 0 };
  return { x: h.x + p.bx + p.x, y: h.y + p.by + p.y - (p.pile ? p.lift * PAD : 0) };
}

/** Drags `id` sideways by `dx` and holds it there for `ms`, ticking every 16 ms. */
function dragAndHold(t: CardTable, id: string, dx: number, ms: number): void {
  t.down(id, sample(0), box);
  t.dragMove(id, sample(dx));
  for (let now = 0; now <= ms; now += 16) t.tick(now);
}

describe("piles", () => {
  let t: CardTable;
  beforeEach(() => {
    t = new CardTable();
    setup(t);
  });

  it("starts the stack section as one pile and every other card alone", () => {
    expect(ids(t, "stack")).toEqual([DECKS.stack.map((c) => c.id)]);
    expect(ids(t, "full")).toEqual([["qh"], ["as"], ["unit"], ["cover"]]);
    expect(t.isPiled("s-d7")).toBe(true);
    expect(t.isPiled("qh")).toBe(false);
  });

  it("stacks a card held squarely over a neighbour, and the row closes up", () => {
    dragAndHold(t, "qh", W + GAP, FOLD_DWELL_MS + 32);
    expect(t.isFoldArmed).toBe(true);
    t.end("qh", false, false);
    expect(ids(t, "full")).toEqual([["as", "qh"], ["unit"], ["cover"]]);
    expect(t.isPiled("qh")).toBe(true);
  });

  it("does not stack on a sweep that leaves before the dwell", () => {
    dragAndHold(t, "qh", W + GAP, FOLD_DWELL_MS - 40);
    expect(t.isFoldArmed).toBe(false);
    t.end("qh", false, false);
    expect(ids(t, "full")).toEqual([["qh"], ["as"], ["unit"], ["cover"]]);
  });

  it("reflows instead when the card rests part way over the next slot", () => {
    // 0.45 w short of the neighbour's centre: inside reflow reach, outside the stacking zone.
    dragAndHold(t, "qh", W + GAP - 0.45 * W, MOVE_DWELL_MS + 32);
    expect(ids(t, "full")).toEqual([["as"], ["qh"], ["unit"], ["cover"]]);
    t.end("qh", false, false);
    expect(ids(t, "full")).toEqual([["as"], ["qh"], ["unit"], ["cover"]]);
  });

  it("never stacks with snap to slots off", () => {
    t.m.ret = false;
    dragAndHold(t, "qh", W + GAP, FOLD_DWELL_MS * 2);
    t.end("qh", false, false);
    expect(ids(t, "full")).toEqual([["qh"], ["as"], ["unit"], ["cover"]]);
  });

  it("takes any card out of a pile into the slot after it, keeping it in place", () => {
    const pile = t.pileOf("s-qh");
    expect(pile).toBeDefined();
    if (!pile) return;
    for (let now = 0; now < 2000; now += 16) {
      // Point at the fourth card of the fan: its visible strip starts at 3 steps.
      t.scrub(pile, 3 * STEP + STEP / 2, STACK_Y + H / 2);
      t.tick(now);
    }
    const id = t.pickTarget(pile);
    expect(id).toBe("s-d7");
    if (id === undefined) return;
    const before = drawn(t, id);
    t.pull(id);
    const after = drawn(t, id);
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
    const rest = DECKS.stack.map((c) => c.id).filter((x) => x !== "s-d7");
    expect(ids(t, "stack")).toEqual([rest, ["s-d7"]]);
    expect(t.isPiled("s-d7")).toBe(false);
  });

  it("dissolves a pile of two into two cards when one is taken", () => {
    dragAndHold(t, "qh", W + GAP, FOLD_DWELL_MS + 32);
    t.end("qh", false, false);
    t.pull("as");
    expect(ids(t, "full")).toEqual([["qh"], ["as"], ["unit"], ["cover"]]);
    expect(t.isPiled("qh")).toBe(false);
  });

  it("drops a taken card back on its pile", () => {
    t.pull("s-kc");
    expect(ids(t, "stack")).toHaveLength(2);
    // The pulled card sits in slot 1; slot 0, the pile, is one slot to the left.
    dragAndHold(t, "s-kc", -(W + GAP), FOLD_DWELL_MS + 32);
    t.end("s-kc", false, false);
    expect(ids(t, "stack")).toHaveLength(1);
    expect(ids(t, "stack")[0]?.at(-1)).toBe("s-kc");
  });

  it("hit-tests a closed pile by its slot and an open one by its fan", () => {
    const y = STACK_Y + H / 2;
    expect(t.pileAt(W / 2, y)?.sec).toBe("stack");
    // Beyond the slot, inside where the fan of 8 reaches (220 + 7 · 40 = 500 px).
    expect(t.pileAt(W + 100, y)).toBeUndefined();
    const pile = t.pileAt(W / 2, y);
    if (pile) t.scrub(pile, W / 2, y);
    expect(t.pileAt(W + 100, y)?.sec).toBe("stack");
    // The open fan's lift headroom counts as the pile too.
    expect(t.pileAt(W / 2, STACK_Y - PAD / 2)?.sec).toBe("stack");
  });

  it("restores the starting piles on reset", () => {
    t.pull("s-kc");
    t.resetAll();
    expect(ids(t, "stack")).toEqual([DECKS.stack.map((c) => c.id)]);
  });
});

describe("hold", () => {
  it("completes after resting within the slop and restarts on a larger move", () => {
    const h = new Hold(400, 8);
    h.start(0, 0, 0);
    expect(h.move(5, 5, 100)).toBe(false);
    expect(h.remaining(300)).toBe(100);
    expect(h.move(20, 0, 300)).toBe(true);
    expect(h.remaining(300)).toBe(400);
    expect(h.remaining(800)).toBe(0);
  });
});

/** 101 ms is 12 whole steps of 1000/120 ms at either 60 or 120 Hz, with no step on the boundary. */
const GLIDE_MS = 101;

/** Releases a card dragged 200 px sideways and runs the sim at `hz` for `GLIDE_MS`. */
function glideAt(hz: number): { x: number; rot: number } {
  const t = new CardTable();
  setup(t);
  const id = DECKS.full[0]?.id ?? "";
  t.down(id, sample(0), box);
  t.dragMove(id, sample(200));
  t.end(id, false, false);
  for (let now = 0; now < GLIDE_MS; now += 1000 / hz) t.tick(now);
  t.tick(GLIDE_MS);
  const p = t.ph(id);
  return { x: p.x + p.bx, rot: p.rot };
}

describe("fixed timestep", () => {
  it("moves the same distance whether frames come at 60 or 120 Hz", () => {
    const at60 = glideAt(60);
    const at120 = glideAt(120);
    expect(at60.x).toBeCloseTo(at120.x, 6);
    expect(at60.rot).toBeCloseTo(at120.rot, 6);
    // The card is still on its way back, so this does not compare two cards at rest.
    expect(Math.abs(at120.x)).toBeGreaterThan(1);
    expect(Math.abs(at120.x)).toBeLessThan(200);
  });

  it("draws between the last two steps", () => {
    const t = new CardTable();
    setup(t);
    const id = DECKS.full[0]?.id ?? "";
    t.down(id, sample(0), box);
    t.dragMove(id, sample(200));
    t.end(id, false, false);
    const stepMs = 1000 / 120;
    t.tick(stepMs + 0.01);
    const a = t.ph(id).x + t.ph(id).bx;
    t.tick(2 * stepMs + 0.02);
    const b = t.ph(id).x + t.ph(id).bx;
    // Half a step later: no new step, the drawn state is halfway from a to b.
    t.tick(2.5 * stepMs + 0.02);
    const mid = t.view(id);
    expect(a).not.toBeCloseTo(b, 3);
    // The 0.02 ms left over after the second step makes it slightly more than half.
    const alpha = (0.5 * stepMs + 0.02) / stepMs;
    expect(mid.x + mid.bx).toBeCloseTo(a + (b - a) * alpha, 3);
  });
});

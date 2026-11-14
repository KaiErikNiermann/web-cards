// Card-table physics: spring-damped drag, sway, slot reflow, push-away and dynamic piles.
// The spring constants of the drag, sway, reflow and push are the export's originals.
//
// Each section's order is a list of piles; a single card is a pile of one. Pile k sits in the
// section's k-th slot, so merging two cards frees a slot and the row closes up behind it.

import {
  DECKS,
  PILED_SECTIONS,
  PRESETS,
  SECTION_IDS,
  START_FINISH,
  type PresetId,
  type SectionId,
} from "./data";

export interface Material {
  preset: PresetId | "";
  refl: number;
  rough: number;
  foil: number;
  grain: number;
  tilt: number;
  sway: number;
  ret: boolean;
}

export type MaterialSlider = "refl" | "rough" | "foil" | "grain" | "tilt" | "sway";

/** Per-card simulation state. */
export interface Phys {
  /** Free drag offset and its velocity. */
  x: number;
  y: number;
  pvx: number;
  pvy: number;
  /** Slot (reflow) offset and its velocity. */
  bx: number;
  by: number;
  bvx: number;
  bvy: number;
  /** Push-away offset and its velocity. */
  ox: number;
  oy: number;
  ovx: number;
  ovy: number;
  /** Displacement accumulated this frame, fed into the smoothed velocity. */
  ax: number;
  ay: number;
  vel: number;
  vely: number;
  /** Sway rotation and its angular velocity. */
  rot: number;
  rv: number;
  rx: number;
  ry: number;
  /** Highlight and lift amounts in [0, 1]. */
  h: number;
  lift: number;
  /** Pointer position on the card in [0, 1]. */
  px: number;
  py: number;
  /** Glare centre, in percent. */
  gx: number;
  gy: number;
  hover: boolean;
  drag: boolean;
  home: boolean;
  z: number;
  lcx: number;
  lcy: number;
  pid: number;
  /** Member of a pile of two or more; `pz` is then its stacking order. */
  pile: boolean;
  pz: number;
  /** Shrink of a dragged card while a drop would stack it, in [0, 1]. */
  sink: number;
  /** Moving, lifted or tilted: drawn with the 3D transform on its own layer. */
  live: boolean;
}

export interface CardMeta {
  readonly sec: SectionId;
  readonly w: number;
  readonly h: number;
  /** Fan step of an open pile and the lift headroom above it, in layout px. */
  readonly step: number;
  readonly pad: number;
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** The part of a `DOMRect` the physics reads. */
export type BoxSample = Pick<DOMRect, "left" | "top" | "width" | "height">;

export interface Rect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** A pile of cards in one slot, bottom to top. */
export interface Pile {
  readonly ids: string[];
  /** Fanned out for picking (hovered or scrubbed). */
  open: boolean;
  /** Openness in [0, 1], eased toward `open`. */
  o: number;
  /** Pointer position along the fan in card indices, and its smoothed follower. */
  f: number;
  fs: number;
  /** Pointer height on the fan in [0, 1]. */
  py: number;
  /** A dragged card has dwelt over this pile long enough to be dropped into it. */
  fold: boolean;
}

export interface PileRef {
  readonly sec: SectionId;
  readonly k: number;
  readonly pile: Pile;
}

interface Location {
  readonly sec: SectionId;
  readonly k: number;
  readonly j: number;
}

type IntentKind = "fold" | "move";

interface Intent {
  readonly kind: IntentKind;
  readonly k: number;
  readonly since: number;
}

/** Pointer data the physics reads; a subset of `PointerEvent`. */
export interface PointerSample {
  readonly clientX: number;
  readonly clientY: number;
  readonly pointerId: number;
  readonly pointerType: string;
}

/** Normalised centre distance $\sqrt{(dx/w)^2 + (dy/h)^2}$ under which a drop stacks. */
export const FOLD_RADIUS = 0.3;
/** Time the dragged card must stay in the stacking zone before a drop stacks. */
export const FOLD_DWELL_MS = 260;
/** Time the dragged card must stay over another slot before the row reflows. */
export const MOVE_DWELL_MS = 150;
/** Reflow reach: the nearest slot home within $0.55\,w$ of the dragged centre. */
const MOVE_REACH = 0.55;
/** z of an open pile's cards: above every card raised by a click, below the drag. */
const Z_OPEN_PILE = 5000;

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
const clamp01 = (v: number): number => clamp(v, 0, 1);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

function newPhys(): Phys {
  return {
    x: 0,
    y: 0,
    pvx: 0,
    pvy: 0,
    bx: 0,
    by: 0,
    bvx: 0,
    bvy: 0,
    ox: 0,
    oy: 0,
    ovx: 0,
    ovy: 0,
    ax: 0,
    ay: 0,
    vel: 0,
    vely: 0,
    rot: 0,
    rv: 0,
    rx: 0,
    ry: 0,
    h: 0,
    lift: 0,
    px: 0.5,
    py: 0.5,
    gx: 30,
    gy: 18,
    hover: false,
    drag: false,
    home: false,
    z: 0,
    lcx: 0,
    lcy: 0,
    pid: -1,
    pile: false,
    pz: 0,
    sink: 0,
    live: false,
  };
}

function newPile(ids: readonly string[]): Pile {
  return { ids: [...ids], open: false, o: 0, f: 0, fs: 0, py: 0.5, fold: false };
}

/** The slot ids of each section, in layout order; pile k sits in slot `SLOTS[sec][k]`. */
const SLOTS: Readonly<Record<SectionId, readonly string[]>> = (() => {
  const entries = SECTION_IDS.map((s) => [s, DECKS[s].map((c) => c.id)] as const);
  return Object.fromEntries(entries) as Record<SectionId, string[]>;
})();

function initialPiles(sec: SectionId): Pile[] {
  const ids = SLOTS[sec];
  return PILED_SECTIONS.has(sec) ? [newPile(ids)] : ids.map((id) => newPile([id]));
}

/** Whether `a` and `b` differ by more than `eps`. */
const isApart = (a: number, b: number, eps: number): boolean => Math.abs(a - b) > eps;

/** Hover lifts a card part way; a drag lifts it fully. */
function liftTarget(p: Phys): number {
  if (p.drag) return 1;
  return p.hover ? 0.55 : 0;
}

interface TiltTarget {
  readonly trx: number;
  readonly tryy: number;
  readonly tgx: number;
  readonly tgy: number;
}

/** Tilt and glare target: follow the pointer on hover, lean with vertical velocity on drag. */
function tiltTarget(p: Phys, tilt: number, sway: number): TiltTarget {
  if (p.hover && !p.drag) {
    return {
      tryy: (p.px - 0.5) * 2 * tilt,
      trx: -(p.py - 0.5) * 2 * tilt,
      tgx: p.px * 100,
      tgy: p.py * 100,
    };
  }
  if (p.drag) {
    return {
      trx: clamp(p.vely * 0.9 * sway, -10, 10),
      tryy: 0,
      tgx: 50 - p.rot * 3,
      tgy: 30 + p.rx * 2,
    };
  }
  return { trx: 0, tryy: 0, tgx: 30, tgy: 18 };
}

function lookup<T>(map: ReadonlyMap<string, T>, id: string | undefined): T | undefined {
  return id === undefined ? undefined : map.get(id);
}

/** A small fixed tilt per card so a closed pile reads as a hand-squared deck, in degrees. */
function jitter(id: string): number {
  let hash = 0;
  for (const ch of id) hash = (hash * 31 + (ch.codePointAt(0) ?? 0)) % 9973;
  return ((hash % 7) - 3) * 0.55;
}

/** Offset of member `j` of a closed pile of `n`: a deck whose thickness steps up and left. */
function closedOffset(j: number, n: number): Point {
  const s = Math.min(2.2, 12 / (n - 1));
  const c = j - (n - 1) / 2;
  return { x: -c * s * 0.5, y: -c * s };
}

/** Pile-member motion targets that change whether anything is still moving. */
function isMemberMoving(p: Phys, lt: number, trx: number, tryy: number, rt: number): boolean {
  return (
    isApart(lt, p.lift, 0.003) ||
    isApart(trx, p.rx, 0.02) ||
    isApart(tryy, p.ry, 0.02) ||
    isApart(rt, p.rot, 0.02) ||
    isApart(p.rv, 0, 0.01)
  );
}

/**
 * The simulation's fixed step. Every spring factor here is per step, tuned on a 120 Hz phone,
 * where it ran once per frame; stepping at a fixed rate keeps that speed at 60 Hz too.
 */
const STEP_MS = 1000 / 120;
/** At most this many steps per frame; a longer stall is dropped rather than replayed. */
const MAX_STEPS = 8;
/** A gap this long between frames means the loop was idle and is starting again. */
const IDLE_GAP_MS = 100;

/** The quantities drawn from, blended between steps in `view`. */
const DRAWN = [
  "x",
  "y",
  "bx",
  "by",
  "ox",
  "oy",
  "rot",
  "rx",
  "ry",
  "h",
  "lift",
  "px",
  "py",
  "gx",
  "gy",
  "sink",
] as const satisfies readonly (keyof Phys)[];

export class CardTable {
  private zc = 1;
  private lastNow = 0;
  private acc = 0;
  private alpha = 1;
  private wasActive = false;
  /** Each card's drawn quantities as of the step before the last. */
  private readonly prev = new Map<string, Phys>();
  private readonly viewOut = new Map<string, Phys>();
  private intent: Intent | undefined;
  private readonly locs = new Map<string, Location>();
  readonly m: Material;
  readonly piles: Record<SectionId, Pile[]>;
  readonly phys = new Map<string, Phys>();
  readonly meta = new Map<string, CardMeta>();
  readonly homes = new Map<string, Point>();
  /** Horizontal extent of each section's row, in root layout coordinates. */
  readonly rows = new Map<SectionId, { readonly left: number; readonly right: number }>();
  /** Bumped on every change to the piles, so the page can re-lay out once. */
  version = 0;
  /** Rendered-to-layout scale of the root (CSS transforms on an ancestor). */
  sc = 1;
  dragId: string | undefined;
  hoverId: string | undefined;

  constructor(start: PresetId = START_FINISH) {
    const p = PRESETS[start];
    this.m = {
      preset: start,
      refl: p.refl,
      rough: p.rough,
      foil: p.foil,
      grain: p.grain,
      tilt: 14,
      sway: 100,
      ret: true,
    };
    this.piles = Object.fromEntries(SECTION_IDS.map((s) => [s, initialPiles(s)])) as Record<
      SectionId,
      Pile[]
    >;
    this.reindex();
  }

  ph(id: string): Phys {
    let p = this.phys.get(id);
    if (!p) {
      p = newPhys();
      p.pile = this.isPiled(id);
      this.phys.set(id, p);
    }
    return p;
  }

  /** Whether `id` is in a pile of two or more. */
  isPiled(id: string): boolean {
    const loc = this.locs.get(id);
    return loc !== undefined && (this.piles[loc.sec][loc.k]?.ids.length ?? 0) > 1;
  }

  /** Whether any pile is fanned out or still closing. */
  get isFanning(): boolean {
    for (const { pile } of this.allPiles()) {
      if (pile.ids.length > 1 && (pile.open || pile.o > 0)) return true;
    }
    return false;
  }

  /**
   * Whether `id`'s animations should hold still because of its pile: under the top card of a
   * closed pile, or any card but the pointed one of an open fan.
   */
  isPileQuiet(id: string): boolean {
    const loc = this.locs.get(id);
    const pile = loc && this.piles[loc.sec][loc.k];
    if (!pile || pile.ids.length < 2) return false;
    if (pile.open || pile.o > 0) return loc.j !== Math.round(pile.fs);
    return loc.j < pile.ids.length - 1;
  }

  pileOf(id: string): PileRef | undefined {
    const loc = this.locs.get(id);
    const pile = loc && this.piles[loc.sec][loc.k];
    return loc && pile ? { sec: loc.sec, k: loc.k, pile } : undefined;
  }

  /** Every pile on the table, with its section and slot. */
  *allPiles(): Generator<PileRef> {
    for (const sec of SECTION_IDS) {
      const list = this.piles[sec];
      for (const [k, pile] of list.entries()) yield { sec, k, pile };
    }
  }

  private reindex(): void {
    this.locs.clear();
    for (const { sec, k, pile } of this.allPiles()) {
      for (const [j, id] of pile.ids.entries()) this.locs.set(id, { sec, k, j });
    }
    for (const [id, p] of this.phys) p.pile = this.isPiled(id);
    this.version += 1;
  }

  pickPreset(id: PresetId): void {
    const q = PRESETS[id];
    Object.assign(this.m, {
      preset: id,
      refl: q.refl,
      rough: q.rough,
      foil: q.foil,
      grain: q.grain,
    });
  }

  /** Material sliders drop the preset; tilt and sway are handling, not material. */
  setSlider(key: MaterialSlider, value: number): void {
    this.m[key] = value;
    if (key !== "tilt" && key !== "sway") this.m.preset = "";
  }

  resetAll(): void {
    for (const s of SECTION_IDS) this.piles[s] = initialPiles(s);
    this.reindex();
    for (const p of this.phys.values()) {
      p.home = true;
      p.pvx = 0;
      p.pvy = 0;
    }
  }

  /** Home centre of slot `k` in `sec`. */
  private slotHome(sec: SectionId, k: number): Point | undefined {
    return lookup(this.homes, SLOTS[sec][k]);
  }

  /** Fan geometry of a pile in slot `k`: left edge and step, kept inside the row. */
  private fan(
    sec: SectionId,
    k: number,
    n: number,
    meta: CardMeta,
  ): { left: number; step: number } {
    const home = this.slotHome(sec, k);
    const row = this.rows.get(sec);
    if (!home || !row) return { left: 0, step: meta.step };
    const avail = row.right - row.left - meta.w;
    const step = n > 1 ? Math.max(4, Math.min(meta.step, avail / (n - 1))) : 0;
    const width = meta.w + (n - 1) * step;
    const left = clamp(home.x - meta.w / 2, row.left, Math.max(row.left, row.right - width));
    return { left, step };
  }

  /** Offset from a card's own home slot to where its place in the piles puts it. */
  slotTarget(id: string): Point {
    const loc = this.locs.get(id);
    const meta = this.meta.get(id);
    const home = this.homes.get(id);
    const th = loc && this.slotHome(loc.sec, loc.k);
    const pile = loc && this.piles[loc.sec][loc.k];
    if (!loc || !meta || !home || !th || !pile) return { x: 0, y: 0 };
    const base = { x: th.x - home.x, y: th.y - home.y };
    const n = pile.ids.length;
    if (n < 2) return base;
    const closed = closedOffset(loc.j, n);
    const { left, step } = this.fan(loc.sec, loc.k, n, meta);
    const openX = left + loc.j * step + meta.w / 2 - th.x;
    return {
      x: base.x + lerp(closed.x, openX, pile.o),
      y: base.y + lerp(closed.y, 0, pile.o),
    };
  }

  /** Hit area of a pile: its slot when closed, the fan plus lift headroom when open. */
  pileRect(sec: SectionId, k: number): Rect | undefined {
    const pile = this.piles[sec][k];
    const home = this.slotHome(sec, k);
    const meta = lookup(this.meta, pile?.ids[0]);
    if (!pile || !home || !meta) return undefined;
    const top = home.y - meta.h / 2;
    if (!pile.open) {
      return { left: home.x - meta.w / 2, top, right: home.x + meta.w / 2, bottom: top + meta.h };
    }
    const { left, step } = this.fan(sec, k, pile.ids.length, meta);
    const right = left + meta.w + (pile.ids.length - 1) * step;
    return { left, top: top - meta.pad, right, bottom: top + meta.h };
  }

  /** The pile of two or more under a point in root layout coordinates; open piles first. */
  pileAt(x: number, y: number): PileRef | undefined {
    let hit: PileRef | undefined;
    for (const ref of this.allPiles()) {
      if (ref.pile.ids.length < 2) continue;
      const r = this.pileRect(ref.sec, ref.k);
      if (!r || x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
      if (ref.pile.open) return ref;
      hit ??= ref;
    }
    return hit;
  }

  /** Fans `ref` out and points at the card under (x, y), in root layout coordinates. */
  scrub(ref: PileRef, x: number, y: number): void {
    const { sec, k, pile } = ref;
    const home = this.slotHome(sec, k);
    const meta = lookup(this.meta, pile.ids[0]);
    if (!home || !meta) return;
    const { left, step } = this.fan(sec, k, pile.ids.length, meta);
    pile.f = clamp((x - left - step / 2) / (step || 1), 0, pile.ids.length - 1);
    if (!pile.open) pile.fs = pile.f;
    pile.py = clamp01((y - (home.y - meta.h / 2)) / meta.h);
    pile.open = true;
  }

  /** Closes every open pile except `keep`. */
  closePiles(keep?: Pile): void {
    for (const { pile } of this.allPiles()) if (pile !== keep) pile.open = false;
  }

  /** The card a press on an open pile would take: the one the pointer is on. */
  pickTarget(ref: PileRef): string | undefined {
    return ref.pile.ids[Math.round(clamp(ref.pile.f, 0, ref.pile.ids.length - 1))];
  }

  /**
   * Takes `id` out of its pile into a new slot right after it; the row makes room. Its
   * on-screen position is kept, so a drag can start from where the card was.
   */
  pull(id: string): void {
    const ref = this.pileOf(id);
    const p = this.phys.get(id);
    const meta = this.meta.get(id);
    if (!ref || !p || !meta || ref.pile.ids.length < 2) return;
    const { sec, k, pile } = ref;
    pile.ids.splice(pile.ids.indexOf(id), 1);
    pile.open = false;
    this.piles[sec].splice(k + 1, 0, newPile([id]));
    this.reindex();
    const nb = this.slotTarget(id);
    // Keep the card where it was drawn, including the lift the pile drew it with.
    p.x += p.bx - nb.x;
    p.y += p.by - nb.y - p.lift * meta.pad;
    p.bx = nb.x;
    p.by = nb.y;
    p.bvx = 0;
    p.bvy = 0;
  }

  /** Moves the dragged card's single-card pile from slot `e` to slot `b`. */
  private moveEntry(id: string, sec: SectionId, e: number, b: number): void {
    const p = this.phys.get(id);
    const list = this.piles[sec];
    const [entry] = list.splice(e, 1);
    if (!p || !entry) return;
    list.splice(b, 0, entry);
    this.reindex();
    const nb = this.slotTarget(id);
    p.x += p.bx - nb.x;
    p.y += p.by - nb.y;
    p.bx = nb.x;
    p.by = nb.y;
  }

  /** Drops the dragged card's single-card pile in slot `e` on top of the pile in slot `k`. */
  private foldInto(id: string, sec: SectionId, e: number, k: number): void {
    const list = this.piles[sec];
    const target = list[k];
    if (!target || e === k) return;
    list.splice(e, 1);
    target.ids.push(id);
    target.fold = false;
    this.reindex();
  }

  private setIntent(next: Intent | undefined): void {
    for (const { pile } of this.allPiles()) pile.fold = false;
    this.intent = next;
  }

  /** Whether a drop now would stack the dragged card (the stacking zone has been held). */
  get isFoldArmed(): boolean {
    return this.intent?.kind === "fold" && this.armedPile() !== undefined;
  }

  private armedPile(): Pile | undefined {
    const loc = lookup(this.locs, this.dragId);
    const it = this.intent;
    const pile = loc && it?.kind === "fold" ? this.piles[loc.sec][it.k] : undefined;
    return pile?.fold ? pile : undefined;
  }

  /** What the dragged card is over: a slot to stack onto, a slot to move to, or neither. */
  private dragTarget(): { kind: IntentKind; k: number } | undefined {
    const id = this.dragId;
    const loc = lookup(this.locs, id);
    const p = lookup(this.phys, id);
    const meta = lookup(this.meta, id);
    const home = lookup(this.homes, id);
    if (!loc || !p || !meta || !home) return undefined;
    const cx = home.x + p.bx + p.x;
    const cy = home.y + p.by + p.y;
    const used = this.piles[loc.sec].length;
    let best = -1;
    let bd = Infinity;
    const slots = SLOTS[loc.sec];
    for (const [k, slotId] of slots.entries()) {
      const h = this.homes.get(slotId);
      if (!h) continue;
      const d = Math.hypot(h.x - cx, h.y - cy);
      if (d >= bd) continue;
      bd = d;
      best = k;
    }
    const h = this.slotHome(loc.sec, best);
    if (!h || best < 0 || bd > meta.w * MOVE_REACH) return undefined;
    const k = Math.min(best, used - 1);
    if (k === loc.k) return undefined;
    // Stacking needs the card squarely over an occupied slot; anything looser reflows.
    const nd = Math.hypot((h.x - cx) / meta.w, (h.y - cy) / meta.h);
    return best < used && nd < FOLD_RADIUS ? { kind: "fold", k } : { kind: "move", k };
  }

  /** Dwell-based drag intent: the row reflows or a pile opens to take the card. */
  private updateIntent(now: number): void {
    const id = this.dragId;
    const loc = lookup(this.locs, id);
    if (id === undefined || !loc || !this.m.ret) {
      if (this.intent) this.setIntent(undefined);
      return;
    }
    const next = this.dragTarget();
    const it = this.intent;
    if (next?.kind !== it?.kind || next?.k !== it?.k) {
      this.setIntent(next && { ...next, since: now });
      return;
    }
    if (!it) return;
    const dwell = now - it.since;
    if (it.kind === "move" && dwell >= MOVE_DWELL_MS) {
      this.moveEntry(id, loc.sec, loc.k, it.k);
      this.setIntent(undefined);
    } else if (it.kind === "fold" && dwell >= FOLD_DWELL_MS) {
      const pile = this.piles[loc.sec][it.k];
      if (pile) pile.fold = true;
    }
  }

  private tickPile(pile: Pile): boolean {
    pile.fs += (pile.f - pile.fs) * 0.3;
    const ot = pile.open ? 1 : 0;
    pile.o += (ot - pile.o) * 0.22;
    if (!isApart(pile.o, ot, 0.002)) pile.o = ot;
    return isApart(pile.f, pile.fs, 0.002) || pile.o !== ot;
  }

  /** Target push-away offset for a card: radial from the dragged card, or a nudge from a hover. */
  private pushTarget(id: string, meta: CardMeta, t: Point): Point {
    const home = this.homes.get(id);
    if (!home || id === this.dragId) return { x: 0, y: 0 };
    const qx = home.x + t.x;
    const qy = home.y + t.y;
    const dId = this.dragId;
    const dp = lookup(this.phys, dId);
    const dm = lookup(this.meta, dId);
    const dh = lookup(this.homes, dId);
    if (dp && dh) {
      if (this.m.ret && dm?.sec === meta.sec) return { x: 0, y: 0 };
      // Falloff $\text{mag} = 46 (1 - d/R)^2$ for $d < R$, $R = 1.3 \max(w, w_{drag})$.
      const dx = qx - (dh.x + dp.bx + dp.x);
      const dy = qy - (dh.y + dp.by + dp.y);
      const d = Math.hypot(dx, dy) || 0.001;
      const R = Math.max(meta.w, dm ? dm.w : meta.w) * 1.3;
      if (d >= R) return { x: 0, y: 0 };
      const k = 1 - d / R;
      const mag = 46 * k * k;
      return { x: (dx / d) * mag, y: (dy / d) * mag };
    }
    const hId = dId === undefined ? this.hoverId : undefined;
    const hh = lookup(this.homes, hId);
    const hm = lookup(this.meta, hId);
    const hp = lookup(this.phys, hId);
    if (!hh || !hm || !hp || hm.sec !== meta.sec) return { x: 0, y: 0 };
    const dx = qx - (hh.x + hp.bx);
    const dy = qy - (hh.y + hp.by);
    const d = Math.abs(dx);
    const R = meta.w * 1.35;
    return {
      x: d > 1 && d < R && Math.abs(dy) < meta.h * 0.5 ? Math.sign(dx) * 10 * (1 - d / R) : 0,
      y: 0,
    };
  }

  /** Springs the slot and push offsets toward their targets; returns whether they rest. */
  private springSlot(id: string, p: Phys, meta: CardMeta): boolean {
    const t = this.slotTarget(id);
    if (id === this.dragId) {
      p.bx = t.x;
      p.by = t.y;
      p.bvx = 0;
      p.bvy = 0;
    } else {
      p.bvx = (p.bvx + (t.x - p.bx) * 0.1) * 0.72;
      p.bvy = (p.bvy + (t.y - p.by) * 0.1) * 0.72;
      p.bx += p.bvx;
      p.by += p.bvy;
      p.ax += p.bvx;
      p.ay += p.bvy;
    }
    const to = this.pushTarget(id, meta, t);
    p.ovx = (p.ovx + (to.x - p.ox) * 0.12) * 0.72;
    p.ovy = (p.ovy + (to.y - p.oy) * 0.12) * 0.72;
    p.ox += p.ovx;
    p.oy += p.ovy;
    p.ax += p.ovx;
    p.ay += p.ovy;
    return !(
      isApart(t.x, p.bx, 0.05) ||
      isApart(t.y, p.by, 0.05) ||
      isApart(p.bvx, 0, 0.01) ||
      isApart(p.bvy, 0, 0.01) ||
      isApart(to.x, p.ox, 0.05) ||
      isApart(to.y, p.oy, 0.05) ||
      isApart(p.ovx, 0, 0.01) ||
      isApart(p.ovy, 0, 0.01)
    );
  }

  private tickFree(id: string, p: Phys, meta: CardMeta, isTarget: boolean): boolean {
    const m = this.m;
    const sway = m.sway / 100;
    const isSlotAtRest = this.springSlot(id, p, meta);
    // A single card a drop would stack onto lifts like a hover, as the go-ahead.
    const ht = isTarget || p.hover || p.drag ? 1 : 0;
    const lt = isTarget ? 0.55 : liftTarget(p);
    p.h += (ht - p.h) * 0.15;
    p.lift += (lt - p.lift) * 0.18;
    // The dragged card shrinks while a drop would stack it, so the lifted target shows round it.
    const st = p.drag && this.isFoldArmed ? 1 : 0;
    p.sink += (st - p.sink) * 0.25;
    if (p.home && !p.drag) this.springHome(p);
    p.vel = p.vel * 0.55 + p.ax * 0.45;
    p.vely = p.vely * 0.55 + p.ay * 0.45;
    p.ax = 0;
    p.ay = 0;
    // Sway: $\text{rotateZ} \to \operatorname{clamp}(-1.4\, k\, v_x, \pm 16)$, spring-damped.
    const target = clamp(-p.vel * 1.4 * sway, -16, 16);
    p.rv = (p.rv + (target - p.rot) * 0.14) * 0.8;
    p.rot += p.rv;
    const { trx, tryy, tgx, tgy } = tiltTarget(p, m.tilt, sway);
    p.rx += (trx - p.rx) * 0.16;
    p.ry += (tryy - p.ry) * 0.16;
    p.gx += (tgx - p.gx) * 0.25;
    p.gy += (tgy - p.gy) * 0.25;
    return (
      p.drag ||
      p.home ||
      !isSlotAtRest ||
      isApart(ht, p.h, 0.003) ||
      isApart(lt, p.lift, 0.003) ||
      isApart(st, p.sink, 0.003) ||
      isApart(p.rot, 0, 0.02) ||
      isApart(p.rv, 0, 0.01) ||
      isApart(p.vel, 0, 0.01) ||
      isApart(p.vely, 0, 0.01) ||
      isApart(trx, p.rx, 0.02) ||
      isApart(tryy, p.ry, 0.02) ||
      isApart(tgx, p.gx, 0.1) ||
      isApart(tgy, p.gy, 0.1)
    );
  }

  /**
   * A card in a pile: the card nearest the pointer lifts by $e^{-d^2/0.5}$ of the fan's
   * openness, $d$ its index distance from the smoothed pointer; a pile ready to take a drop
   * lifts as a whole.
   */
  private tickMember(id: string, p: Phys, meta: CardMeta, pile: Pile, j: number): boolean {
    const isSlotAtRest = this.springSlot(id, p, meta);
    if (p.home) this.springHome(p);
    p.vel = 0;
    p.vely = 0;
    p.ax = 0;
    p.ay = 0;
    const n = pile.ids.length;
    const d = j - pile.fs;
    const scrub = pile.o * Math.exp(-(d * d) / 0.5);
    const lt = pile.fold ? 0.3 : scrub;
    p.lift += (lt - p.lift) * 0.2;
    // A fanned card moves by transform only: its light (highlight, glare position) stays at
    // rest, since every change of light re-rasters the card and a fan changes several a frame.
    p.h += ((pile.fold ? 0.7 : 0) - p.h) * 0.2;
    const trx = -(pile.py - 0.5) * 12 * p.lift;
    const tryy = clamp(d * 9, -12, 12) * p.lift;
    p.rx += (trx - p.rx) * 0.2;
    p.ry += (tryy - p.ry) * 0.2;
    p.gx += (30 - p.gx) * 0.25;
    p.gy += (18 - p.gy) * 0.25;
    const fanRot = (j - (n - 1) / 2) * 0.9 * (1 - p.lift);
    const rt = lerp(jitter(id), fanRot, pile.o);
    p.rv = (p.rv + (rt - p.rot) * 0.14) * 0.8;
    p.rot += p.rv;
    // Order changes only when the pointed card does: a z-index that followed the lift would
    // change every frame and re-sort the layers each time.
    const isOpen = pile.o > 0.02;
    const isPointed = isOpen && j === Math.round(pile.fs);
    p.pz = (isOpen ? Z_OPEN_PILE : 1) + j + (isPointed ? n : 0);
    return p.home || !isSlotAtRest || isMemberMoving(p, lt, trx, tryy, rt);
  }

  private springHome(p: Phys): void {
    p.pvx = (p.pvx + -p.x * 0.09) * 0.74;
    p.pvy = (p.pvy + -p.y * 0.09) * 0.74;
    p.x += p.pvx;
    p.y += p.pvy;
    p.ax += p.pvx;
    p.ay += p.pvy;
    const isAway =
      Math.abs(p.x) >= 0.3 ||
      Math.abs(p.y) >= 0.3 ||
      Math.abs(p.pvx) >= 0.05 ||
      Math.abs(p.pvy) >= 0.05;
    if (isAway) return;
    p.x = 0;
    p.y = 0;
    p.pvx = 0;
    p.pvy = 0;
    p.home = false;
  }

  /** Advance one frame at time `now` (ms). Returns whether anything is still moving. */
  /**
   * Advances the simulation to `now` (ms) in fixed steps of `STEP_MS`, so motion runs at the
   * same speed whatever the display's refresh rate (it switches between 60 and 120 Hz on
   * phones); `view` then blends the last two steps for the frame in between. Returns whether
   * anything still moves.
   */
  tick(now: number): boolean {
    const gap = now - this.lastNow;
    this.lastNow = now;
    // After an idle spell the loop restarts: one step, not a catch-up burst.
    this.acc += gap > IDLE_GAP_MS ? STEP_MS : gap;
    let steps = 0;
    while (this.acc >= STEP_MS && steps < MAX_STEPS) {
      this.keepPrevious();
      this.wasActive = this.step(now);
      this.acc -= STEP_MS;
      steps += 1;
    }
    // A frame that fell far behind drops the time it cannot catch up on.
    if (steps === MAX_STEPS) this.acc = Math.min(this.acc, STEP_MS);
    this.alpha = this.acc / STEP_MS;
    return this.wasActive;
  }

  /**
   * The card's state for drawing: between the last two steps, by how far the frame is into the
   * next one ($s = s_{prev} + \alpha (s_{cur} - s_{prev})$ for every drawn quantity).
   */
  view(id: string): Phys {
    const p = this.ph(id);
    const prev = this.prev.get(id);
    // A card at rest draws as it is; blending is for cards in motion only.
    if (!prev || !p.live || this.alpha >= 1) return p;
    // One reused object per card: the caller reads it at once, and nothing is allocated per
    // frame (a fresh copy per card per frame showed up as garbage collection in profiles).
    let out = this.viewOut.get(id);
    if (!out) {
      out = { ...p };
      this.viewOut.set(id, out);
    }
    Object.assign(out, p);
    for (const k of DRAWN) out[k] = prev[k] + (p[k] - prev[k]) * this.alpha;
    return out;
  }

  private keepPrevious(): void {
    // Every card, at rest too: one that starts moving must blend from where it was.
    for (const [id, p] of this.phys) {
      let prev = this.prev.get(id);
      if (!prev) {
        prev = { ...p };
        this.prev.set(id, prev);
      }
      for (const k of DRAWN) prev[k] = p[k];
    }
  }

  /** One fixed step of every spring. */
  private step(now: number): boolean {
    this.updateIntent(now);
    let isActive = this.intent !== undefined;
    for (const { pile } of this.allPiles()) isActive = this.tickPile(pile) || isActive;
    const armed = this.armedPile();
    for (const [id, p] of this.phys) {
      const meta = this.meta.get(id);
      const loc = this.locs.get(id);
      const pile = loc && this.piles[loc.sec][loc.k];
      if (!meta || !loc || !pile) continue;
      const isMoving =
        pile.ids.length > 1
          ? this.tickMember(id, p, meta, pile, loc.j)
          : this.tickFree(id, p, meta, pile === armed);
      p.live =
        isMoving || p.drag || p.lift > 0.01 || Math.abs(p.rx) > 0.05 || Math.abs(p.ry) > 0.05;
      isActive = isMoving || isActive;
    }
    return isActive;
  }

  /** Pointer position on a card rect, clamped to [0, 1]. */
  static local(e: PointerSample, r: BoxSample): Point {
    return {
      x: clamp01((e.clientX - r.left) / r.width),
      y: clamp01((e.clientY - r.top) / r.height),
    };
  }

  down(id: string, e: PointerSample, slot: BoxSample): void {
    const p = this.ph(id);
    p.drag = true;
    p.home = false;
    p.hover = true;
    p.lcx = e.clientX;
    p.lcy = e.clientY;
    p.pid = e.pointerId;
    const at = CardTable.local(e, slot);
    p.px = at.x;
    p.py = at.y;
    this.zc += 1;
    p.z = this.zc;
    this.dragId = id;
    this.hoverId = undefined;
    this.intent = undefined;
  }

  /** Pointer moved while dragging a card; follows it at layout scale. */
  dragMove(id: string, e: PointerSample): void {
    const p = this.ph(id);
    if (e.pointerId !== p.pid) return;
    const dx = (e.clientX - p.lcx) / this.sc;
    const dy = (e.clientY - p.lcy) / this.sc;
    p.lcx = e.clientX;
    p.lcy = e.clientY;
    p.x += dx;
    p.y += dy;
    p.ax += dx;
    p.ay += dy;
  }

  hoverMove(id: string, e: PointerSample, slot: BoxSample): void {
    const p = this.ph(id);
    const at = CardTable.local(e, slot);
    p.px = at.x;
    p.py = at.y;
    p.hover = true;
    this.hoverId = id;
  }

  /**
   * Drag ended. `isStillOver` is whether a mouse pointer is still inside the slot. A drop
   * with the stacking zone held puts the card on top of that pile.
   */
  end(id: string, wasCancelled: boolean, isStillOver: boolean): void {
    const p = this.ph(id);
    const loc = this.locs.get(id);
    const it = this.intent;
    if (!wasCancelled && loc && it && this.isFoldArmed) this.foldInto(id, loc.sec, loc.k, it.k);
    this.setIntent(undefined);
    p.drag = false;
    if (this.dragId === id) this.dragId = undefined;
    if (wasCancelled || this.m.ret) {
      p.home = true;
      p.pvx = 0;
      p.pvy = 0;
    }
    const isSingle = !p.pile;
    p.hover = isStillOver && isSingle;
    if (p.hover) this.hoverId = id;
  }

  leave(id: string): void {
    const p = this.ph(id);
    if (p.drag) return;
    p.hover = false;
    if (this.hoverId === id) this.hoverId = undefined;
  }

  sendHome(id: string): void {
    const p = this.ph(id);
    p.home = true;
    p.pvx = 0;
    p.pvy = 0;
  }

  /** Re-anchors a card whose home slot moved by (dx, dy) so it does not jump on screen. */
  shiftHome(id: string, dx: number, dy: number): void {
    const p = this.phys.get(id);
    if (!p) return;
    if (id === this.dragId) {
      p.x -= dx;
      p.y -= dy;
    } else {
      p.bx -= dx;
      p.by -= dy;
    }
  }

  /** Number of slots in use in `sec`. */
  used(sec: SectionId): number {
    return this.piles[sec].length;
  }

  static slotId(sec: SectionId, k: number): string | undefined {
    return SLOTS[sec][k];
  }
}

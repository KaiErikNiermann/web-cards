// Card-table physics: spring-damped drag, sway, slot reflow, push-away and the hover stack.
// A line-for-line port of the export's logic class; every constant is the original's.

import {
  DECKS,
  PRESETS,
  REFLOW_SECTIONS,
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
}

export interface CardMeta {
  readonly sec: SectionId;
  readonly w: number;
  readonly h: number;
  readonly stack: boolean;
  readonly i: number;
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface StackState {
  active: boolean;
  /** Pointer position along the pile in card indices, and its smoothed follower. */
  f: number;
  fs: number;
  py: number;
  touch: boolean;
}

/** Pointer data the physics reads; a subset of `PointerEvent` plus the card's slot rect. */
export interface PointerSample {
  readonly clientX: number;
  readonly clientY: number;
  readonly pointerId: number;
  readonly pointerType: string;
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
const clamp01 = (v: number): number => clamp(v, 0, 1);

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
  };
}

function initialOrder(): Record<SectionId, string[]> {
  const entries = SECTION_IDS.map((s) => [s, DECKS[s].map((c) => c.id)] as const);
  return Object.fromEntries(entries) as Record<SectionId, string[]>;
}

const DEF_IDS: Readonly<Record<SectionId, readonly string[]>> = initialOrder();

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

export class CardTable {
  private zc = 1;
  readonly m: Material;
  readonly order = initialOrder();
  readonly phys = new Map<string, Phys>();
  readonly meta = new Map<string, CardMeta>();
  readonly homes = new Map<string, Point>();
  readonly stack: StackState = { active: false, f: 0, fs: 0, py: 0.5, touch: false };
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
  }

  ph(id: string): Phys {
    let p = this.phys.get(id);
    if (!p) {
      p = newPhys();
      this.phys.set(id, p);
    }
    return p;
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
    for (const s of SECTION_IDS) this.order[s] = [...DEF_IDS[s]];
    for (const p of this.phys.values()) {
      p.home = true;
      p.pvx = 0;
      p.pvy = 0;
    }
  }

  /** Offset from a card's own home slot to the slot its place in the order points at. */
  slotTarget(id: string): Point {
    const meta = this.meta.get(id);
    const home = this.homes.get(id);
    if (!meta || !home) return { x: 0, y: 0 };
    const k = this.order[meta.sec].indexOf(id);
    const targetId = DEF_IDS[meta.sec][k];
    const th = targetId === undefined ? undefined : this.homes.get(targetId);
    return th ? { x: th.x - home.x, y: th.y - home.y } : { x: 0, y: 0 };
  }

  private tickStacked(p: Phys, meta: CardMeta): boolean {
    const st = this.stack;
    const d = meta.i - st.fs;
    const lt = st.active ? Math.exp(-(d * d) / 0.5) : 0;
    p.lift += (lt - p.lift) * 0.2;
    p.h = p.lift;
    const trx = -(st.py - 0.5) * 12 * p.lift;
    const tryy = clamp(d * 9, -12, 12) * p.lift;
    p.rx += (trx - p.rx) * 0.2;
    p.ry += (tryy - p.ry) * 0.2;
    p.gx += (50 - d * 40 - p.gx) * 0.25;
    p.gy += (st.py * 100 - p.gy) * 0.25;
    return (
      Math.abs(lt - p.lift) > 0.003 || Math.abs(trx - p.rx) > 0.02 || Math.abs(tryy - p.ry) > 0.02
    );
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
    // nosemgrep: pc3-tailwind-important-modifier -- boolean negation, not a Tailwind class
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

  private tickFree(id: string, p: Phys, meta: CardMeta): boolean {
    const m = this.m;
    const sway = m.sway / 100;
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
    const ht = p.hover || p.drag ? 1 : 0;
    const lt = liftTarget(p);
    p.h += (ht - p.h) * 0.15;
    p.lift += (lt - p.lift) * 0.18;
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
      isApart(ht, p.h, 0.003) ||
      isApart(lt, p.lift, 0.003) ||
      isApart(p.rot, 0, 0.02) ||
      isApart(p.rv, 0, 0.01) ||
      isApart(p.vel, 0, 0.01) ||
      isApart(p.vely, 0, 0.01) ||
      isApart(trx, p.rx, 0.02) ||
      isApart(tryy, p.ry, 0.02) ||
      isApart(tgx, p.gx, 0.1) ||
      isApart(tgy, p.gy, 0.1) ||
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

  /** Advance one frame. Returns whether anything is still moving. */
  tick(): boolean {
    const st = this.stack;
    st.fs += (st.f - st.fs) * 0.3;
    let isActive = Math.abs(st.f - st.fs) > 0.002;
    for (const [id, p] of this.phys) {
      const meta = this.meta.get(id);
      if (!meta) continue;
      const isMoving = meta.stack ? this.tickStacked(p, meta) : this.tickFree(id, p, meta);
      isActive ||= isMoving;
    }
    return isActive;
  }

  /** Pointer position on a card rect, clamped to [0, 1]. */
  static local(e: PointerSample, r: DOMRect): Point {
    return {
      x: clamp01((e.clientX - r.left) / r.width),
      y: clamp01((e.clientY - r.top) / r.height),
    };
  }

  down(id: string, e: PointerSample, slot: DOMRect): void {
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
  }

  /** Slot reflow: move the dragged card to the nearest home within $0.55\,w$ of its centre. */
  reorder(id: string): void {
    const meta = this.meta.get(id);
    const p = this.phys.get(id);
    const home = this.homes.get(id);
    // nosemgrep: pc3-tailwind-important-modifier -- boolean negation, not a Tailwind class
    if (!meta || !p || !home || !REFLOW_SECTIONS.has(meta.sec)) return;
    const ord = this.order[meta.sec];
    const ids = DEF_IDS[meta.sec];
    const cx = home.x + p.bx + p.x;
    const cy = home.y + p.by + p.y;
    let best = -1;
    let bd = 1e9;
    for (const [k, slotId] of ids.entries()) {
      const h = this.homes.get(slotId);
      if (!h) continue;
      const d = Math.hypot(h.x - cx, h.y - cy);
      if (d >= bd) continue;
      bd = d;
      best = k;
    }
    if (best < 0 || bd > meta.w * 0.55 || ord[best] === id) return;
    ord.splice(ord.indexOf(id), 1);
    ord.splice(best, 0, id);
    const nb = this.slotTarget(id);
    p.x += p.bx - nb.x;
    p.y += p.by - nb.y;
    p.bx = nb.x;
    p.by = nb.y;
  }

  /** Pointer moved while dragging a card; follows it at layout scale and reflows the row. */
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
    if (this.m.ret) this.reorder(id);
  }

  hoverMove(id: string, e: PointerSample, slot: DOMRect): void {
    const p = this.ph(id);
    const at = CardTable.local(e, slot);
    p.px = at.x;
    p.py = at.y;
    p.hover = true;
    this.hoverId = id;
  }

  /** Drag ended. `isStillOver` is whether a mouse pointer is still inside the slot. */
  end(id: string, wasCancelled: boolean, isStillOver: boolean): void {
    const p = this.ph(id);
    p.drag = false;
    if (this.dragId === id) this.dragId = undefined;
    if (wasCancelled || this.m.ret) {
      p.home = true;
      p.pvx = 0;
      p.pvy = 0;
    }
    p.hover = isStillOver;
    if (isStillOver) this.hoverId = id;
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

  /** Stack pointer at layout coordinates (x, y) inside the pile row. */
  stackPointer(x: number, y: number, step: number, liftPad: number, h: number): void {
    const st = this.stack;
    const n = DECKS.stack.length;
    st.f = clamp((x - step / 2) / step, 0, n - 1);
    if (!st.active) st.fs = st.f;
    st.py = clamp01((y - liftPad) / h);
    st.active = true;
  }
}

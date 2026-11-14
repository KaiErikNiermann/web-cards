// Maps simulation state to the custom properties cards.css consumes. Pure: no DOM access
// except `setVars`, which writes only the properties whose value changed.

import { FACE, type CardDef, type Geometry } from "./data";
import type { Material, Phys } from "./physics";
import type { ShowFrame } from "./showcase";

/** Rounds to two decimals, as the export did for every emitted style value. */
const f = (n: number): number => Math.round(n * 100) / 100;
const px = (n: number): string => `${String(f(n))}px`;
const deg = (n: number): string => `${String(f(n))}deg`;
const pct = (n: number): string => `${String(f(n))}%`;
/** An alpha in [0, 1] as a `color-mix` percentage. */
const alpha = (a: number): string => pct(f(a) * 100);

/** z-index of the card being dragged: above every card ever raised by a click. */
const Z_DRAGGING = 9999;
/** z-index of the showcased card: above the dragged one. */
const Z_SHOW = Z_DRAGGING + 1;

export type Vars = Readonly<Record<`--${string}`, string>>;

/** The material response as numbers, shared by the CSS and WebGL renderers. */
export interface MaterialParams {
  /** Glare lobe alpha at its centre and at radius `r1`, and its radii as % of closest-side. */
  readonly a1: number;
  readonly a1Mid: number;
  readonly r1: number;
  readonly r2: number;
  /** Clearcoat sheen alpha at the start of the glare gradient. */
  readonly sheen: number;
  /** Glare blend: soft-light for rough finishes, overlay otherwise. */
  readonly isSoftLight: boolean;
  readonly hotA: number;
  readonly hotR: number;
  readonly edge: number;
  readonly edgeTop: number;
  readonly grainOp: number;
  readonly contrast: number;
  readonly saturate: number;
  /** Foil strength in [0, 1]. */
  readonly foil: number;
}

export interface MaterialView {
  readonly params: MaterialParams;
  readonly vars: Vars;
  readonly grainHidden: boolean;
  readonly foil: number;
  readonly hotLobe: boolean;
}

/**
 * Material response shared by every card. With reflectance $k$ and roughness $r$: lobe alpha
 * $a_1 = k(0.85 - 0.6r)$ over radii $R_1 = 6 + 16r$, $R_2 = 38 + 57r$; hot spot
 * $a_h = 0.8\,k(1-r)^2$ over $7 + 22r$; clearcoat $c = k(1-r)$.
 */
export function materialParams(m: Material): MaterialParams {
  const refl = m.refl / 100;
  const r = m.rough / 100;
  const foil = m.foil / 100;
  const clear = refl * (1 - r);
  const a1 = refl * (0.85 - 0.6 * r);
  return {
    a1,
    a1Mid: a1 * 0.3,
    r1: 6 + 16 * r,
    r2: 38 + 57 * r,
    sheen: clear * 0.14,
    isSoftLight: r > 0.6,
    hotA: refl * (1 - r) * (1 - r) * 0.8,
    hotR: 7 + 22 * r,
    edge: 0.06 + clear * 0.3,
    edgeTop: 0.1 + clear * 0.35,
    grainOp: (m.grain / 100) * 0.55,
    contrast: 1 - r * 0.08,
    saturate: 1 - r * 0.12 + foil * 0.08,
    foil,
  };
}

export function materialView(m: Material): MaterialView {
  const p = materialParams(m);
  return {
    params: p,
    grainHidden: p.grainOp < 0.01,
    foil: p.foil,
    hotLobe: p.hotA > 0.01,
    vars: {
      "--m-a1": alpha(p.a1),
      "--m-a1-mid": alpha(p.a1Mid),
      "--m-r1": pct(p.r1),
      "--m-r2": pct(p.r2),
      "--m-sheen": alpha(p.sheen),
      "--m-blend": p.isSoftLight ? "soft-light" : "overlay",
      "--m-hot-a": alpha(p.hotA),
      "--m-hot-r": pct(p.hotR),
      "--m-edge": alpha(p.edge),
      "--m-edge-top": alpha(p.edgeTop),
      "--m-grain-op": String(f(p.grainOp)),
      "--m-contrast": String(f(p.contrast)),
      "--m-saturate": String(f(p.saturate)),
    },
  };
}

/**
 * Per-frame custom properties, grouped by the element that reads them. Each group is written
 * on that element only; with the properties registered as non-inherited (cards.css), a change
 * restyles that element and not the card's whole face.
 */
export interface CardVars {
  readonly slot: Vars;
  readonly card: Vars;
  readonly art: Vars;
  readonly foil: Vars;
  readonly glare: Vars;
  readonly hot: Vars;
  /** Position of the glare and hot-spot lobes, written on both spot elements. */
  readonly spot: Vars;
}

export interface CardView {
  readonly vars: CardVars;
  readonly foilHidden: boolean;
  readonly hotHidden: boolean;
  /** Card size in layout px, for the physics' push radii and the trace outline. */
  readonly w: number;
  readonly h: number;
  readonly step: number;
  readonly pad: number;
}

export interface CardSize {
  readonly w: number;
  readonly h: number;
  /** Fan step of an open pile and the lift headroom above it. */
  readonly step: number;
  readonly pad: number;
}

/** Card size by kind; cardlets scale the fan step and lift headroom with their height. */
export function cardSize(c: CardDef, g: Geometry): CardSize {
  if (!c.mini) return { w: g.w, h: g.h, step: g.step, pad: g.liftPad };
  const k = g.mh / g.h;
  return { w: g.mw, h: g.mh, step: Math.round(g.step * k), pad: Math.round(g.liftPad * k) };
}

/** One card's per-frame state as numbers (layout px, degrees, opacities in [0, 1]). */
export interface CardFrame extends CardSize {
  /** Slot translation from its layout position, and its stacking order. */
  readonly tx: number;
  readonly ty: number;
  readonly z: number;
  readonly rx: number;
  readonly ry: number;
  readonly rz: number;
  readonly skew: number;
  readonly scale: number;
  readonly lift: number;
  readonly isPile: boolean;
  readonly isDrag: boolean;
  /** Shown in the showcase (src/showcase.ts). */
  readonly isShown: boolean;
  /** Art parallax offset. */
  readonly artX: number;
  readonly artY: number;
  readonly foilOp: number;
  /** Foil background position, in % (CSS background-position semantics). */
  readonly foilX: number;
  readonly foilY: number;
  readonly glareOp: number;
  readonly hotOp: number;
  /** Lobe centre in whole px from the card's top-left corner. */
  readonly spotX: number;
  readonly spotY: number;
}

/** Card state for frame rendering; the single source of the simulation-to-look mapping. */
export function cardFrame(
  c: CardDef,
  p: Phys,
  g: Geometry,
  mat: MaterialView,
  show?: ShowFrame,
): CardFrame {
  const size = cardSize(c, g);
  const face = c.mini ? FACE.mini : FACE.full;
  const tx = p.bx + p.x + p.ox;
  const ty = p.pile ? p.by + p.y + p.oy - p.lift * size.pad : p.by + p.y + p.oy;
  const rest = p.pile ? p.pz : p.z;
  const scale = p.pile ? 1 + p.lift * 0.05 : 1 + p.lift * 0.045 - p.sink * 0.14;
  // The showcase carries the card from where the physics has it to the middle of the screen.
  const t = show?.t ?? 0;
  const dragZ = p.drag ? Z_DRAGGING : rest;
  return {
    ...size,
    tx: show ? tx + (show.x - tx) * t : tx,
    ty: show ? ty + (show.y - ty) * t : ty,
    z: show ? Z_SHOW : dragZ,
    rx: p.rx,
    ry: p.ry + (show?.ry ?? 0),
    rz: p.rot * (1 - Math.min(1, t)),
    skew: p.pile ? 0 : -p.rot * 0.35 * (1 - Math.min(1, t)),
    scale: show ? scale + (show.scale - scale) * t : scale,
    lift: p.lift,
    isPile: p.pile,
    isDrag: p.drag,
    isShown: show !== undefined,
    // No parallax in a pile: moving the art would repaint each tilting card of a fan.
    artX: p.pile ? 0 : -p.ry * face.parallax,
    artY: p.pile ? 0 : p.rx * face.parallax,
    foilOp: mat.foil * (0.22 + 0.6 * p.h),
    foilX: 50 + (p.px - 0.5) * 90 * p.h + p.rot * 3 + p.ry * 2,
    foilY: 50 + (p.py - 0.5) * 90 * p.h + p.rx * 2,
    glareOp: 0.25 + 0.75 * p.h,
    hotOp: p.h * (mat.hotLobe ? 1 : 0),
    // Whole px: finer moves are invisible, and on an unlit card each one repaints.
    spotX: Math.round((p.gx / 100) * size.w),
    spotY: Math.round((p.gy / 100) * size.h),
  };
}

export function cardView(
  c: CardDef,
  p: Phys,
  g: Geometry,
  mat: MaterialView,
  show?: ShowFrame,
): CardView {
  const fr = cardFrame(c, p, g, mat, show);
  const { w, h } = fr;
  const face = c.mini ? FACE.mini : FACE.full;
  const isFoilHidden = fr.foilOp < 0.01;
  const isHotHidden = fr.hotOp < 0.01;
  return {
    w,
    h,
    step: fr.step,
    pad: fr.pad,
    foilHidden: isFoilHidden,
    hotHidden: isHotHidden,
    vars: {
      slot: {
        "--tx": px(fr.tx),
        "--ty": px(fr.ty),
        "--z": String(fr.z),
        "--w": px(w),
        "--h": px(h),
        "--persp": px(w * 4),
        "--r": px(face.radius),
        "--bw": px(face.bw),
        "--bh": px(face.bh),
        "--face-k": String(f((w / face.bw) * 1000) / 1000),
      },
      card: {
        "--rz": deg(fr.rz),
        "--skew": deg(fr.skew),
        "--scale": String(f(fr.scale)),
        "--cursor": p.drag && !p.pile ? "grabbing" : "grab",
        "--rx": deg(fr.rx),
        "--ry": deg(fr.ry),
        "--lift": String(f(fr.lift)),
      },
      art: { "--art-x": px(fr.artX), "--art-y": px(fr.artY) },
      foil: isFoilHidden
        ? {}
        : {
            "--foil-op": String(f(fr.foilOp)),
            "--foil-x": pct(fr.foilX),
            "--foil-y": pct(fr.foilY),
          },
      glare: { "--glare-op": String(f(fr.glareOp)) },
      spot: { "--spot-x": px(fr.spotX), "--spot-y": px(fr.spotY) },
      // Hidden layers keep their last values; nothing is written until they show again.
      hot: isHotHidden ? {} : { "--hot-op": String(f(fr.hotOp)) },
    },
  };
}

const written = new WeakMap<HTMLElement, Map<string, string>>();

/** Sets custom properties on `el`, skipping values identical to the last write. */
export function setVars(el: HTMLElement, vars: Vars): void {
  let last = written.get(el);
  if (!last) {
    last = new Map();
    written.set(el, last);
  }
  for (const [k, v] of Object.entries(vars)) {
    if (last.get(k) === v) continue;
    last.set(k, v);
    el.style.setProperty(k, v);
  }
}

/** Sets `el`'s text only when it differs: rewriting equal text still replaces the text node. */
export function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

/** Sets `el.hidden` only when it differs. */
export function setHidden(el: HTMLElement, isHidden: boolean): void {
  if (el.hidden !== isHidden) el.hidden = isHidden;
}

/** Sets an attribute only when its value differs. */
export function setAttr(el: Element, name: string, value: string): void {
  if (el.getAttribute(name) !== value) el.setAttribute(name, value);
}

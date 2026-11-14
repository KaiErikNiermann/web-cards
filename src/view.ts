// Maps simulation state to the custom properties cards.css consumes. Pure: no DOM access
// except `setVars`, which writes only the properties whose value changed.

import { FACE, type CardDef, type Geometry } from "./data";
import type { Material, Phys } from "./physics";

/** Rounds to two decimals, as the export did for every emitted style value. */
const f = (n: number): number => Math.round(n * 100) / 100;
const px = (n: number): string => `${String(f(n))}px`;
const deg = (n: number): string => `${String(f(n))}deg`;
const pct = (n: number): string => `${String(f(n))}%`;
/** An alpha in [0, 1] as a `color-mix` percentage. */
const alpha = (a: number): string => pct(f(a) * 100);

/** z-index of the card being dragged: above every card ever raised by a click. */
const Z_DRAGGING = 9999;

export type Vars = Readonly<Record<`--${string}`, string>>;

export interface MaterialView {
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
export function materialView(m: Material): MaterialView {
  const refl = m.refl / 100;
  const r = m.rough / 100;
  const foil = m.foil / 100;
  const grain = m.grain / 100;
  const a1 = refl * (0.85 - 0.6 * r);
  const hotA = refl * (1 - r) * (1 - r) * 0.8;
  const clear = refl * (1 - r);
  const grainOp = grain * 0.55;
  return {
    grainHidden: grainOp < 0.01,
    foil,
    hotLobe: hotA > 0.01,
    vars: {
      "--m-a1": alpha(a1),
      "--m-a1-mid": alpha(a1 * 0.3),
      "--m-r1": pct(6 + 16 * r),
      "--m-r2": pct(38 + 57 * r),
      "--m-sheen": alpha(clear * 0.14),
      "--m-blend": r > 0.6 ? "soft-light" : "overlay",
      "--m-hot-a": alpha(hotA),
      "--m-hot-r": pct(7 + 22 * r),
      "--m-edge": alpha(0.06 + clear * 0.3),
      "--m-edge-top": alpha(0.1 + clear * 0.35),
      "--m-grain-op": String(f(grainOp)),
      "--m-contrast": String(f(1 - r * 0.08)),
      "--m-saturate": String(f(1 - r * 0.12 + foil * 0.08)),
    },
  };
}

export interface CardView {
  readonly vars: Vars;
  readonly foilHidden: boolean;
  readonly hotHidden: boolean;
  /** Card size in layout px, for the physics' push radii and the trace outline. */
  readonly w: number;
  readonly h: number;
  readonly step: number;
  readonly pad: number;
  readonly radius: number;
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

function placement(p: Phys, pad: number): Vars {
  if (p.pile) {
    return {
      "--tx": px(p.bx + p.x + p.ox),
      "--ty": px(p.by + p.y + p.oy - p.lift * pad),
      "--z": String(p.drag ? Z_DRAGGING : p.pz),
      "--rz": deg(p.rot),
      "--skew": "0deg",
      "--scale": String(f(1 + p.lift * 0.05)),
      "--cursor": "grab",
    };
  }
  return {
    "--tx": px(p.bx + p.x + p.ox),
    "--ty": px(p.by + p.y + p.oy),
    "--z": String(p.drag ? Z_DRAGGING : p.z),
    "--rz": deg(p.rot),
    "--skew": deg(-p.rot * 0.35),
    "--scale": String(f(1 + p.lift * 0.045 - p.sink * 0.14)),
    "--cursor": p.drag ? "grabbing" : "grab",
  };
}

export function cardView(c: CardDef, p: Phys, g: Geometry, mat: MaterialView): CardView {
  const { w, h, step, pad } = cardSize(c, g);
  const face = c.mini ? FACE.mini : FACE.full;
  const foilOp = mat.foil * (0.22 + 0.6 * p.h);
  const hotOp = p.h * (mat.hotLobe ? 1 : 0);
  return {
    w,
    h,
    step,
    pad,
    radius: face.radius,
    foilHidden: foilOp < 0.01,
    hotHidden: hotOp < 0.01,
    vars: {
      ...placement(p, pad),
      "--w": px(w),
      "--h": px(h),
      "--persp": px(w * 4),
      "--r": px(face.radius),
      "--rx": deg(p.rx),
      "--ry": deg(p.ry),
      "--lift": String(f(p.lift)),
      "--bw": px(face.bw),
      "--bh": px(face.bh),
      "--face-k": String(f((w / face.bw) * 1000) / 1000),
      "--art-x": px(-p.ry * face.parallax),
      "--art-y": px(p.rx * face.parallax),
      "--gx": pct(p.gx),
      "--gy": pct(p.gy),
      "--foil-op": String(f(foilOp)),
      "--foil-x": pct(50 + (p.px - 0.5) * 90 * p.h + p.rot * 3 + p.ry * 2),
      "--foil-y": pct(50 + (p.py - 0.5) * 90 * p.h + p.rx * 2),
      "--glare-angle": deg(160 + p.ry * 3),
      "--glare-op": String(f(0.25 + 0.75 * p.h)),
      "--hot-op": String(f(hotOp)),
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

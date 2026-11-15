// WebGL rendering of the card table, switched on with `?gl`. The DOM cards stay in place for
// layout, hit-testing and accessibility but paint nothing; each section's row gets a WebGL2
// canvas that scrolls with it, and a fixed canvas over the page draws cards that have left
// their row (dragged or gliding home). Each card is one quad; its look is computed by the same
// view.ts functions that feed the CSS renderer.

import BezierEasing from "bezier-easing";

import grainUrl from "../assets/grain.png";
import { FACE, type Geometry, type SectionId } from "../data";
import type { CardRefs, SectionRefs } from "../dom";
import type { CardTable, Point } from "../physics";
import type { ShowFrame } from "../showcase";
import { cardFrame, materialView, type CardFrame, type MaterialView } from "../view";
import { hasDomParts } from "./bake";
import { drawableFaces, hasDrawableCanvas } from "./drawable";
import { isOverlayOnly, raisedAboveOverlay } from "./layering";
import type { FaceImages, FaceSource } from "./faces";
import { watchLiveFaces } from "./live";
import { paint as paintText } from "./livetext";
import { snapshotFaces } from "./raster";
import { Surface, type CardDraw, type CardImages } from "./surface";
import { readTokens, type GlTokens } from "./tokens";

export interface GlOptions {
  readonly root: HTMLElement;
  readonly table: CardTable;
  readonly sections: readonly SectionRefs[];
  readonly cards: readonly CardRefs[];
  readonly geometry: () => Geometry;
  readonly layoutPos: (el: HTMLElement) => Point;
  /** The showcase transform of a card, if it is the one shown. */
  readonly show: (c: CardRefs) => ShowFrame | undefined;
  /** Whether the simulation's own frame is pending; it then calls `frame` itself. */
  readonly isSimPending: () => boolean;
}

export interface GlRenderer {
  /** Resolves once every face is rasterized and the canvases have taken over. */
  readonly ready: Promise<void>;
  /** Hybrid rendering (`?gl&hybrid` with snapshot faces): CSS at rest, WebGL in motion. */
  readonly isHybrid: boolean;
  /** Draws the frame at `now` (rAF time); the simulation calls it after each step. */
  frame(now: number): void;
  /** Redraws everything on the next frame (material, geometry or layout changed). */
  invalidate(): void;
  /** Rasterizes a card again at the showcase's largest scale, so it stays sharp when grown. */
  upscale(id: string): void;
}

/** Counters over the last second, published on the root as `data-gl-stats` (JSON). */
interface GlStats {
  frames: number;
  /** JS time in `frame`, ms per frame. */
  ms: number;
  /** Section canvases redrawn and cards drawn, per frame. */
  sections: number;
  cards: number;
  /** Most cards on the overlay canvas in one frame. */
  overlayMax: number;
  /** Cards drawn on section canvases that were off screen (should stay 0 at rest). */
  hiddenCards: number;
}

const newStats = (): GlStats => ({
  frames: 0,
  ms: 0,
  sections: 0,
  cards: 0,
  overlayMax: 0,
  hiddenCards: 0,
});

// TEMP: draw-cost experiment switches.
const EXTRA = ["dup", "fill", "nodraw"].find((k) => location.search.includes(`gl${k}`)) ?? "";

/** Hybrid: how long a card stays on WebGL after it stops moving, so it does not flap. */
const HYBRID_SETTLE_MS = 250;
const easeInOut = BezierEasing(0.42, 0, 0.58, 1);
const sweepEase = BezierEasing(0.5, 0, 0.3, 1);

/** `animation: kb 16s ease-in-out infinite alternate`: scale 1.04 to 1.16, shift to (-4%, 2.5%). */
function kenBurns(t: number): [number, number, number] {
  const cycle = t / 16;
  const u = cycle % 1;
  const e = easeInOut(Math.floor(cycle) % 2 === 0 ? u : 1 - u);
  return [1.04 + 0.12 * e, -0.04 * e, 0.025 * e];
}

/** `animation: sweep 4.6s`: -75% to 75% over the first 55%, then held. */
function sweepAt(t: number): number {
  const u = (t / 4.6) % 1;
  return u >= 0.55 ? 0.75 : -0.75 + 1.5 * sweepEase(u / 0.55);
}

/** `animation: ember 2.8s ease-in-out`: opacity 0.25 to 0.6 and back. */
function emberAt(t: number): number {
  const u = (t / 2.8) % 1;
  const e = easeInOut((u < 0.5 ? u : 1 - u) * 2);
  return 0.25 + 0.35 * e;
}

const FX = { orbit: 1, trace: 2, dual: 3, live: 4 } as const;

/** rotateX . rotateY . rotateZ . skewX . scale as a column-major 3x3 (CSS's y-down axes). */
function cardMatrix(fr: CardFrame): Float32Array {
  const rad = Math.PI / 180;
  const [cx, sx] = [Math.cos(fr.rx * rad), Math.sin(fr.rx * rad)];
  const [cy, sy] = [Math.cos(fr.ry * rad), Math.sin(fr.ry * rad)];
  const [cz, sz] = [Math.cos(fr.rz * rad), Math.sin(fr.rz * rad)];
  const k = Math.tan(fr.skew * rad);
  // Rx . Ry
  const a = [
    [cy, 0, sy],
    [sx * sy, cx, -sx * cy],
    [-cx * sy, sx, cx * cy],
  ];
  // . Rz . skewX . scale
  const b = [
    [cz, cz * k - sz, 0],
    [sz, sz * k + cz, 0],
    [0, 0, 1],
  ];
  const out = new Float32Array(9);
  for (let col = 0; col < 3; col += 1)
    for (let row = 0; row < 3; row += 1) {
      let s = 0;
      for (let i = 0; i < 3; i += 1) s += (a[row]?.[i] ?? 0) * (b[i]?.[col] ?? 0);
      out[col * 3 + row] = s * (col < 2 ? fr.scale : 1);
    }
  return out;
}

/**
 * Projected bounds of the quad $[\pm(w/2 + m), \pm(h/2 + m)]$ around the card centre: each
 * corner $p = M(x, y, 0)$ lands at $p_{xy} / (1 - p_z / d)$, as in the vertex shader.
 */
function quadBox(
  m: Float32Array,
  hw: number,
  hh: number,
  d: number,
): [number, number, number, number] {
  const box: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of [
    [-hw, -hh],
    [hw, -hh],
    [-hw, hh],
    [hw, hh],
  ] as const) {
    const px = (m[0] ?? 0) * x + (m[3] ?? 0) * y;
    const py = (m[1] ?? 0) * x + (m[4] ?? 0) * y;
    const w = 1 - ((m[2] ?? 0) * x + (m[5] ?? 0) * y) / d;
    box[0] = Math.min(box[0], px / w);
    box[1] = Math.min(box[1], py / w);
    box[2] = Math.max(box[2], px / w);
    box[3] = Math.max(box[3], py / w);
  }
  return box;
}

/** The card's two box shadows (cards.css .card --_shadow), the top one first. */
/** The card's two box shadows (x, y, blur, alpha); a flat card has CSS's `data-flat` one. */
function shadows(fr: CardFrame, isPlain = false): [number[], number[]] {
  if (isPlain) return [[0, 1, 2, 0.45], [0, 0, 0, 0]];
  if (fr.isPile)
    return [
      [-3, 0, 8, 0.35],
      [0, 6, 14, 0.42],
    ];
  return [
    [0, 2 + fr.lift * 18, 6 + fr.lift * 34, 0.38 + fr.lift * 0.18],
    [0, 1, 2, 0.45],
  ];
}

interface Placed {
  readonly c: CardRefs;
  readonly fr: CardFrame;
  readonly cx: number;
  readonly cy: number;
  /** The drawn quad's projected bounds around the centre: min x, min y, max x, max y. */
  readonly box: readonly [number, number, number, number];
  readonly margin: number;
  readonly m: Float32Array;
  readonly isAnimated: boolean;
}

/** What every card of one frame shares. */
interface FrameCtx {
  readonly mat: MaterialView;
  readonly t: GlTokens;
  readonly time: number;
}

/** How far a border effect reaches past the card. */
function fxReach(fx: CardRefs["def"]["fx"], t: GlTokens): number {
  switch (fx) {
    case "orbit": {
      return t.ringGlowPad + 3 * t.ringGlowBlur;
    }
    case "trace":
    case "dual": {
      return t.tracePad;
    }
    default: {
      return 0;
    }
  }
}

const byZ = (a: Placed, b: Placed): number => a.fr.z - b.fr.z;

/** Whether two placed cards' projected bounds overlap. */
const isOverlapping = (a: Placed, b: Placed): boolean =>
  a.cx + a.box[0] < b.cx + b.box[2] &&
  b.cx + b.box[0] < a.cx + a.box[2] &&
  a.cy + a.box[1] < b.cy + b.box[3] &&
  b.cy + b.box[1] < a.cy + a.box[3];

interface SectionSurface {
  readonly id: SectionId;
  readonly row: HTMLElement;
  readonly surface: Surface;
  view: [number, number];
  isVisible: boolean;
  /** Something changed while the canvas was off screen; redraw it when it shows again. */
  isStale: boolean;
  drawn: Set<string>;
  wasLive: boolean;
}

function sizeCanvas(canvas: HTMLCanvasElement, onSize: (cssW: number, cssH: number) => void): void {
  new ResizeObserver(([en]) => {
    if (!en) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(en.contentRect.width * dpr);
    const h = Math.round(en.contentRect.height * dpr);
    // The device-pixel box is exact on real screens, but under an emulated device scale factor
    // (Playwright, in both engines) it reports CSS px; trust it only when it agrees.
    const box = en.devicePixelContentBoxSize[0];
    const isExact =
      box !== undefined && Math.abs(box.inlineSize - w) <= 1 && Math.abs(box.blockSize - h) <= 1;
    canvas.width = isExact ? box.inlineSize : w;
    canvas.height = isExact ? box.blockSize : h;
    onSize(en.contentRect.width, en.contentRect.height);
  }).observe(canvas);
}

async function loadImage(url: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.src = url;
  await img.decode();
  return img;
}

export function mountGl(o: GlOptions): GlRenderer {
  const { root, table, cards } = o;
  const backend = faceBackend();
  root.dataset.glFaces = backend;
  const drawable = backend === "drawable" ? drawableFaces(root, onDrawn) : undefined;
  const source: FaceSource = drawable ?? snapshotFaces(root);
  /**
   * Hybrid (`?gl&hybrid`, snapshot faces only): cards draw in CSS at rest, where Firefox keeps
   * static cards cached, and on the overlay canvas only while they move or are showcased.
   */
  const isHybrid = !drawable && new URLSearchParams(location.search).has("hybrid");
  /** Hybrid: cards drawn by WebGL, until the time (ms) they go back to CSS. */
  const glUntil = new Map<string, number>();
  if (isHybrid) root.dataset.glHybrid = "";
  let faces: ReadonlyMap<string, FaceImages> = new Map();
  /** Geometry the faces were rasterized at; a change of card size rasterizes them again. */
  let rasterGeo: Geometry | undefined;
  let tokens: GlTokens | undefined;
  let sections: SectionSurface[] = [];
  let overlay: { surface: Surface; view: [number, number]; drawn: Set<string> } | undefined;
  let lastDraw = -1;
  /** Page scroll and the root's offset in the document, for culling cards off screen. */
  let scrollTop = scrollY;
  let rootTop = 0;
  /** Cards whose live text changed since the last frame. */
  const dirtyCards = new Set<string>();
  /** Section canvas origins in root layout px; read from layout only when it may have moved. */
  let origins = new Map<SectionSurface, Point>();
  let stats = newStats();
  /** Totals since load, for tests (`?gldebug` exposes them as `__glTotals`). */
  const totals = { frames: 0, ms: 0, sections: 0, cards: 0, hiddenCards: 0, overlayCards: 0 };
  if (location.search.includes("gldebug")) Reflect.set(globalThis, "__glTotals", totals);
  let statsAt = 0;
  let isForced = true;
  let loop = 0;
  /**
   * Cards with DOM parts (bake.ts): on the overlay canvas their slot rises above it. With
   * HTML-in-Canvas faces nothing stays DOM over the canvas: the browser draws every part.
   */
  const withDomParts = drawable
    ? []
    : cards.filter((c) => {
        const face = c.card.querySelector("[data-face]");
        return face !== null && hasDomParts(face);
      });
  const sectionsWithParts = new Set(withDomParts.map((c) => c.sec));
  const domPartIds = new Set(withDomParts.map((c) => c.def.id));

  const images = (id: string): CardImages | undefined => {
    const f = faces.get(id);
    return f && { face: f.face, art: f.art?.image, back: f.back };
  };

  async function rasterizeAll(geo: Geometry): Promise<void> {
    // The faces must be visible and still while they are drawn; the DOM shows meanwhile.
    const prev = root.dataset.gl;
    root.dataset.gl = "raster";
    const dpr = window.devicePixelRatio || 1;
    try {
      await document.fonts.ready;
      const t0 = performance.now();
      rasterGeo = geo;
      faces = await source.load(cards, geo, dpr);
      root.dataset.glRasterMs = String(Math.round(performance.now() - t0));
    } finally {
      if (prev === "on") root.dataset.gl = "on";
    }
  }

  function makeSurfaces(t: GlTokens, grain: HTMLImageElement): void {
    sections = o.sections.map((s) => {
      const canvas = document.createElement("canvas");
      canvas.className = "gl-surface";
      canvas.setAttribute("aria-hidden", "true");
      // First in the row: the slots paint over it, so DOM parts of faces (bake.ts) show.
      s.row.prepend(canvas);
      const ss: SectionSurface = {
        id: s.id,
        row: s.row,
        surface: new Surface(canvas, t, grain, images),
        view: [0, 0],
        isVisible: true,
        isStale: true,
        drawn: new Set(),
        wasLive: false,
      };
      sizeCanvas(canvas, () => {
        isForced = true;
        schedule();
      });
      return ss;
    });
    const io = new IntersectionObserver((entries) => {
      for (const en of entries) {
        const ss = sections.find((s) => s.surface.canvas === en.target);
        if (!ss) continue;
        ss.isVisible = en.isIntersecting;
        if (ss.isVisible) ss.isStale = true;
      }
      schedule();
    });
    for (const s of sections) io.observe(s.surface.canvas);
    const canvas = document.createElement("canvas");
    canvas.className = "gl-overlay";
    canvas.setAttribute("aria-hidden", "true");
    root.append(canvas);
    const ov = {
      surface: new Surface(canvas, t, grain, images),
      view: [0, 0] as [number, number],
      drawn: new Set<string>(),
    };
    sizeCanvas(canvas, (w, h) => {
      ov.view = [w, h];
      isForced = true;
      schedule();
    });
    overlay = ov;
    addEventListener("pagehide", (e) => {
      // Kept in the back-forward cache, the page may come back; it then reloads to redraw.
      for (const s of sections) s.surface.release();
      ov.surface.release();
      if (e.persisted)
        addEventListener(
          "pageshow",
          () => {
            location.reload();
          },
          { once: true },
        );
    });
    addEventListener(
      "scroll",
      () => {
        // Cached here, so no frame reads scroll position after its own style writes.
        scrollTop = scrollY;
        schedule();
      },
      { passive: true },
    );
  }

  function place(c: CardRefs, geo: Geometry, mat: MaterialView, t: GlTokens): Placed | undefined {
    const home = table.homes.get(c.def.id);
    // A card someone is interacting with is drawn by the DOM meanwhile (live.ts).
    if (!home || c.slot.dataset.glDom !== undefined) return undefined;
    const fr = cardFrame(c.def, table.view(c.def.id), geo, mat, o.show(c));
    const sh = shadows(fr, isPlainCard(c, fr));
    const shadowReach = Math.max(
      ...sh.map(([x = 0, y = 0, blur = 0]) => Math.max(Math.abs(x), Math.abs(y)) + 1.5 * blur),
    );
    const margin = Math.ceil(Math.max(shadowReach, fxReach(c.def.fx, t)) + 2);
    const m = cardMatrix(fr);
    return {
      c,
      fr,
      cx: home.x + fr.tx,
      cy: home.y + fr.ty,
      box: quadBox(m, fr.w / 2 + margin, fr.h / 2 + margin, fr.w * 4),
      margin,
      m,
      isAnimated: isAnimatedCard(c),
    };
  }

  function drawOf(p: Placed, ox: number, oy: number, ctx: FrameCtx): CardDraw {
    const { mat, t, time } = ctx;
    const { fr, c } = p;
    // A card at rest lands on whole device pixels, so its face samples texel for texel.
    const isFlat = fr.rx === 0 && fr.ry === 0 && fr.rz === 0 && fr.skew === 0 && fr.scale === 1;
    const dpr = window.devicePixelRatio || 1;
    const snap = (v: number, half: number): number =>
      isFlat ? Math.round((v - half) * dpr) / dpr + half : v;
    const face = c.def.mini ? FACE.mini : FACE.full;
    const img = faces.get(c.def.id);
    const m = mat.params;
    // As CSS's `data-flat`: no material layers, face filter or blurred shadow.
    const isPlain = isPlainCard(c, fr);
    /** Material layers on (1) or off (0, a flat card). */
    const layers = isPlain ? 0 : 1;
    const [sa, sb] = shadows(fr, isPlain);
    const kb = c.def.kind === "cover" && c.def.fx === "live" ? kenBurns(time) : [1, 0, 0];
    return {
      id: c.def.id,
      cx: snap(p.cx - ox, fr.w / 2),
      cy: snap(p.cy - oy, fr.h / 2),
      halfW: fr.w / 2,
      halfH: fr.h / 2,
      margin: p.margin,
      m: p.m,
      persp: fr.w * 4,
      r: face.radius,
      fx: c.def.fx === undefined ? 0 : FX[c.def.fx],
      floats: {
        uHasArt: img?.art ? 1 : 0,
        uArtOnTop: img?.art?.isOnTop ? 1 : 0,
        uArtRect: img?.art?.rect ?? [0, 0, 1, 1],
        uArtR: img?.art?.r ?? 0,
        uArtFit: img?.art?.fit ?? [0, 0, 1, 1],
        uArtScale: img?.art?.scale ?? 1,
        uArtOffset: [fr.artX, fr.artY],
        uKb: kb,
        uEmber: c.def.kind === "scene" ? emberAt(time) : 0,
        uFilter: isPlain ? [1, 1] : [m.contrast, m.saturate],
        uGrainOp: layers * m.grainOp,
        uFoil: [layers * fr.foilOp, fr.foilX, fr.foilY],
        uGlare: [layers * fr.glareOp, m.sheen, m.isSoftLight ? 1 : 0, t.spotSize],
        uLobe: [m.a1, m.a1Mid, m.r1, m.r2],
        uSpot: [fr.spotX, fr.spotY],
        uHot: [layers * fr.hotOp, m.hotA, m.hotR],
        uEdge: [layers * m.edge, layers * m.edgeTop],
        uShadowA: sa,
        uShadowB: sb,
        uSweep: c.def.fx === "live" ? sweepAt(time) : 0,
        // The plane's normal is the matrix's third column; z < 0 points away from the viewer.
        uBack: (p.m[8] ?? 1) < 0 ? 1 : 0,
      },
    };
  }

  /**
   * Whether the card draws flat, as CSS's `data-flat` (main.ts): buried in a closed pile, or in
   * any pile while one is fanned.
   */
  function isPlainCard(c: CardRefs, fr: CardFrame): boolean {
    return table.isPileQuiet(c.def.id) || (fr.isPile && table.isFanning);
  }

  /** Whether the card shows an animation that is running (not buried in a closed pile). */
  function isAnimatedCard(c: CardRefs): boolean {
    return (c.def.fx !== undefined || c.def.kind === "scene") && !table.isPileQuiet(c.def.id);
  }

  /** Top-left of a section's canvas in root layout px, and its layout size. */
  function originOf(s: SectionSurface, t: GlTokens): Point {
    const at = o.layoutPos(s.row);
    s.view = [s.surface.canvas.clientWidth, s.surface.canvas.clientHeight];
    return { x: at.x - t.surfaceInline, y: at.y - t.surfaceBlock };
  }

  /**
   * The section canvas that fully contains the card's quad; undefined means the overlay. Some
   * cards go on the overlay wherever they are (layering.ts).
   */
  function surfaceFor(
    p: Placed,
    origins: ReadonlyMap<SectionSurface, Point>,
  ): SectionSurface | undefined {
    const ph = table.ph(p.c.def.id);
    const routing = {
      isShown: p.fr.isShown,
      isDragged: ph.drag,
      isMoving: ph.live,
      hasParts: domPartIds.has(p.c.def.id),
      rowHasParts: sectionsWithParts.has(p.c.sec),
    };
    if (isOverlayOnly(routing)) return undefined;
    const own = sections.find((s) => s.id === p.c.sec);
    const at = own && origins.get(own);
    if (!own || !at) return undefined;
    const isInside =
      p.cx + p.box[0] >= at.x &&
      p.cy + p.box[1] >= at.y &&
      p.cx + p.box[2] <= at.x + own.view[0] &&
      p.cy + p.box[3] <= at.y + own.view[1];
    return isInside ? own : undefined;
  }

  /** Redraws a section canvas when anything on it moved, animates or changed. */
  function drawSection(s: SectionSurface, list: readonly Placed[], at: Point, ctx: FrameCtx): void {
    const ids = new Set(list.map((p) => p.c.def.id));
    const isLive = list.some((p) => table.ph(p.c.def.id).live);
    const isAnimated = list.some((p) => p.isAnimated);
    const isDirty = list.some((p) => dirtyCards.has(p.c.def.id));
    const hasMoved = ids.size !== s.drawn.size || [...ids].some((id) => !s.drawn.has(id));
    const { wasLive, isStale } = s;
    const isNeeded = isForced || isStale || isLive || wasLive || isAnimated || isDirty || hasMoved;
    if (!isNeeded) return;
    // An off-screen canvas is never drawn: it is redrawn once it shows again.
    if (!s.isVisible) {
      s.isStale = true;
      return;
    }
    s.isStale = false;
    s.wasLive = isLive;
    s.drawn = ids;
    paint(s.surface, list, at, s.view, ctx);
    stats.sections += 1;
    totals.sections += 1;
    totals.cards += list.length;
  }

  /** Draws the cards onto the canvas. */
  function paint(
    surface: Surface,
    list: readonly Placed[],
    at: Point,
    view: readonly [number, number],
    ctx: FrameCtx,
  ): void {
    if (!surface.begin()) return;
    for (const p of list) {
      const d = drawOf(p, at.x, at.y, ctx);
      if (EXTRA !== "nodraw") surface.draw(d, view, ctx.time);
      // TEMP: ?gldup adds a zero-area draw per card (draw-call cost alone); ?glfill draws every
      // card twice (pixel cost).
      if (EXTRA === "dup") surface.draw({ ...d, halfW: 0, halfH: 0, margin: 0 }, view, ctx.time);
      else if (EXTRA === "fill") surface.draw(d, view, ctx.time);
    }
    stats.cards += list.length;
  }

  function publish(now: number, t0: number): void {
    stats.frames += 1;
    totals.frames += 1;
    totals.ms += performance.now() - t0;
    stats.ms += performance.now() - t0;
    if (now - statsAt < 1000) return;
    const n = Math.max(1, stats.frames);
    root.dataset.glStats = JSON.stringify({
      frames: stats.frames,
      ms: Math.round((stats.ms / n) * 100) / 100,
      sections: Math.round((stats.sections / n) * 100) / 100,
      cards: Math.round((stats.cards / n) * 10) / 10,
      overlayMax: stats.overlayMax,
      hiddenCards: stats.hiddenCards,
      overlayIds: [...(overlay?.drawn ?? [])],
      refreshMs: Math.round(refreshMs),
    });
    stats = newStats();
    statsAt = now;
  }

  function frame(now: number): void {
    const t = tokens;
    const ov = overlay;
    if (!t || !ov || root.dataset.gl !== "on") return;
    const t0 = performance.now();
    lastDraw = now;
    const ctx: FrameCtx = { mat: materialView(table.m), t, time: now / 1000 };
    const geo = o.geometry();
    // Reading layout here, after the frame's style writes, would force a style and layout pass
    // every frame; row positions change only with a forced redraw (relayout, resize).
    if (isForced || origins.size !== sections.length) {
      origins = new Map(sections.map((s) => [s, originOf(s, t)]));
      rootTop = root.getBoundingClientRect().top + scrollY;
    }
    // Cards further than half a screen from the viewport are not drawn; scrolling re-checks.
    const sc = table.sc || 1;
    const reach = innerHeight / 2;
    const top = (scrollTop - rootTop) / sc - reach;
    const bottom = (scrollTop - rootTop + innerHeight) / sc + reach;
    const isNear = (p: Placed): boolean => p.cy + p.box[3] >= top && p.cy + p.box[1] <= bottom;
    const bySurface = new Map<SectionSurface | undefined, Placed[]>();
    for (const c of cards) {
      const p = place(c, geo, ctx.mat, t);
      if (!p || (isHybrid && !isOnGl(p, now))) continue;
      const key = isHybrid ? undefined : surfaceFor(p, origins);
      bySurface.set(key, [...(bySurface.get(key) ?? []), p]);
    }
    for (const [s, at] of origins) {
      drawSection(s, (bySurface.get(s) ?? []).filter((p) => isNear(p)).toSorted(byZ), at, ctx);
    }
    dirtyCards.clear();
    const list = (bySurface.get(undefined) ?? []).toSorted(byZ);
    stats.overlayMax = Math.max(stats.overlayMax, list.length);
    totals.overlayCards += list.length;
    if (list.length > 0 || ov.drawn.size > 0) {
      ov.drawn = new Set(list.map((p) => p.c.def.id));
      const raised = new Set(
        [...raisedAboveOverlay(list, (p) => domPartIds.has(p.c.def.id), isOverlapping)].map(
          (p) => p.c.def.id,
        ),
      );
      for (const c of withDomParts) c.slot.toggleAttribute("data-gl-top", raised.has(c.def.id));
      const rr = root.getBoundingClientRect();
      paint(ov.surface, list, { x: -rr.left / sc, y: -rr.top / sc }, ov.view, ctx);
    }
    isForced = false;
    publish(now, t0);
  }

  /**
   * Hybrid: whether WebGL draws the card this frame. A moving or showcased card goes on the
   * overlay canvas, its DOM layers out of the render tree (`data-gl-hy`); it goes back
   * to CSS once it has been still for `HYBRID_SETTLE_MS`.
   */
  function isOnGl(p: Placed, now: number): boolean {
    const id = p.c.def.id;
    const isActive = p.fr.isShown || table.ph(id).live;
    if (isActive) glUntil.set(id, now + HYBRID_SETTLE_MS);
    const until = glUntil.get(id);
    const isOn = until !== undefined && now < until;
    if (!isOn) glUntil.delete(id);
    p.c.slot.toggleAttribute("data-gl-hy", isOn);
    return isOn;
  }

  function isFrameNeeded(): boolean {
    return (
      isForced ||
      glUntil.size > 0 ||
      dirtyCards.size > 0 ||
      (overlay?.drawn.size ?? 0) > 0 ||
      sections.some(
        (s) => s.isVisible && cards.some((c) => s.drawn.has(c.def.id) && isAnimatedCard(c)),
      )
    );
  }

  function schedule(): void {
    if (loop) return;
    loop = requestAnimationFrame((now) => {
      loop = 0;
      if (now !== lastDraw && !o.isSimPending()) frame(now);
      if (isFrameNeeded()) schedule();
    });
  }

  let refreshing: Promise<void> = Promise.resolve();
  let refreshMs = 0;

  /** Rasterizes these cards' faces again and puts the new images in use. */
  function refresh(ids: readonly string[], scale = 1): Promise<void> {
    const run = async (): Promise<void> => {
      await refreshing;
      const t0 = performance.now();
      const subset = cards.filter((c) => ids.includes(c.def.id));
      const fresh = await source.load(subset, o.geometry(), (window.devicePixelRatio || 1) * scale);
      const next = new Map(faces);
      for (const [id, f] of fresh) {
        // A face that is not laid out (drawn by WebGL) has no measurable art box: keep the old.
        next.set(id, {
          face: f.face,
          art: f.art ?? faces.get(id)?.art,
          back: f.back,
          live: f.live ?? [],
        });
      }
      faces = next;
      const inUse = new Set<TexImageSource>();
      for (const f of faces.values()) {
        if (f.face) inUse.add(f.face.source);
        if (f.art) inUse.add(f.art.image);
        if (f.back) inUse.add(f.back.source);
      }
      for (const s of sections) s.surface.retainSources(inUse);
      overlay?.surface.retainSources(inUse);
      refreshMs = performance.now() - t0;
      isForced = true;
      schedule();
    };
    refreshing = run();
    return refreshing;
  }

  /** An HTML-in-Canvas face (drawable.ts) drew something new: upload it, redraw its card. */
  function onDrawn(id: string): void {
    const f = faces.get(id);
    for (const src of [f?.face?.source, f?.back?.source]) {
      if (!(src instanceof HTMLCanvasElement)) continue;
      for (const s of sections) s.surface.reupload(src);
      overlay?.surface.reupload(src);
    }
    dirtyCards.add(id);
    schedule();
  }

  /**
   * Redraws a card's live text into its atlas and uploads the changed rectangles; false when
   * the card has none (its change needs a new snapshot).
   */
  function hasPatchedText(id: string): boolean {
    const live = faces.get(id)?.live ?? [];
    if (live.length === 0) return false;
    for (const t of live) {
      paintText(t);
      for (const s of sections) s.surface.updateRegion(t.canvas, t.x, t.y, t.w, t.h);
      overlay?.surface.updateRegion(t.canvas, t.x, t.y, t.w, t.h);
    }
    // Only the canvases holding this card redraw, and only once they are on screen.
    dirtyCards.add(id);
    schedule();
    return true;
  }

  async function rerasterize(geo: Geometry): Promise<void> {
    await rasterizeAll(geo);
    for (const s of sections) s.surface.forget();
    overlay?.surface.forget();
    isForced = true;
    schedule();
  }

  const ready = (async (): Promise<void> => {
    try {
      const grain = await loadImage(grainUrl);
      const t = readTokens(root);
      tokens = t;
      await rasterizeAll(o.geometry());
      makeSurfaces(t, grain);
      root.dataset.gl = "on";
      if (drawable) {
        // Every face is real and drawn by the browser into its canvas: no snapshots to keep
        // fresh, no DOM phase; the invisible face takes input directly.
        for (const c of cards) c.slot.dataset.glGhost = "";
      } else if (!isHybrid)
        // Hybrid v1 leaves out the DOM phase: a card at rest is the DOM already.
        watchLiveFaces({
          cards,
          isOn: () => root.dataset.gl === "on",
          refresh,
          hasPatchedText,
          changed: () => {
            isForced = true;
            schedule();
          },
        });
      isForced = true;
      schedule();
    } catch (error: unknown) {
      // The DOM cards keep drawing; the failure is visible on the root and in the console.
      root.dataset.gl = "failed";
      console.error("WebGL renderer failed to start", error);
    }
  })();

  return {
    ready,
    isHybrid,
    upscale(id: string): void {
      // Up to the showcase's 3x; the face hidden behind WebGL keeps its last art (refresh).
      const c = cards.find((x) => x.def.id === id);
      if (drawable && c) {
        const geo = o.geometry();
        const k = c.def.mini ? geo.mw / FACE.mini.bw : geo.w / FACE.full.bw;
        drawable.rescale(id, k * (window.devicePixelRatio || 1) * 3);
      } else void refresh([id], 3);
    },
    frame(now: number): void {
      frame(now);
      schedule();
    },
    invalidate(): void {
      isForced = true;
      const geo = o.geometry();
      if (rasterGeo && (rasterGeo.w !== geo.w || rasterGeo.mw !== geo.mw)) void rerasterize(geo);
      schedule();
    },
  };
}

/**
 * Where faces come from: HTML-in-Canvas (drawable.ts) where the browser has it, else snapshots
 * (raster.ts). `?glsrc=snapshot` picks snapshots anyway; `?glsrc=drawable` insists on the
 * other and fails where it is missing.
 */
function faceBackend(): "drawable" | "snapshot" {
  const want = new URLSearchParams(location.search).get("glsrc");
  if (want === "drawable" && !hasDrawableCanvas())
    throw new Error("gl: ?glsrc=drawable, but this browser has no HTML-in-Canvas");
  if (want === "snapshot" || want === "canvas") return "snapshot";
  return hasDrawableCanvas() ? "drawable" : "snapshot";
}

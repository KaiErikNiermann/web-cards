// Entry point: builds the page, wires pointer and control events to the physics, and runs the
// frame loop. A frame runs only while something moves; every input event re-arms it.

import "./fonts";
import "./styles/index.css";

import { PRESETS, geometryFor, type Geometry, type SectionId } from "./data";
import {
  buildPresetChips,
  buildSections,
  buildSliders,
  must,
  type CardRefs,
  type SectionRefs,
} from "./dom";
import { INTERACTIVE } from "./dom";
import { mountGl } from "./gl";
import { Hold } from "./gesture";
import { mountHud, wireHudToggle } from "./hud";
import { CardTable, type Pile, type Point } from "./physics";
import { Showcase, type ShowFrame } from "./showcase";
import { cardSize, cardView, materialView, setAttr, setHidden, setText, setVars } from "./view";

const root = must(document, "[data-root]", HTMLElement);
const table = new CardTable();
const { sections, cards } = buildSections(must(root, "[data-sections]", HTMLElement));
const sliders = buildSliders(must(root, "[data-sliders]", HTMLElement));
const chips = buildPresetChips(must(root, "[data-presets]", HTMLElement));
const presetLabel = must(root, "[data-preset-label]", HTMLElement);
const retToggle = must(root, "[data-ret]", HTMLInputElement);
const resetButton = must(root, "[data-reset]", HTMLButtonElement);
const cardById = new Map(cards.map((c) => [c.def.id, c]));
function countLive(): number {
  let n = 0;
  for (const p of table.phys.values()) if (p.live) n += 1;
  return n;
}

const hud = mountHud(document.body, () => {
  const state = live.raf === 0 ? "idle" : "running";
  const renderer = gl ? ` · webgl ${root.dataset.glFaces ?? ""}` : "";
  return `${String(countLive())} live cards · sim ${state}${renderer}`;
});
/** Cards outside the viewport; their animations are held still. */
const offscreen = new Set<string>();

/** A finger resting on or sliding along a pile, before it has taken a card. */
interface TouchScrub {
  readonly pointerId: number;
  readonly pile: Pile;
  readonly el: HTMLElement;
  readonly hold: Hold;
  timer: ReturnType<typeof setTimeout> | undefined;
  last: PointerEvent;
}

/** Mutable loop state: geometry, the pending frame, the laid-out pile version, a touch scrub. */
const live: {
  geo: Geometry;
  raf: number;
  laidOut: number;
  scrub: TouchScrub | undefined;
  /** Whether a pile was fanned in the last rendered frame. */
  fanning: boolean;
} = { geo: geometryFor(window.innerWidth), raf: 0, laidOut: -1, scrub: undefined, fanning: false };

/** Offset of `el` from the root's padding box, in layout px (transforms ignored). */
function layoutPos(el: HTMLElement): Point {
  let x = 0;
  let y = 0;
  let cur: Element | null = el;
  while (cur !== root && cur instanceof HTMLElement) {
    x += cur.offsetLeft;
    y += cur.offsetTop;
    cur = cur.offsetParent;
  }
  return { x, y };
}

/**
 * Records each card's home centre and each row's extent in root layout coordinates. A card
 * whose home moved (rows collapsing, a resize) is re-anchored so it glides rather than jumps.
 */
function measure(): void {
  const rr = root.getBoundingClientRect();
  table.sc = (root.offsetWidth ? rr.width / root.offsetWidth : 1) || 1;
  for (const c of cards) {
    const at = layoutPos(c.slot);
    const home = { x: at.x + c.slot.offsetWidth / 2, y: at.y + c.slot.offsetHeight / 2 };
    const old = table.homes.get(c.def.id);
    if (old) table.shiftHome(c.def.id, home.x - old.x, home.y - old.y);
    table.homes.set(c.def.id, home);
  }
  for (const s of sections) {
    const at = layoutPos(s.row);
    table.rows.set(s.id, { left: at.x, right: at.x + s.row.clientWidth });
  }
}

const showcase = new Showcase();

/** Main-loop frames and their JS time since load, for tests (`?gldebug`: `__appTotals`). */
const appTotals = { frames: 0, ms: 0 };
if (location.search.includes("gldebug")) Reflect.set(globalThis, "__appTotals", appTotals);

/**
 * The showcased card's transform: the offset from its home to the middle of the viewport and
 * the scale at which it fills most of the screen (at most 3x).
 */
function showOf(c: CardRefs): ShowFrame | undefined {
  if (showcase.id !== c.def.id) return undefined;
  const home = table.homes.get(c.def.id);
  if (!home) return undefined;
  const rr = root.getBoundingClientRect();
  const sc = table.sc || 1;
  const size = cardSize(c.def, live.geo);
  const fit = Math.min(
    (innerWidth * 0.86) / (size.w * sc),
    (innerHeight * 0.72) / (size.h * sc),
    3,
  );
  const centre = { x: (innerWidth / 2 - rr.left) / sc, y: (innerHeight / 2 - rr.top) / sc };
  return showcase.frameOf(c.def.id, { x: centre.x - home.x, y: centre.y - home.y }, fit);
}

/** WebGL rendering (`?gl`): the canvases draw the cards, the DOM cards only take input. */
const gl = new URLSearchParams(location.search).has("gl")
  ? mountGl({
      root,
      table,
      sections,
      cards,
      geometry: () => live.geo,
      layoutPos,
      show: showOf,
      isSimPending: () => live.raf !== 0,
    })
  : undefined;

// The build bake's stage (`?bake`, scripts/bake-faces.ts): faces marked data-bake="build".
if (new URLSearchParams(location.search).has("bake")) {
  void import("./gl/bakestage").then(async (m) => m.stageBuildBakes(cards));
}

const hasPile = (sec: SectionId): boolean => table.piles[sec].some((p) => p.ids.length > 1);

/**
 * Sizes each row to the slots in use, with lift headroom while it holds a pile. Measures
 * twice: once for the headroom, once more after the row heights move the sections below.
 */
function relayout(): void {
  for (const s of sections) {
    const meta = table.meta.get(CardTable.slotId(s.id, 0) ?? "");
    setVars(s.row, { "--row-pad": `${String(meta && hasPile(s.id) ? meta.pad : 0)}px` });
  }
  measure();
  for (const s of sections) {
    const top = layoutPos(s.row).y + s.row.clientTop;
    const pad = Number(getComputedStyle(s.row).paddingBlockStart.replace("px", "")) || 0;
    let bottom = top + pad;
    for (let k = 0; k < table.used(s.id); k += 1) {
      const id = CardTable.slotId(s.id, k) ?? "";
      const home = table.homes.get(id);
      const meta = table.meta.get(id);
      if (home && meta) bottom = Math.max(bottom, home.y + meta.h / 2);
    }
    setVars(s.row, { "--row-h": `${String(Math.round(bottom - top - pad))}px` });
  }
  measure();
}

/** Pointer position in root layout coordinates. */
function toLayout(e: PointerEvent): Point {
  const rr = root.getBoundingClientRect();
  return { x: (e.clientX - rr.left) / table.sc, y: (e.clientY - rr.top) / table.sc };
}

function sectionNote(s: SectionRefs): string {
  switch (s.id) {
    case "full": {
      return `5:7 · ${String(live.geo.w)} × ${String(live.geo.h)}`;
    }
    case "anim": {
      return "border and face animations sit inside the card transform, so they ride every tilt, sway and drag";
    }
    case "stack": {
      return live.geo.small
        ? "slide a finger along the pile to fan it; hold to take a card"
        : "hover to fan the pile; press to take the lifted card";
    }
    case "mini": {
      return `same shape · ${String(live.geo.mw)} × ${String(live.geo.mh)} · glyph faces`;
    }
    case "lab": {
      return "editable, live and scrolling faces, for testing renderers";
    }
  }
}

function labelOf(id: string): string {
  return cardById.get(id)?.def.label ?? id;
}

/** Readout of a section's piles: the card pointed at in an open pile, else the pile sizes. */
function pileLabel(sec: SectionId): string {
  const piles = table.piles[sec].filter((p) => p.ids.length > 1);
  const open = piles.find((p) => p.open);
  if (open) {
    const ai = Math.round(open.fs);
    const id = open.ids[ai];
    if (id) return `${String(ai + 1)} / ${String(open.ids.length)} · ${labelOf(id)}`;
  }
  const sizes = piles.map((p) => String(p.ids.length));
  return sizes.length === 1 ? `pile of ${sizes.join("")}` : `piles of ${sizes.join(", ")}`;
}

function renderSections(): void {
  for (const s of sections) {
    setText(s.note, sectionNote(s));
    const gap = s.id === "mini" ? live.geo.miniGap : live.geo.gap;
    setVars(s.row, { "--row-gap": `${String(gap)}px` });
    const isShown = hasPile(s.id);
    setHidden(s.stackLabel, !isShown);
    if (isShown) setText(s.stackLabel, pileLabel(s.id));
  }
}

function renderControls(): void {
  const m = table.m;
  setText(presetLabel, m.preset ? PRESETS[m.preset].label : "custom");
  for (const { id, el } of chips) setAttr(el, "aria-pressed", String(m.preset === id));
  for (const { def, input, value } of sliders) {
    const v = m[def.key];
    if (input.valueAsNumber !== v) input.value = String(v);
    setText(value, def.text(v));
  }
  retToggle.checked = m.ret;
}

/** Cards that were live in the last rendered frame; a card at rest two frames running is skipped. */
const liveLastFrame = new Set<string>();

/** Writes one card's state to the DOM; unless `isForced`, only while it moves or just stopped. */
function renderCard(c: CardRefs, mat: ReturnType<typeof materialView>, isForced: boolean): void {
  const p = table.view(c.def.id);
  const isShown = showcase.id === c.def.id;
  const { live: isLive } = p;
  if (!(isForced || isShown || isLive || liveLastFrame.has(c.def.id))) return;
  if (isShown || isLive) liveLastFrame.add(c.def.id);
  else liveLastFrame.delete(c.def.id);
  const v = cardView(c.def, p, live.geo, mat, showOf(c));
  c.slot.toggleAttribute("data-show", isShown);
  table.meta.set(c.def.id, { sec: c.sec, w: v.w, h: v.h, step: v.step, pad: v.pad });
  setVars(c.slot, v.vars.slot);
  setVars(c.card, v.vars.card);
  setVars(c.foil, v.vars.foil);
  setVars(c.glare, v.vars.glare);
  setVars(c.hot, v.vars.hot);
  for (const el of c.spots) setVars(el, v.vars.spot);
  if (c.art) setVars(c.art, v.vars.art);
  c.slot.toggleAttribute("data-pile", p.pile);
  c.slot.toggleAttribute("data-live", p.live);
  // Pile cards move by transform only (physics.ts tickMember), so they never need light layers.
  const isLit =
    p.drag || (!p.pile && (p.h > 0.02 || p.lift > 0.02 || Math.abs(p.rx) + Math.abs(p.ry) > 0.05));
  c.slot.toggleAttribute("data-lit", isLit);
  // While a pile is fanned every effect animation holds still and its cards draw flat.
  const isQuiet = table.isPileQuiet(c.def.id);
  c.slot.toggleAttribute("data-still", live.fanning || offscreen.has(c.def.id) || isQuiet);
  // Every card of a fanned pile draws flat, the pointed one too: flipping cards between flat
  // and full as the pointer moves along the fan re-rasterized them (65 against 117 fps).
  c.slot.toggleAttribute("data-flat", isQuiet || (p.pile && live.fanning));
  setHidden(c.grain, mat.grainHidden);
  setHidden(c.foil, v.foilHidden);
  setHidden(c.hot, v.hotHidden);
}

/**
 * Writes the simulation to the DOM. The frame loop passes `isForced = false` to skip cards at
 * rest; anything that changes every card (material, geometry, piles, visibility) forces.
 */
function render(isForced = true): void {
  const mat = materialView(table.m);
  setVars(root, mat.vars);
  for (const c of cards) renderCard(c, mat, isForced);
  if (isForced) gl?.invalidate();
  renderSections();
  renderControls();
}

function kick(): void {
  if (live.raf) return;
  live.raf = requestAnimationFrame((now) => {
    live.raf = 0;
    const t0 = performance.now();
    const hasNewPiles = live.laidOut !== table.version;
    const isFanning = table.isFanning;
    const hasNewFan = isFanning !== live.fanning;
    live.fanning = isFanning;
    if (hasNewPiles) {
      live.laidOut = table.version;
      relayout();
    }
    const isActive = table.tick(now);
    const isShowing = showcase.tick(now);
    render(hasNewPiles || hasNewFan);
    gl?.frame(now);
    const ms = performance.now() - t0;
    hud.record(ms);
    appTotals.frames += 1;
    appTotals.ms += ms;
    if (isActive || isShowing) kick();
  });
}

const slotRect = (el: HTMLElement): DOMRect | undefined =>
  el.parentElement?.getBoundingClientRect();

/** Starts dragging card `id` with pointer `e`, moving pointer capture onto that card. */
function startDrag(id: string, e: PointerEvent): void {
  const c = cardById.get(id);
  const r = c && slotRect(c.card);
  if (!c || !r) return;
  table.down(id, e, r);
  try {
    c.card.setPointerCapture(e.pointerId);
  } catch {
    // The pointer may already be gone (e.g. a released touch); dragging still works.
  }
}

/** Takes the card the pile points at out of the pile and starts dragging it. */
function takeFromPile(pile: Pile, e: PointerEvent): void {
  const ref = table.pileOf(pile.ids[0] ?? "");
  const id = ref && table.pickTarget(ref);
  if (id === undefined) return;
  table.pull(id);
  startDrag(id, e);
  kick();
}

function endScrub(): void {
  const sc = live.scrub;
  if (!sc) return;
  clearTimeout(sc.timer);
  sc.pile.open = false;
  live.scrub = undefined;
  kick();
}

function armHold(sc: TouchScrub): void {
  clearTimeout(sc.timer);
  sc.timer = setTimeout(() => {
    if (live.scrub !== sc) return;
    live.scrub = undefined;
    if ("vibrate" in navigator) navigator.vibrate(12);
    takeFromPile(sc.pile, sc.last);
  }, sc.hold.remaining(performance.now()));
}

/** A touch or pen press on a pile: fan it and point, and take the card on a hold. */
function startScrub(id: string, el: HTMLElement, e: PointerEvent): void {
  const ref = table.pileOf(id);
  if (!ref || live.scrub) return;
  try {
    el.setPointerCapture(e.pointerId);
  } catch {
    // Without capture the scrub ends when the finger leaves this card.
  }
  const hold = new Hold();
  hold.start(e.clientX, e.clientY, e.timeStamp);
  const sc: TouchScrub = {
    pointerId: e.pointerId,
    pile: ref.pile,
    el,
    hold,
    timer: undefined,
    last: e,
  };
  live.scrub = sc;
  const at = toLayout(e);
  table.closePiles(ref.pile);
  table.scrub(ref, at.x, at.y);
  armHold(sc);
  kick();
}

function isScrubMove(e: PointerEvent): boolean {
  const sc = live.scrub;
  if (sc?.pointerId !== e.pointerId) return false;
  sc.last = e;
  const ref = table.pileOf(sc.pile.ids[0] ?? "");
  if (ref) {
    const at = toLayout(e);
    table.scrub(ref, at.x, at.y);
  }
  if (sc.hold.move(e.clientX, e.clientY, e.timeStamp)) armHold(sc);
  kick();
  return true;
}

/**
 * A new primary pointer means every earlier pointer is up, so a scrub or drag still open from
 * one whose release never arrived is stale; close it rather than let it block this press.
 */
function clearStale(e: PointerEvent): void {
  if (!e.isPrimary) return;
  if (live.scrub && live.scrub.pointerId !== e.pointerId) endScrub();
  const id = table.dragId;
  if (id !== undefined && table.ph(id).pid !== e.pointerId) table.end(id, true, false);
}

/** A press that may turn out to be a tap (short, barely moving): it opens the showcase. */
const taps: {
  press: { id: string; x: number; y: number; at: number; pointerId: number } | undefined;
  /** The pointer whose press closed the showcase: it does nothing else until it lifts. */
  dismissing: number | undefined;
} = { press: undefined, dismissing: undefined };
const TAP_MS = 300;
/** How long after opening the showcase the card is rasterized at its grown size. */
const UPSCALE_AFTER_MS = 900;
const TAP_PX = 8;

function isTap(id: string, e: PointerEvent): boolean {
  const { press } = taps;
  return (
    press?.id === id &&
    press.pointerId === e.pointerId &&
    e.timeStamp - press.at < TAP_MS &&
    Math.hypot(e.clientX - press.x, e.clientY - press.y) < TAP_PX
  );
}

/** A tap on a card opens it in the showcase; on the open card it turns it over. */
function onTap(id: string): void {
  if (showcase.id === id && showcase.isOpen) showcase.turn();
  else {
    showcase.show(id);
    // A sharper copy for the grown card, once it has arrived: a snapshot on the main thread
    // mid-flight stalled the animation.
    setTimeout(() => {
      // Not while it flies home: the snapshot stalls the main thread for a frame or more.
      if (showcase.id === id && showcase.isOpen) gl?.upscale(id);
    }, UPSCALE_AFTER_MS);
  }
  kick();
}

function onCardDown(id: string, el: HTMLElement, e: PointerEvent): void {
  if (e.button !== 0 && e.pointerType === "mouse") return;
  // A press that closed the showcase does not also open, drag or scrub the card under it:
  // opening another card would snap the closing one home instead of letting it fly back.
  if (taps.dismissing === e.pointerId) return;
  // Presses on a face's own controls (Lab faces) operate them rather than the card.
  if (e.target instanceof Element && e.target.closest(INTERACTIVE)) return;
  taps.press = { id, x: e.clientX, y: e.clientY, at: e.timeStamp, pointerId: e.pointerId };
  // The showcased card takes taps (turn over) and tilts; it is not dragged.
  if (showcase.id === id) return;
  clearStale(e);
  measure();
  if (table.isPiled(id)) {
    if (e.pointerType === "mouse") {
      e.preventDefault();
      const ref = table.pileOf(id);
      if (!ref) return;
      const at = toLayout(e);
      table.scrub(ref, at.x, at.y);
      takeFromPile(ref.pile, e);
    } else startScrub(id, el, e);
    return;
  }
  startDrag(id, e);
  if (e.pointerType === "mouse") e.preventDefault();
  kick();
}

function onCardMove(id: string, el: HTMLElement, e: PointerEvent): void {
  if (isScrubMove(e)) return;
  const p = table.ph(id);
  if (p.drag) {
    if (e.pointerId !== p.pid) return;
    table.dragMove(id, e);
  } else {
    // Piles take mouse hover through the window listener, by geometry; a showcased card
    // follows a finger too.
    if ((e.pointerType !== "mouse" && showcase.id !== id) || p.pile) return;
    const r = slotRect(el);
    if (!r) return;
    if (!p.hover) measure();
    table.hoverMove(id, e, r);
  }
  kick();
}

function onCardEnd(id: string, el: HTMLElement, e: PointerEvent, wasCancelled: boolean): void {
  if (live.scrub?.pointerId === e.pointerId) {
    endScrub();
    return;
  }
  if (!wasCancelled && isTap(id, e) && !table.isPiled(id)) onTap(id);
  taps.press = undefined;
  const p = table.ph(id);
  if (!p.drag || e.pointerId !== p.pid) return;
  const r = slotRect(el);
  const isOver =
    e.pointerType === "mouse" &&
    r !== undefined &&
    e.clientX >= r.left &&
    e.clientX <= r.right &&
    e.clientY >= r.top &&
    e.clientY <= r.bottom;
  table.end(id, wasCancelled, isOver);
  try {
    el.releasePointerCapture(e.pointerId);
  } catch {
    // Capture is already released when the pointer was cancelled.
  }
  kick();
}

function wireCard(c: CardRefs): void {
  const id = c.def.id;
  const el = c.card;
  el.addEventListener("pointerdown", (e) => {
    onCardDown(id, el, e);
  });
  el.addEventListener("pointermove", (e) => {
    onCardMove(id, el, e);
  });
  el.addEventListener("pointerup", (e) => {
    onCardEnd(id, el, e, false);
  });
  el.addEventListener("pointercancel", (e) => {
    onCardEnd(id, el, e, true);
  });
  el.addEventListener("pointerleave", () => {
    if (table.ph(id).drag) return;
    table.leave(id);
    kick();
  });
  el.addEventListener("dblclick", () => {
    if (table.isPiled(id)) return;
    table.sendHome(id);
    kick();
  });
  // Touch long-press would open the context menu mid-drag; the mouse keeps its menu.
  el.addEventListener("contextmenu", (e) => {
    if (!(e instanceof PointerEvent) || e.pointerType !== "mouse") e.preventDefault();
  });
}

/** Mouse hover over piles, by geometry: an open fan is wider than the card that opened it. */
function wirePileHover(): void {
  addEventListener("pointermove", (e) => {
    if (e.pointerType !== "mouse" || table.dragId !== undefined) return;
    const at = toLayout(e);
    const ref = table.pileAt(at.x, at.y);
    const wasOpen = ref?.pile.open;
    table.closePiles(ref?.pile);
    if (ref) {
      if (!wasOpen) measure();
      table.scrub(ref, at.x, at.y);
    }
    kick();
  });
  document.documentElement.addEventListener("pointerleave", () => {
    if (live.scrub) return;
    table.closePiles();
    kick();
  });
}

/** Tracks which cards are off screen, so their animations can stop. */
function watchVisibility(): void {
  const io = new IntersectionObserver(
    (entries) => {
      // Only the cards that crossed the edge change (their animations start or stop); a full
      // forced render here ran on every crossing while scrolling and rewrote every card.
      const mat = materialView(table.m);
      for (const en of entries) {
        const c =
          en.target instanceof HTMLElement ? cardById.get(en.target.dataset.card ?? "") : undefined;
        if (!c) continue;
        if (en.isIntersecting) offscreen.delete(c.def.id);
        else offscreen.add(c.def.id);
        renderCard(c, mat, true);
      }
    },
    { rootMargin: "64px" },
  );
  for (const c of cards) io.observe(c.slot);
}

function wire(): void {
  for (const c of cards) wireCard(c);
  wireHudToggle(hud, {
    storageKey: "web-cards:hud",
    checkbox: must(root, "[data-hud-toggle]", HTMLInputElement),
  });
  watchVisibility();
  wirePileHover();
  for (const { id, el } of chips) {
    el.addEventListener("click", () => {
      table.pickPreset(id);
      render();
    });
  }
  for (const { def, input } of sliders) {
    input.addEventListener("input", () => {
      table.setSlider(def.key, input.valueAsNumber);
      render();
    });
  }
  retToggle.addEventListener("change", () => {
    table.m.ret = retToggle.checked;
    render();
  });
  resetButton.addEventListener("click", () => {
    endScrub();
    table.resetAll();
    kick();
  });
  // The geometry is keyed to window.innerWidth (as in the export), not to an element's size.
  // eslint-disable-next-line unicorn/prefer-observer-apis
  window.addEventListener("resize", onResize);
}

/** Closes the showcase on a press anywhere but the open card, on Escape, and follows scrolls. */
function wireShowcase(): void {
  addEventListener(
    "pointerdown",
    (e) => {
      if (!showcase.isOpen || showcase.id === undefined) return;
      const open = cardById.get(showcase.id);
      if (open && e.target instanceof Node && open.card.contains(e.target)) return;
      showcase.close();
      taps.dismissing = e.pointerId;
      kick();
    },
    { capture: true },
  );
  for (const type of ["pointerup", "pointercancel"] as const) {
    addEventListener(type, (e) => {
      if (taps.dismissing === e.pointerId) taps.dismissing = undefined;
    });
  }
  addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !showcase.isOpen) return;
    showcase.close();
    kick();
  });
  addEventListener(
    "scroll",
    () => {
      if (showcase.id !== undefined) kick();
    },
    { passive: true },
  );
}

function onResize(): void {
  live.geo = geometryFor(window.innerWidth);
  render();
  live.laidOut = -1;
  kick();
}

/** Lab clock faces: the time and a counter, rewritten every second. */
function tickClocks(): void {
  const clocks = root.querySelectorAll<HTMLElement>("[data-clock]");
  if (clocks.length === 0) return;
  let n = 0;
  setInterval(() => {
    n += 1;
    const time = new Date().toLocaleTimeString("en-GB");
    for (const el of clocks) setText(el, time);
    for (const el of root.querySelectorAll<HTMLElement>("[data-count]")) setText(el, String(n));
  }, 1000);
}

wire();
wireShowcase();
tickClocks();
onResize();
// Fonts and images settle layout after the first frame; lay out again once they have.
setTimeout(() => {
  live.laidOut = -1;
  kick();
}, 300);

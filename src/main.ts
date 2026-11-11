// Entry point: builds the page, wires pointer and control events to the physics, and runs the
// frame loop. A frame runs only while something moves; every input event re-arms it.

import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-serif/400-italic.css";
import "@fontsource/ibm-plex-serif/500.css";
import "@fontsource/ibm-plex-serif/600.css";
import "./styles/index.css";

import { DECKS, PRESETS, geometryFor, type Geometry } from "./data";
import {
  buildPresetChips,
  buildSections,
  buildSliders,
  must,
  type CardRefs,
  type SectionRefs,
} from "./dom";
import { CardTable } from "./physics";
import { cardView, materialView, setVars } from "./view";

const root = must(document, "[data-root]", HTMLElement);
const table = new CardTable();
const { sections, cards } = buildSections(must(root, "[data-sections]", HTMLElement));
const sliders = buildSliders(must(root, "[data-sliders]", HTMLElement));
const chips = buildPresetChips(must(root, "[data-presets]", HTMLElement));
const presetLabel = must(root, "[data-preset-label]", HTMLElement);
const retToggle = must(root, "[data-ret]", HTMLInputElement);
const resetButton = must(root, "[data-reset]", HTMLButtonElement);

/** Mutable loop state: the current geometry and the pending animation frame. */
const live: { geo: Geometry; raf: number } = { geo: geometryFor(window.innerWidth), raf: 0 };

/** Records each free card's home centre in root layout coordinates (transforms ignored). */
function measure(): void {
  const rr = root.getBoundingClientRect();
  table.sc = (root.offsetWidth ? rr.width / root.offsetWidth : 1) || 1;
  for (const slot of root.querySelectorAll<HTMLElement>("[data-card]")) {
    const id = slot.dataset.card;
    if (!id) continue;
    let x = 0;
    let y = 0;
    let el: Element | null = slot;
    while (el !== root && el instanceof HTMLElement) {
      x += el.offsetLeft;
      y += el.offsetTop;
      el = el.offsetParent;
    }
    table.homes.set(id, { x: x + slot.offsetWidth / 2, y: y + slot.offsetHeight / 2 });
  }
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
        ? "drag a finger across the pile"
        : "move across the pile; each card lifts in turn";
    }
    case "mini": {
      return `same shape · ${String(live.geo.mw)} × ${String(live.geo.mh)} · glyph faces`;
    }
  }
}

function renderSections(): void {
  const n = DECKS.stack.length;
  const st = table.stack;
  for (const s of sections) {
    s.note.textContent = sectionNote(s);
    if (s.id === "stack") {
      setVars(s.row, {
        "--pile-w": `${String(live.geo.w + (n - 1) * live.geo.step)}px`,
        "--pile-h": `${String(live.geo.h + live.geo.liftPad + 6)}px`,
      });
      const ai = Math.round(st.fs);
      const top = DECKS.stack[ai];
      if (s.stackLabel)
        s.stackLabel.textContent =
          top && st.active
            ? `${String(ai + 1)} / ${String(n)} · ${top.label}`
            : `${String(n)} cards`;
    } else {
      const gap = s.id === "mini" ? live.geo.miniGap : live.geo.gap;
      setVars(s.row, { "--row-gap": `${String(gap)}px` });
    }
  }
}

function renderControls(): void {
  const m = table.m;
  presetLabel.textContent = m.preset ? PRESETS[m.preset].label : "custom";
  for (const { id, el } of chips) el.setAttribute("aria-pressed", String(m.preset === id));
  for (const { def, input, value } of sliders) {
    const v = m[def.key];
    if (input.valueAsNumber !== v) input.value = String(v);
    value.textContent = def.text(v);
  }
  retToggle.checked = m.ret;
}

function renderCard(c: CardRefs, mat: ReturnType<typeof materialView>): void {
  const p = table.ph(c.def.id);
  const v = cardView(c.def, c.sec, c.i, p, live.geo, mat);
  table.meta.set(c.def.id, { sec: c.sec, w: v.w, h: v.h, stack: c.sec === "stack", i: c.i });
  setVars(c.slot, v.vars);
  c.grain.hidden = mat.grainHidden;
  c.foil.hidden = v.foilHidden;
  c.hot.hidden = v.hotHidden;
  const vb = `0 0 ${String(v.w)} ${String(v.h)}`;
  if (!c.svg || c.svg.getAttribute("viewBox") === vb) return;
  c.svg.setAttribute("viewBox", vb);
  for (const r of c.outlines) {
    r.setAttribute("width", String(v.w - 2));
    r.setAttribute("height", String(v.h - 2));
    r.setAttribute("rx", String(v.radius - 1));
  }
}

function render(): void {
  const mat = materialView(table.m);
  setVars(root, mat.vars);
  for (const c of cards) renderCard(c, mat);
  renderSections();
  renderControls();
}

function kick(): void {
  if (live.raf) return;
  live.raf = requestAnimationFrame(() => {
    live.raf = 0;
    const isActive = table.tick();
    render();
    if (isActive) kick();
  });
}

const slotRect = (e: Event): DOMRect | undefined =>
  (e.currentTarget as HTMLElement | null)?.parentElement?.getBoundingClientRect();

function wireFreeCard(c: CardRefs): void {
  const id = c.def.id;
  const el = c.card;
  el.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    measure();
    const r = slotRect(e);
    if (!r) return;
    table.down(id, e, r);
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      // The pointer may already be gone (e.g. a released touch); dragging still works.
    }
    if (e.pointerType === "mouse") e.preventDefault();
    kick();
  });
  el.addEventListener("pointermove", (e) => {
    const p = table.ph(id);
    if (p.drag) {
      if (e.pointerId !== p.pid) return;
      table.dragMove(id, e);
    } else {
      if (e.pointerType !== "mouse") return;
      const r = slotRect(e);
      if (!r) return;
      if (!p.hover) measure();
      table.hoverMove(id, e, r);
    }
    kick();
  });
  const end = (e: PointerEvent, wasCancelled: boolean): void => {
    if (!table.ph(id).drag) return;
    const r = slotRect(e);
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
  };
  el.addEventListener("pointerup", (e) => {
    end(e, false);
  });
  el.addEventListener("pointercancel", (e) => {
    end(e, true);
  });
  el.addEventListener("pointerleave", () => {
    if (table.ph(id).drag) return;
    table.leave(id);
    kick();
  });
  el.addEventListener("dblclick", () => {
    table.sendHome(id);
    kick();
  });
}

function wireStack(row: HTMLElement): void {
  const st = table.stack;
  const update = (e: PointerEvent): void => {
    const r = row.getBoundingClientRect();
    const sc = (row.offsetWidth ? r.width / row.offsetWidth : 1) || 1;
    table.stackPointer(
      (e.clientX - r.left) / sc,
      (e.clientY - r.top) / sc,
      live.geo.step,
      live.geo.liftPad,
      live.geo.h,
    );
    kick();
  };
  row.addEventListener("pointerdown", (e) => {
    st.touch = e.pointerType !== "mouse";
    try {
      row.setPointerCapture(e.pointerId);
    } catch {
      // Without capture the pile still follows the pointer while it stays over the row.
    }
    update(e);
  });
  row.addEventListener("pointermove", (e) => {
    if (e.pointerType === "mouse" || st.touch) update(e);
  });
  const release = (e: PointerEvent): void => {
    if (e.pointerType === "mouse") return;
    st.active = false;
    st.touch = false;
    kick();
  };
  row.addEventListener("pointerup", release);
  row.addEventListener("pointercancel", release);
  row.addEventListener("pointerleave", () => {
    if (st.touch) return;
    st.active = false;
    kick();
  });
}

function wire(): void {
  for (const c of cards) {
    if (c.sec !== "stack") wireFreeCard(c);
    // Touch long-press would open the context menu mid-drag; the mouse keeps its menu.
    c.card.addEventListener("contextmenu", (e) => {
      if (!(e instanceof PointerEvent) || e.pointerType !== "mouse") e.preventDefault();
    });
  }
  const pile = sections.find((s) => s.id === "stack");
  if (pile) wireStack(pile.row);
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
    table.resetAll();
    measure();
    kick();
  });
  // The geometry is keyed to window.innerWidth (as in the export), not to an element's size.
  // eslint-disable-next-line unicorn/prefer-observer-apis
  window.addEventListener("resize", onResize);
}

function onResize(): void {
  live.geo = geometryFor(window.innerWidth);
  render();
  requestAnimationFrame(measure);
}

wire();
onResize();
// Fonts and images settle layout after the first frame; re-measure once they have.
setTimeout(measure, 300);

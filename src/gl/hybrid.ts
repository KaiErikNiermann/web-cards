// Hybrid rendering (`?gl&hybrid`, snapshot faces): every card draws in CSS at rest, where
// Firefox keeps static cards cached, and on the overlay canvas only while it moves or is
// showcased (`data-gl-hy` on its slot takes its DOM layers out of the render tree).
//
// What keeps the two looking like one card:
// - Effects run on the card's CSS animation clock. Going to WebGL, the card's animation time
//   becomes its effect clock there; coming back, the restarted CSS animations are set to it.
// - A card goes to WebGL only with a fresh snapshot and nothing live in it: one whose face
//   changed since its snapshot, that holds focus or that has a pointer on a control stays CSS,
//   moving or not. Live text (a clock) is patched into the snapshot in place instead.
// - A card with controls or DOM parts (bake.ts, a textarea) goes to WebGL as a ghost
//   (`data-gl-ghost`): its face stays laid out but invisible, so a press (a mouse hover lifts
//   a card onto WebGL) still lands on the control, and DOM parts, which snapshots leave out,
//   stay visible over the canvas.

import { INTERACTIVE, type CardRefs } from "../dom";
import { hasDomParts, markDomParts } from "./bake";
import { elementOf, isInPart, isLiveTextOnly } from "./live";

export interface HybridOptions {
  readonly cards: readonly CardRefs[];
  /** Whether the WebGL renderer is drawing. */
  readonly isOn: () => boolean;
  /** Rasterizes these cards' faces again; resolves once the new images are in use. */
  readonly refresh: (ids: readonly string[]) => Promise<void>;
  /** Redraws a card's live text in place; false when it has none. */
  readonly hasPatchedText: (id: string) => boolean;
  /** The card being edited changed (`editing`). */
  readonly editingChanged: () => void;
}

/** A card's motion this frame: dragged or showcased (`held`), moving in the physics, at rest. */
export type Motion = "rest" | "moving" | "held";

export interface Hybrid {
  /** Whether WebGL draws the card this frame, handing it over when that changes. */
  isOnGl(c: CardRefs, motion: Motion, now: number): boolean;
  /** Seconds to add to the frame time for this card's effects (its CSS animation clock). */
  phase(id: string): number;
  /** Whether a card is on WebGL or waiting to go back, so frames must keep coming. */
  readonly isBusy: () => boolean;
  /** The card being edited (a pointer on a control, focus in a field), if any. */
  readonly editing: () => string | undefined;
}

/** How long a card stays on WebGL after it stops moving, so it does not flap. */
const SETTLE_MS = 250;
/** A changed face is snapshotted again after this long without further changes. */
const QUIET_MS = 1000;

/**
 * Focused elements a snapshot cannot show: text entry (caret, selection) and a select (its open
 * list). A focused checkbox, slider or button looks the same in a snapshot; it stays focused
 * after a click, and held its card in CSS for good.
 */
const EDITING =
  "textarea, select, [contenteditable], input:not([type=checkbox], [type=radio], [type=range], [type=button], [type=submit], [type=reset], [type=color], [type=file])";

/** Whether the card holds focus on something being edited. */
const hasFocus = (c: CardRefs): boolean => {
  const el = document.activeElement;
  return el !== null && el.matches(EDITING) && c.card.contains(el);
};

/** The card's running or paused CSS animations (its layers and face). */
const cssAnimations = (c: CardRefs): CSSAnimation[] =>
  c.card.getAnimations({ subtree: true }).filter((a) => a instanceof CSSAnimation);

export function mountHybrid(o: HybridOptions): Hybrid {
  /** Cards on WebGL, until the time (ms) they go back to CSS. */
  const until = new Map<string, number>();
  /** Cards on WebGL: effect clock minus frame time, in seconds. */
  const phases = new Map<string, number>();
  /** Cards whose face changed since their snapshot. */
  const stale = new Set<string>();
  /** Cards with a pointer down on one of their controls. */
  const pressed = new Set<string>();
  /** Cards with controls or DOM parts: on WebGL their face stays laid out, invisible. */
  const ghosts = new Set<string>();
  /**
   * Cards with DOM parts go to WebGL only while held. Pushed aside under a dragged card, a
   * note sat under the overlay canvas, which drew it without its textarea.
   */
  const withParts = new Set<string>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Bumped by each change, so a snapshot taken across a change does not count as fresh. */
  const versions = new Map<string, number>();
  let editingId: string | undefined;

  const isCssOnly = (c: CardRefs): boolean =>
    stale.has(c.def.id) || pressed.has(c.def.id) || hasFocus(c);

  function snapshotWhenQuiet(c: CardRefs): void {
    const id = c.def.id;
    clearTimeout(timers.get(id));
    timers.set(
      id,
      setTimeout(() => {
        timers.delete(id);
        // Not under a caret or a moving slider: the snapshot would catch it mid-edit.
        if (hasFocus(c) || pressed.has(id)) {
          snapshotWhenQuiet(c);
          return;
        }
        const version = versions.get(id) ?? 0;
        void o.refresh([id]).then(() => {
          if ((versions.get(id) ?? 0) === version) stale.delete(id);
        });
      }, QUIET_MS),
    );
  }

  function changed(c: CardRefs): void {
    if (!o.isOn()) return;
    const id = c.def.id;
    versions.set(id, (versions.get(id) ?? 0) + 1);
    stale.add(id);
    snapshotWhenQuiet(c);
  }

  for (const c of o.cards) {
    const face = c.card.querySelector<HTMLElement>("[data-face]");
    if (!face) continue;
    markDomParts(c.card);
    if (hasDomParts(face)) {
      c.slot.dataset.glParts = "";
      withParts.add(c.def.id);
    }
    if (hasDomParts(face) || face.querySelector(INTERACTIVE) !== null) ghosts.add(c.def.id);
    // DOM parts are not in the snapshot: their changes need no new one. Inline style is the
    // renderer's (per-frame custom properties, such as the art parallax while a card moves):
    // counted as a change, it held every dragged card in CSS. A change only to live text is
    // redrawn in place.
    new MutationObserver((all) => {
      const records = all.filter((r) => !isInPart(elementOf(r)) && r.attributeName !== "style");
      if (records.length === 0) return;
      if (o.isOn() && isLiveTextOnly(records) && o.hasPatchedText(c.def.id)) return;
      changed(c);
    }).observe(face, { subtree: true, childList: true, characterData: true, attributes: true });
    for (const type of ["input", "change", "scroll"]) {
      face.addEventListener(
        type,
        (e) => {
          if (!isInPart(e.target)) changed(c);
        },
        { capture: true, passive: true },
      );
    }
    c.card.addEventListener(
      "pointerdown",
      (e) => {
        if (!(e.target instanceof Element && e.target.closest(INTERACTIVE)) || isInPart(e.target)) {
          return;
        }

        pressed.add(c.def.id);
        syncEditing(c);
      },
      { capture: true },
    );
    c.card.addEventListener("focusin", () => {
      syncEditing(c);
    });
    c.card.addEventListener("focusout", () => {
      // Focus has not moved on yet during focusout.
      queueMicrotask(() => {
        syncEditing(c);
      });
    });
  }
  for (const type of ["pointerup", "pointercancel"]) {
    addEventListener(type, () => {
      const ids = new Set(pressed);
      pressed.clear();
      for (const c of o.cards) if (ids.has(c.def.id)) syncEditing(c);
    });
  }

  /**
   * A card being edited (a pointer on a control, focus in a field) draws flat, as in the
   * full-WebGL DOM phase (`data-gl-dom`): no material layers or face filter. With them, every
   * slider step repainted the face under its filter and blend layers (phone slider: 99/30
   * -> 102/40 fps). The other cards hold still meanwhile (main.ts).
   */
  function syncEditing(c: CardRefs): void {
    const isEditing = pressed.has(c.def.id) || hasFocus(c);
    // The renderer skips cards in the DOM phase, so one on WebGL (lifted by a hover) comes
    // back here, not in a frame.
    if (isEditing && until.delete(c.def.id)) toCss(c, performance.now());
    c.slot.toggleAttribute("data-gl-dom", isEditing);
    // This card becomes the one edited, or stops being it; another card's editing stays.
    const wasEditing = editingId === c.def.id;
    if (isEditing === wasEditing) return;
    editingId = isEditing ? c.def.id : undefined;
    o.editingChanged();
  }

  function toGl(c: CardRefs, now: number): void {
    // The card's own animation time continues on WebGL; with none running, the frame clock.
    const t = cssAnimations(c).find((a) => a.currentTime !== null)?.currentTime;
    phases.set(c.def.id, typeof t === "number" ? (t - now) / 1000 : 0);
    c.slot.toggleAttribute("data-gl-hy", true);
    if (ghosts.has(c.def.id)) c.slot.dataset.glGhost = "";
  }

  function toCss(c: CardRefs, now: number): void {
    const shift = phases.get(c.def.id) ?? 0;
    phases.delete(c.def.id);
    c.slot.toggleAttribute("data-gl-hy", false);
    delete c.slot.dataset.glGhost;
    // The layers come back with their animations restarted: set them to where WebGL was.
    for (const a of cssAnimations(c)) a.currentTime = now + shift * 1000;
  }

  return {
    isOnGl(c, motion, now) {
      const id = c.def.id;
      const isActive = withParts.has(id) ? motion === "held" : motion !== "rest";
      const wasOn = until.has(id);
      if (isActive && !isCssOnly(c)) until.set(id, now + SETTLE_MS);
      const end = until.get(id);
      const isOn = end !== undefined && now < end && !isCssOnly(c);
      if (isOn && !wasOn) toGl(c, now);
      if (!isOn && wasOn) {
        until.delete(id);
        toCss(c, now);
      }
      return isOn;
    },
    phase: (id) => phases.get(id) ?? 0,
    isBusy: () => until.size > 0,
    editing: () => editingId,
  };
}

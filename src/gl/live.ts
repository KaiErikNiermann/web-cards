// Faces whose content lives: fields to type into, controls, boxes that scroll, text that a
// script rewrites. A snapshot renderer cannot show a caret, a selection or an open select, so a
// card someone interacts with goes back to the DOM (`data-gl-dom` on its slot) for as long as
// they do, and is snapshotted again when they leave it. Content that changes on its own (a
// clock) is snapshotted again after each change.

import { INTERACTIVE, type CardRefs } from "../dom";
import { hasDomParts, isInDomPart, markDomParts } from "./bake";
import { LIVE_TEXT } from "./livetext";

export interface LiveOptions {
  readonly cards: readonly CardRefs[];
  /** Whether the WebGL renderer is drawing. */
  readonly isOn: () => boolean;
  /** Rasterizes these cards' faces again; resolves once the new images are in use. */
  readonly refresh: (ids: readonly string[]) => Promise<void>;
  /** Redraws a card's live text in place; false when it has none. */
  readonly hasPatchedText: (id: string) => boolean;
  /** A card switched between the DOM and WebGL. */
  readonly changed: () => void;
}

/** How long a card stays in the DOM after the last input on it, unless it holds focus. */
const IDLE_MS = 2500;
/** Coalesces bursts of mutations (typing, a clock's two text nodes) into one snapshot. */
const DEBOUNCE_MS = 120;
/**
 * Content that changes again this soon after a snapshot stays drawn by the DOM: a snapshot
 * took about 230 ms of the phone's main thread, and a clock face rewritten every second cost
 * every scenario 10-20 fps. It goes back to WebGL after `QUIET_MS` without changes.
 */
const VOLATILE_MS = 3000;
const QUIET_MS = 5000;

const isInDom = (c: CardRefs): boolean => c.slot.dataset.glDom !== undefined;

/** The element a mutation happened in. */
const elementOf = (r: MutationRecord): Element | null =>
  r.target instanceof Element ? r.target : r.target.parentElement;

/** Whether an event or mutation happened inside a DOM part, which the snapshot leaves out. */
const isInPart = (el: EventTarget | Element | null): boolean => el instanceof Element && isInDomPart(el);

/** Whether these mutations touched only live-text elements. */
const isLiveTextOnly = (records: readonly MutationRecord[]): boolean =>
  records.every((r) => Boolean(elementOf(r)?.closest(LIVE_TEXT)));

export function watchLiveFaces(o: LiveOptions): void {
  const pending = new Map<string, ReturnType<typeof setTimeout>>();
  const idle = new Map<string, ReturnType<typeof setTimeout>>();

  function scheduleRefresh(c: CardRefs): void {
    clearTimeout(pending.get(c.def.id));
    pending.set(
      c.def.id,
      setTimeout(() => {
        pending.delete(c.def.id);
        if (!isInDom(c)) void o.refresh([c.def.id]);
      }, DEBOUNCE_MS),
    );
  }

  async function leave(c: CardRefs): Promise<void> {
    if (!isInDom(c) || c.card.contains(document.activeElement)) return;
    // Snapshot while the face is still laid out, so scroll offsets carry over; then hand over.
    await o.refresh([c.def.id]);
    if (c.card.contains(document.activeElement)) return;
    delete c.slot.dataset.glDom;
    o.changed();
  }

  function touch(c: CardRefs): void {
    clearTimeout(idle.get(c.def.id));
    idle.set(
      c.def.id,
      setTimeout(() => {
        void leave(c);
      }, IDLE_MS),
    );
  }

  function enter(c: CardRefs): void {
    c.slot.dataset.glDom = "";
    o.changed();
    touch(c);
  }


  for (const c of o.cards) {
    const face = c.card.querySelector<HTMLElement>("[data-face]");
    if (!face) continue;
    // DOM parts (bake.ts) show through a ghost face; the rest of it stays invisible.
    markDomParts(c.card);
    if (hasDomParts(face)) c.slot.dataset.glParts = "";
    const isInteractive = face.querySelector(INTERACTIVE) !== null || hasDomParts(face);
    if (isInteractive) {
      // The face stays laid out but invisible (`data-gl-ghost`), so a press lands on the real
      // control: the slider moves, the field takes focus and the caret goes where the finger
      // is, in the same press that hands the card to the DOM.
      c.slot.dataset.glGhost = "";
      c.card.addEventListener(
        "pointerdown",
        (e) => {
          if (!o.isOn() || isInDom(c)) return;
          // A DOM part is already live; only the snapshotted controls need the DOM.
          if (e.target instanceof Element && e.target.closest(INTERACTIVE) && !isInPart(e.target)) enter(c);
        },
        { capture: true },
      );
      for (const type of ["pointerdown", "keydown", "input", "scroll", "wheel"]) {
        c.card.addEventListener(
          type,
          () => {
            if (isInDom(c)) touch(c);
          },
          { capture: true, passive: true },
        );
      }
      c.card.addEventListener("focusout", () => {
        if (isInDom(c)) touch(c);
      });
    }
    // Content changed by script or by input, while the card is drawn by WebGL.
    let lastChange = -Infinity;
    let quiet: ReturnType<typeof setTimeout> | undefined;
    const onChange = (): void => {
      if (!o.isOn()) return;
      const now = performance.now();
      const isVolatile = now - lastChange < VOLATILE_MS;
      lastChange = now;
      if (isVolatile || c.slot.dataset.glVolatile !== undefined) {
        clearTimeout(pending.get(c.def.id));
        if (c.slot.dataset.glVolatile === undefined) {
          c.slot.dataset.glVolatile = "";
          c.slot.dataset.glDom = "";
          o.changed();
        }
        clearTimeout(quiet);
        quiet = setTimeout(() => {
          delete c.slot.dataset.glVolatile;
          void leave(c);
        }, QUIET_MS);
        return;
      }
      if (!isInDom(c)) scheduleRefresh(c);
    };
    // A change only to live text (livetext.ts) is redrawn in place: no snapshot, and the card
    // stays with WebGL however often it changes.
    new MutationObserver((all) => {
      // DOM parts are not in the snapshot: their changes need no new one.
      const records = all.filter((r) => !isInPart(elementOf(r)));
      if (records.length === 0) return;
      if (o.isOn() && !isInDom(c) && isLiveTextOnly(records) && o.hasPatchedText(c.def.id)) return;
      onChange();
    }).observe(face, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    });
    for (const type of ["input", "change"]) {
      face.addEventListener(type, (e) => {
        if (!isInPart(e.target)) onChange();
      });
    }
  }
}

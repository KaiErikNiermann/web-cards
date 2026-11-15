// Crossfades between a card's DOM copy (the live, styled markup) and its WebGL drawing (the
// baked snapshot), where one hands over to the other: at start-up, and when a card enters or
// leaves the DOM phase (live.ts). The two differ a little (a snapshot is not the live page:
// layers, sampling, sub-pixel position), and switching in one frame showed as a jump. During a
// fade WebGL draws the card under its DOM copy, whose opacity runs from one to the other.
//
// On by default; `?glfade=0` or the panel's toggle (remembered per browser) switches it off,
// should a fade look wrong on some page.

import type { CardRefs } from "../dom";
import { loadFlag } from "../storage";

/** Where the panel's toggle keeps the viewer's choice. */
export const FADE_KEY = "web-cards:glfade";

/** Whether hand-offs fade: `?glfade=0` / `?glfade=1`, else the stored choice, on by default. */
export function isFadeWanted(): boolean {
  const param = new URLSearchParams(location.search).get("glfade");
  return param === null ? (loadFlag(FADE_KEY) ?? true) : param !== "0";
}

/** Which way a card is handed: to its DOM copy, or to WebGL. */
export type Handover = "dom" | "gl";

export interface FadeOptions {
  /** Fade length in ms (token --gl-fade); 0 switches at once. */
  readonly ms: number;
  /** Asks the renderer for a full redraw on the next frame. */
  readonly redraw: () => void;
}

export interface Fader {
  /** Whether WebGL draws the card although it is in the DOM phase (it is mid-fade). */
  isFading(id: string): boolean;
  /** Whether any fade runs, so frames must keep coming. */
  readonly isBusy: () => boolean;
  /**
   * Hands `c` over: to the DOM, `apply` (which marks it DOM-drawn) runs at once and its DOM
   * copy fades in over WebGL; to WebGL, WebGL draws it first and `apply` runs once its DOM copy
   * has faded out.
   */
  handover(c: CardRefs, to: Handover, apply?: () => void): void;
  /** Start-up: fades every DOM copy out over the first WebGL frames, then calls `done`. */
  fadeOutAll(cards: readonly CardRefs[], done: () => void): void;
}

/** Resolves after two animation frames: the renderer's next frame has drawn and shown. */
const afterDraw = (): Promise<void> =>
  new Promise((done) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        done();
      });
    });
  });

export function mountFader(o: FadeOptions): Fader {
  /** Cards mid-fade, with the fade's run, so a newer hand-off cancels an older one. */
  const runs = new Map<string, { readonly id: number; animation?: Animation }>();
  let next = 0;

  const fade = (el: Element, from: number, to: number): Animation =>
    el.animate([{ opacity: from }, { opacity: to }], {
      duration: o.ms,
      easing: "ease-in-out",
      fill: "forwards",
    });

  /** Whether `run` is still the card's latest hand-off. */
  const isCurrent = (cardId: string, runId: number): boolean => runs.get(cardId)?.id === runId;

  function finish(cardId: string, runId: number, animation: Animation): void {
    if (!isCurrent(cardId, runId)) return;
    animation.cancel();
    runs.delete(cardId);
    o.redraw();
  }

  /** Waits for a fade; false when it was cancelled (a newer hand-off took over). */
  const isFinished = async (a: Animation): Promise<boolean> => {
    try {
      await a.finished;
      return true;
    } catch {
      return false;
    }
  };

  async function toGl(c: CardRefs, runId: number, from: number, apply?: () => void): Promise<void> {
    const cardId = c.def.id;
    await afterDraw();
    const run = runs.get(cardId);
    if (run?.id !== runId) return;
    run.animation = fade(c.card, from, 0);
    if (!(await isFinished(run.animation)) || !isCurrent(cardId, runId)) return;
    apply?.();
    finish(cardId, runId, run.animation);
  }

  async function toDom(c: CardRefs, runId: number, from: number): Promise<void> {
    const run = runs.get(c.def.id);
    if (run?.id !== runId) return;
    run.animation = fade(c.card, from, 1);
    if (await isFinished(run.animation)) finish(c.def.id, runId, run.animation);
  }

  return {
    isFading: (id) => runs.has(id),
    isBusy: () => runs.size > 0,
    handover(c, to, apply) {
      const cardId = c.def.id;
      const previous = runs.get(cardId)?.animation;
      // A fade turned around mid-way starts from where the last one got to.
      const opacity = previous ? Number(getComputedStyle(c.card).opacity) : undefined;
      previous?.cancel();
      runs.delete(cardId);
      if (o.ms <= 0) {
        apply?.();
        o.redraw();
        return;
      }
      next += 1;
      runs.set(cardId, { id: next });
      o.redraw();
      if (to === "dom") {
        apply?.();
        void toDom(c, next, opacity ?? 0);
      } else void toGl(c, next, opacity ?? 1, apply);
    },
    fadeOutAll(cards, done) {
      if (o.ms <= 0) {
        done();
        return;
      }
      void afterDraw().then(async () => {
        const animations = cards.map((c) => fade(c.card, 1, 0));
        await Promise.allSettled(animations.map((a) => a.finished));
        done();
        for (const a of animations) a.cancel();
      });
    },
  };
}

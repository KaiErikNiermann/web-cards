// Scripted interactions, each a fresh page load: a setup step (scroll the target into view),
// then the measured act. The same script runs with a mouse (desktop) or touch (phone).

import type { CDPSession, Page } from "playwright";

export type ProfileId = "desktop" | "phone";

export interface Profile {
  readonly id: ProfileId;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly scale: number;
  readonly touch: boolean;
  /** CDP CPU slowdown factor, to stand in for a phone's slower cores. */
  readonly cpu: number;
  /** Fan step of an open full-size pile at this width (geometryFor in src/data.ts). */
  readonly step: number;
}

export const PROFILES: Readonly<Record<ProfileId, Profile>> = {
  desktop: {
    id: "desktop",
    viewport: { width: 1440, height: 900 },
    scale: 1,
    touch: false,
    cpu: 1,
    step: 40,
  },
  phone: {
    id: "phone",
    viewport: { width: 390, height: 844 },
    scale: 3,
    touch: true,
    cpu: 4,
    step: 22,
  },
};

/** Pointer input in CSS px of the viewport. */
export interface Pointer {
  readonly isTouch: boolean;
  down(x: number, y: number): Promise<void>;
  move(x: number, y: number): Promise<void>;
  up(x: number, y: number): Promise<void>;
}

const FRAME_MS = 16;

export function mousePointer(page: Page): Pointer {
  return {
    isTouch: false,
    down: async (x, y) => {
      await page.mouse.move(x, y);
      await page.mouse.down();
    },
    move: async (x, y) => {
      await page.mouse.move(x, y);
    },
    up: async (x, y) => {
      await page.mouse.move(x, y);
      await page.mouse.up();
    },
  };
}

export function touchPointer(cdp: CDPSession): Pointer {
  const send = async (
    type: "touchStart" | "touchMove" | "touchEnd",
    x: number,
    y: number,
  ): Promise<void> => {
    const touchPoints = type === "touchEnd" ? [] : [{ x, y, id: 1 }];
    await cdp.send("Input.dispatchTouchEvent", { type, touchPoints });
  };
  return {
    isTouch: true,
    down: (x, y) => send("touchStart", x, y),
    move: (x, y) => send("touchMove", x, y),
    up: (x, y) => send("touchEnd", x, y),
  };
}

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface Ctx {
  readonly page: Page;
  readonly ptr: Pointer;
  readonly profile: Profile;
}

const wait = (page: Page, ms: number): Promise<void> => page.waitForTimeout(ms);

async function box(page: Page, id: string): Promise<Box> {
  const b = await page.locator(`[data-card="${id}"]`).boundingBox();
  if (!b) throw new Error(`no box for card ${id}`);
  return b;
}

export async function reveal(page: Page, id: string): Promise<void> {
  await page.locator(`[data-card="${id}"]`).evaluate((el) => {
    el.scrollIntoView({ block: "center", behavior: "instant" });
  });
  await wait(page, 300);
}

/** Moves in `n` steps from (x0, y0) to (x1, y1), one step per frame. */
async function glide(
  c: Ctx,
  from: readonly [number, number],
  to: readonly [number, number],
  n: number,
) {
  for (let i = 1; i <= n; i += 1) {
    const t = i / n;
    await c.ptr.move(from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t);
    await wait(c.page, FRAME_MS);
  }
}

const centre = (b: Box): [number, number] => [b.x + b.width / 2, b.y + b.height / 2];

export interface Scenario {
  readonly id: string;
  /** Only meaningful with a hovering pointer. */
  readonly mouseOnly?: true;
  /** Card scrolled into view before measuring. */
  readonly target: string;
  act(c: Ctx): Promise<void>;
}

/** Drags `id` to the far end of its row and back, then lets the row settle. */
async function dragAcross(c: Ctx, id: string, last: string): Promise<void> {
  const a = centre(await box(c.page, id));
  const z = centre(await box(c.page, last));
  await c.ptr.down(...a);
  await glide(c, a, [z[0], a[1] + 20], 60);
  await glide(c, [z[0], a[1] + 20], a, 60);
  await c.ptr.up(...a);
  await wait(c.page, 800);
}

/** Points along a closed pile from its left edge across `cards` fan steps. */
async function scrubPile(c: Ctx, cards: number): Promise<{ x: number; y: number }> {
  const b = await box(c.page, "s-live");
  const y = b.y + b.height / 2;
  const x0 = b.x + 6;
  const x1 = x0 + cards * c.profile.step;
  if (c.ptr.isTouch) await c.ptr.down(x0, y);
  else await c.ptr.move(x0, y);
  await glide(c, [x0, y], [x1, y], 40);
  return { x: x1, y };
}

export const SCENARIOS: readonly Scenario[] = [
  {
    id: "idle",
    target: "qh",
    act: (c) => wait(c.page, 2000),
  },
  {
    id: "hover-row",
    mouseOnly: true,
    target: "qh",
    act: async (c) => {
      const a = await box(c.page, "qh");
      const z = await box(c.page, "cover");
      const y = a.y + a.height * 0.4;
      await glide(c, [a.x + 5, y], [z.x + z.width - 5, y], 90);
      await glide(c, [z.x + z.width - 5, y], [a.x + 5, y], 90);
      await c.ptr.move(a.x + 5, a.y - 60);
      await wait(c.page, 600);
    },
  },
  {
    id: "drag-row",
    target: "qh",
    act: (c) => dragAcross(c, "qh", "cover"),
  },
  {
    id: "drag-mini",
    target: "m-qh",
    act: (c) => dragAcross(c, "m-qh", "m-orbit"),
  },
  {
    id: "pile-scrub",
    target: "s-live",
    act: async (c) => {
      const at = await scrubPile(c, 7);
      if (c.ptr.isTouch) await c.ptr.up(at.x, at.y);
      else await c.ptr.move(at.x, at.y - 400);
      await wait(c.page, 600);
    },
  },
  {
    id: "pile-take",
    target: "s-live",
    act: async (c) => {
      const at = await scrubPile(c, 4);
      if (c.ptr.isTouch) await wait(c.page, 550);
      else await c.ptr.down(at.x, at.y);
      await glide(c, [at.x, at.y], [at.x + 60, at.y + 160], 40);
      await c.ptr.up(at.x + 60, at.y + 160);
      await wait(c.page, 900);
    },
  },
  {
    id: "fold",
    target: "qh",
    act: async (c) => {
      const a = centre(await box(c.page, "qh"));
      const b = centre(await box(c.page, "as"));
      await c.ptr.down(...a);
      await glide(c, a, b, 12);
      await wait(c.page, 450);
      await c.ptr.up(...b);
      await wait(c.page, 900);
    },
  },
];

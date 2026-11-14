// Frame rate of built versions of the card table in Chrome for Android, over adb and CDP.
//
//   node bench/phone-chrome.ts VERSION [VERSION ...] [--rounds 3]
//
// Expects Chrome running on the device with its DevTools socket forwarded to localhost:9333
// (`adb forward tcp:9333 localabstract:chrome_devtools_remote`) and the built versions served
// from this host on port 18766, reachable on the device through `adb reverse tcp:18766`.
// Measures the same sections and gestures as bench/phone.py (Firefox): idle with each section
// in view, a card dragged along the full-size row, and a finger slid along the Stack, with
// touch events sent through CDP.

import { parseArgs } from "node:util";

import {
  chromium,
  type Browser,
  type BrowserContext,
  type CDPSession,
  type Page,
} from "playwright";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { rounds: { type: "string", default: "3" } },
});
const SECTIONS: Record<string, string | undefined> = {
  top: undefined,
  animated: "a-orbit",
  stack: "s-live",
  cardlets: "m-orbit",
};
const GESTURES: Record<string, [string, number, number]> = {
  "drag-row": ["qh", 220, 40],
  "scrub-stack": ["s-live", 120, 0],
};
const FRAMES = `new Promise((done) => { const ts = []; const t0 = performance.now();
  const loop = (t) => { ts.push(t); if (t - t0 < 3000) requestAnimationFrame(loop); else done((ts.length - 1) / ((ts.at(-1) - ts[0]) / 1000)); };
  requestAnimationFrame(loop); })`;

async function reveal(page: Page, target: string): Promise<void> {
  await page.evaluate((t) => {
    document.querySelector(`[data-card="${CSS.escape(t)}"]`)?.scrollIntoView({ block: "center" });
  }, target);
  await page.waitForTimeout(1000);
}

async function gesture(
  page: Page,
  cdp: CDPSession,
  [target, dx, dy]: [string, number, number],
): Promise<number> {
  await reveal(page, target);
  const [x, y] = await page.evaluate((t) => {
    const el = document.querySelector(`[data-card="${CSS.escape(t)}"]`);
    if (!el) throw new Error(`no card ${t}`);
    const r = el.getBoundingClientRect();
    return [r.x + r.width / 2, r.y + r.height / 2];
  }, target);
  await page.evaluate(
    `window.__t = []; window.__on = true; (function l(t) { if (!window.__on) return; window.__t.push(t); requestAnimationFrame(l); })(performance.now())`,
  );
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  for (let i = 1; i <= 30; i += 1) {
    await page.waitForTimeout(50);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: x + (dx * i) / 30, y: y + (dy * i) / 30 }],
    });
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  return page.evaluate<number>(
    `(() => { window.__on = false; const ts = window.__t; return (ts.length - 1) / ((ts.at(-1) - ts[0]) / 1000); })()`,
  );
}

/** Chrome on the device, its first browser context and a page in it. */
async function connect(): Promise<{ browser: Browser; context: BrowserContext; page: Page }> {
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9333");
  const context = browser.contexts()[0];
  if (!context) throw new Error("Chrome has no browser context: is it open on the device?");
  return { browser, context, page: context.pages()[0] ?? (await context.newPage()) };
}

const { browser, context, page } = await connect();
const cdp = await context.newCDPSession(page);
const results = new Map<string, number[]>();
const add = (k: string, v: number): void => {
  results.set(k, [...(results.get(k) ?? []), v]);
};
for (let r = 0; r < Number(values.rounds); r += 1) {
  for (const v of positionals) {
    const url = `http://127.0.0.1:18766/${v}/index.html`;
    for (const [section, target] of Object.entries(SECTIONS)) {
      await page.goto(url);
      if (target) await reveal(page, target);
      else await page.waitForTimeout(1000);
      add(`${v}|${section}`, await page.evaluate<number>(FRAMES));
    }
    for (const [name, g] of Object.entries(GESTURES)) {
      await page.goto(url);
      add(`${v}|${name}`, await gesture(page, cdp, g));
    }
  }
}
const cols = [...Object.keys(SECTIONS), ...Object.keys(GESTURES)];
const median = (xs: number[]): number =>
  xs.toSorted((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
console.log(`Chrome ${browser.version()}`);
console.log("version".padEnd(10) + cols.map((c) => c.padStart(13)).join(""));
for (const v of positionals) {
  console.log(
    v.padEnd(10) +
      cols
        .map((c) =>
          median(results.get(`${v}|${c}`) ?? [])
            .toFixed(1)
            .padStart(13),
        )
        .join(""),
  );
}
await browser.close();

// Hybrid rendering (?hybrid&lab, src/gl/hybrid.ts) in desktop Firefox at phone size: that
// effects, Lab input and scrolling stay whole across the handovers between CSS and WebGL.
//
//   node bench/hybrid-check.ts        (just hybrid-check; serves the built dist/)
//
// Checks: an effect's CSS clock runs on across a drag (no phase jump); typing, focus and a
// pressed control hold a card in CSS; a changed face waits for its new snapshot; DOM parts (the
// note's textarea) stay visible and on top; the slider moves and the other cards hold still
// meanwhile; the clock's live text keeps ticking on WebGL; cards scroll as WebGL and come back
// to CSS. Exits 1 when a check fails.

import path from "node:path";

import { firefox, type Page } from "playwright";
import { preview } from "vite";

const ROOT = path.resolve(import.meta.dirname, "..");
const PORT = 4791;

interface Check {
  readonly name: string;
  readonly isOk: boolean;
  readonly detail: string;
}

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

const checks: Check[] = [];
const check = (name: string, isOk: boolean, detail = ""): void => {
  checks.push({ name, isOk, detail });
};

const card = (id: string): string => `[data-card="${id}"]`;

async function boxOf(page: Page, selector: string): Promise<Box> {
  const box = await page.locator(selector).boundingBox();
  if (!box) throw new Error(`no box for ${selector}`);
  return box;
}

/** Scrolls the card to the middle of the screen and returns its box. */
async function show(page: Page, id: string): Promise<Box> {
  await page.locator(card(id)).evaluate((el) => {
    el.scrollIntoView({ block: "center" });
  });
  await page.waitForTimeout(300);
  return boxOf(page, `${card(id)} .card`);
}

const isMarked = (page: Page, id: string, attr: string): Promise<boolean> =>
  page.locator(card(id)).evaluate((el, a) => el.hasAttribute(a), attr);

const count = (page: Page, selector: string): Promise<number> =>
  page.evaluate((s) => document.querySelectorAll(s).length, selector);

/** The card's data attributes and the focused element, for failure details. */
const state = (page: Page, id: string): Promise<string> =>
  page.locator(card(id)).evaluate(
    (el) =>
      [...el.attributes]
        .map((a) => a.name)
        .filter((n) => n.startsWith("data-") && n !== "data-card")
        .join(" ") + ` active=${document.activeElement?.tagName ?? ""}`,
  );

/** Two animation frames: a handover runs in the frame after its cause. */
const frames = (page: Page): Promise<void> =>
  page.evaluate(
    () =>
      new Promise<void>((done) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            done();
          });
        });
      }),
  );

/** A mouse drag by (dx, dy) from (x, y), left held. */
async function press(page: Page, x: number, y: number, dx: number, dy: number): Promise<void> {
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 8 });
}

async function rest(page: Page, ms: number): Promise<void> {
  await page.mouse.up();
  await page.mouse.move(2, 2);
  await page.waitForTimeout(ms);
}

/** The first CSS animation's time in the card and the timeline's, read together. */
const clock = (page: Page, id: string): Promise<{ t: number; now: number }> =>
  page.locator(`${card(id)} .card`).evaluate((el) => {
    const [a] = el.getAnimations({ subtree: true });
    return { t: Number(a?.currentTime ?? NaN), now: Number(document.timeline.currentTime) };
  });

async function effectPhase(page: Page): Promise<void> {
  const id = "a-orbit";
  const b = await show(page, id);
  await page.mouse.move(2, 2);
  await page.waitForTimeout(400);
  const before = await clock(page, id);
  await press(page, b.x + b.width / 2, b.y + b.height / 2, 60, 20);
  check("an orbit card goes to WebGL while dragged", await isMarked(page, id, "data-gl-hy"));
  // Released away from the start, so it is a drag, not a tap that opens the showcase.
  await page.mouse.move(b.x + b.width / 2 + 120, b.y + b.height / 2 + 30, { steps: 8 });
  await rest(page, 2500);
  check("the drag did not open the showcase", !(await isMarked(page, id, "data-show")));
  check("the card is back on CSS after settling", !(await isMarked(page, id, "data-gl-hy")));
  const after = await clock(page, id);
  const drift = after.t - before.t - (after.now - before.now);
  check(
    "its CSS clock ran on across the handover (|drift| < 40 ms)",
    Math.abs(drift) < 40,
    `drift ${drift.toFixed(1)} ms`,
  );
}

async function note(page: Page): Promise<void> {
  const id = "l-note";
  const area = `${card(id)} textarea`;
  await show(page, id);
  await page.locator(area).click();
  await page.keyboard.type(" XYZZY");
  await frames(page);
  check(
    "focus in the textarea holds the note in CSS",
    !(await isMarked(page, id, "data-gl-hy")),
    await state(page, id),
  );
  const typed = await page.locator(area).inputValue();
  check("typing reaches the textarea", typed.includes("XYZZY"));
  await page.locator(area).evaluate((el) => {
    if (el instanceof HTMLElement) el.blur();
  });
  await rest(page, 2500);
  const b = await show(page, id);
  await press(page, b.x + b.width / 2, b.y + b.height - 5, 50, 0);
  const isOnGl = await isMarked(page, id, "data-gl-hy");
  const part = await page.locator(area).evaluate((el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return {
      visible: s.visibility === "visible" && s.display !== "none",
      hit: document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === el,
    };
  });
  await rest(page, 800);
  check("the dragged note goes to WebGL", isOnGl);
  check(
    "its textarea stays visible and on top meanwhile",
    part.visible && part.hit,
    JSON.stringify(part),
  );
}

async function form(page: Page): Promise<void> {
  const id = "l-form";
  const title = `${card(id)} form > span`;
  await show(page, id);
  const box = page.locator(`${card(id)} input[type=checkbox]`).nth(1);
  await box.click();
  check("a checkbox click reaches the control", await box.isChecked());
  let t = await boxOf(page, title);
  await press(page, t.x + t.width / 2, t.y + t.height / 2, 50, 0);
  check("a changed face stays CSS until snapshotted again", !(await isMarked(page, id, "data-gl-hy")));
  await rest(page, 2500);
  await show(page, id);
  t = await boxOf(page, title);
  await press(page, t.x + t.width / 2, t.y + t.height / 2, 50, 0);
  check("then it goes to WebGL", await isMarked(page, id, "data-gl-hy"), await state(page, id));
  const pushed = await page.locator(`${card("l-note")} textarea`).evaluate((el) => {
    const r = el.getBoundingClientRect();
    return {
      onGl: el.closest(".slot")?.hasAttribute("data-gl-hy") ?? false,
      hit: document.elementFromPoint(r.x + r.width / 2, r.y + 8) === el,
    };
  });
  check(
    "the note pushed aside stays CSS, its textarea on top",
    !pushed.onGl && pushed.hit,
    JSON.stringify(pushed),
  );
  await rest(page, 800);

  await show(page, id);
  const range = page.locator(`${card(id)} input[type=range]`);
  const r = await boxOf(page, `${card(id)} input[type=range]`);
  const v0 = Number(await range.inputValue());
  await page.mouse.move(r.x + r.width * 0.7, r.y + r.height / 2);
  await page.mouse.down();
  await page.mouse.move(r.x + r.width * 0.2, r.y + r.height / 2, { steps: 8 });
  const isOnGl = await isMarked(page, id, "data-gl-hy");
  const still = await count(page, ".slot[data-still]");
  const all = await count(page, ".slot");
  await page.mouse.up();
  await frames(page);
  const stillAfter = await count(page, ".slot[data-still]");
  const v1 = Number(await range.inputValue());
  check("a slider drag moves the value", v1 < v0 - 20, `${String(v0)} -> ${String(v1)}`);
  check("the card stays CSS while its slider is held", !isOnGl);
  check(
    "the other cards hold still meanwhile, not after",
    still === all - 1 && stillAfter < still,
    `${String(still)}/${String(all)} during, ${String(stillAfter)} after`,
  );
  await page.locator(`${card(id)} select`).selectOption("Square");
  check("the select changes", (await page.locator(`${card(id)} select`).inputValue()) === "Square");
  await rest(page, 2500);
}

async function clockCard(page: Page): Promise<void> {
  const id = "l-clock";
  const b = await show(page, id);
  const x = b.x + b.width / 2;
  const y = b.y + b.height / 2;
  await press(page, x, y, 40, 0);
  const t0 = await page.locator(`${card(id)} [data-clock]`).textContent();
  for (let i = 0; i < 10; i += 1) await page.mouse.move(x + 40 + (i % 2) * 6, y, { steps: 3 });
  await page.waitForTimeout(1200);
  await page.mouse.move(x + 46, y, { steps: 3 });
  const isOnGl = await isMarked(page, id, "data-gl-hy");
  const t1 = await page.locator(`${card(id)} [data-clock]`).textContent();
  await rest(page, 800);
  check(
    "the clock stays on WebGL while its live text ticks",
    isOnGl && t0 !== t1,
    `${t0 ?? ""} -> ${t1 ?? ""}`,
  );
}

async function scrolling(page: Page): Promise<void> {
  await page.evaluate(() => {
    scrollTo(0, 900);
  });
  await page.mouse.move(2, 400);
  await page.waitForTimeout(800);
  await page.mouse.wheel(0, 300);
  await page.waitForTimeout(60);
  const during = await count(page, ".slot[data-gl-hy]");
  await page.mouse.wheel(0, -300);
  await page.waitForTimeout(900);
  const after = await count(page, ".slot[data-gl-hy]");
  check(
    "cards scroll as WebGL and come back to CSS",
    during > 5 && after === 0,
    `${String(during)} during, ${String(after)} after`,
  );
}

const server = await preview({
  root: ROOT,
  preview: { port: PORT, strictPort: true },
  logLevel: "warn",
});
const browser = await firefox.launch();
try {
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
  });
  const errors: string[] = [];
  page.on("pageerror", (e) => {
    errors.push(String(e));
  });
  await page.goto(`http://localhost:${String(PORT)}/index.html?hybrid&lab`);
  await page.waitForFunction(
    () => document.querySelector<HTMLElement>("[data-root]")?.dataset.gl === "on",
    undefined,
    {
      timeout: 30_000,
    },
  );
  await page.mouse.move(2, 2);
  for (const step of [effectPhase, note, form, clockCard, scrolling]) await step(page);
  check("no page errors", errors.length === 0, errors.join("; "));
} finally {
  await browser.close();
  await server.close();
}
for (const c of checks) {
  const detail = c.detail ? `  (${c.detail})` : "";
  console.log(`${c.isOk ? "PASS" : "FAIL"}  ${c.name}${detail}`);
}
const passed = checks.filter((c) => c.isOk).length;
console.log(`${String(passed)}/${String(checks.length)} passed`);
if (passed < checks.length) process.exitCode = 1;

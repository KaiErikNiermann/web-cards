// Bakes the faces and card backs marked data-bake="build" (src/gl/bake.ts) into images, after
// `vite build`: serves the build, opens it in headless Chromium with `?bake`, and screenshots
// every staged cell (src/gl/bakestage.ts) at SCALE device px per artboard px. Writes the images
// and baked/manifest.json into the build, where the WebGL renderer loads them in place of a
// snapshot on the device.
//
//   node scripts/bake-faces.ts [--scale 4]

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { chromium } from "playwright";
import { preview } from "vite";

import type { BakeManifest } from "../src/gl/bake.ts";

const { values } = parseArgs({ options: { scale: { type: "string", default: "4" } } });
const scale = Number(values.scale);
if (Number.isNaN(scale) || scale <= 0) throw new Error(`bake: --scale must be a positive number, got ${values.scale}`);

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT = path.join(ROOT, "dist", "baked");
const PORT = 18_790;

const server = await preview({ root: ROOT, logLevel: "warn", preview: { port: PORT, strictPort: true } });
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: scale });
  page.on("pageerror", (e) => {
    throw e;
  });
  const url = server.resolvedUrls?.local[0];
  if (url === undefined) throw new Error("bake: the preview server has no local URL");
  await page.goto(`${url}?bake`);
  await page.waitForFunction(() => "bakeStage" in globalThis, undefined, { timeout: 60_000 });
  const keys = await page.evaluate(() => (Reflect.get(globalThis, "bakeStage") as { keys: string[] }).keys);
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  const images: Record<string, string> = {};
  for (const key of keys) {
    const file = `${key}.png`;
    await page.locator(`[data-bake-key="${key}"]`).screenshot({ path: path.join(OUT, file), omitBackground: true });
    images[key] = file;
  }
  const manifest: BakeManifest = { scale, images };
  writeFileSync(path.join(OUT, "manifest.json"), `${JSON.stringify(manifest, undefined, 1)}\n`);
  process.stdout.write(`bake: ${String(keys.length)} images at ${String(scale)}x in dist/baked\n`);
} finally {
  await browser.close();
  await server.close();
}

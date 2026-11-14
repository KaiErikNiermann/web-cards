// Timing and memory benchmark of the production build in headless Chromium.
//
//   node bench/run.ts [--label NAME] [--runs N] [--profile desktop|phone] [--compare FILE]
//                     [--scenario ID ...]
//
// Builds the site, serves dist/, runs every scenario (bench/scenarios.ts) `runs` times per
// profile on a fresh page, and writes the per-field medians to bench/results/NAME.json.
// With --compare, prints each field next to the same field of an earlier result file.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { chromium, type Browser } from "playwright";
import { build, preview } from "vite";

import { Probe, type Sample } from "./probe.ts";
import {
  PROFILES,
  SCENARIOS,
  mousePointer,
  reveal,
  touchPointer,
  type Profile,
  type ProfileId,
  type Scenario,
} from "./scenarios.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const RESULTS = path.join(ROOT, "bench", "results");
const PORT = 4319;

type Results = Partial<Record<ProfileId, Record<string, Sample>>>;

interface ResultFile {
  readonly label: string;
  readonly date: string;
  readonly commit: string;
  readonly browser: string;
  readonly runs: number;
  readonly results: Results;
}

const median = (xs: readonly number[]): number => {
  const s = xs.toSorted((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? (s[m] ?? 0) : ((s[m - 1] ?? 0) + (s[m] ?? 0)) / 2;
};

/** Per-field median of several samples of one scenario. */
function medianSample(samples: readonly Sample[]): Sample {
  const f = (pick: (s: Sample) => number): number => median(samples.map((s) => pick(s)));
  return {
    frame: {
      frames: f((s) => s.frame.frames),
      p50: f((s) => s.frame.p50),
      p95: f((s) => s.frame.p95),
      max: f((s) => s.frame.max),
      long: f((s) => s.frame.long),
    },
    scriptMs: f((s) => s.scriptMs),
    styleMs: f((s) => s.styleMs),
    layoutMs: f((s) => s.layoutMs),
    taskMs: f((s) => s.taskMs),
    styleCount: f((s) => s.styleCount),
    layoutCount: f((s) => s.layoutCount),
    paintMs: f((s) => s.paintMs),
    compositeMs: f((s) => s.compositeMs),
    heapMb: f((s) => s.heapMb),
    nodes: f((s) => s.nodes),
    layers: f((s) => s.layers),
    layerMpx: f((s) => s.layerMpx),
  };
}

async function runOnce(browser: Browser, profile: Profile, sc: Scenario): Promise<Sample> {
  const context = await browser.newContext({
    viewport: profile.viewport,
    deviceScaleFactor: profile.scale,
    hasTouch: profile.touch,
    isMobile: profile.touch,
  });
  try {
    const page = await context.newPage();
    await page.goto(`http://localhost:${String(PORT)}/`, { waitUntil: "load" });
    // The page re-lays out once fonts and images settle (setTimeout 300 in main.ts).
    await page.waitForTimeout(600);
    const probe = await Probe.attach(browser, page);
    if (profile.cpu > 1) {
      await probe.session.send("Emulation.setCPUThrottlingRate", { rate: profile.cpu });
    }
    await reveal(page, sc.target);
    const ptr = profile.touch ? touchPointer(probe.session) : mousePointer(page);
    await probe.start();
    await sc.act({ page, ptr, profile });
    return await probe.stop();
  } finally {
    await context.close();
  }
}

function pct(now: number, then: number | undefined): string {
  if (then === undefined || then === 0) return "";
  const d = ((now - then) / then) * 100;
  return ` (${d >= 0 ? "+" : ""}${d.toFixed(0)}%)`;
}

const COLUMNS: readonly [string, (s: Sample) => number, number][] = [
  ["p95 ms", (s) => s.frame.p95, 1],
  ["long", (s) => s.frame.long, 0],
  ["script", (s) => s.scriptMs, 0],
  ["style", (s) => s.styleMs, 0],
  ["layout", (s) => s.layoutMs, 0],
  ["paint", (s) => s.paintMs, 0],
  ["composite", (s) => s.compositeMs, 0],
  ["task", (s) => s.taskMs, 0],
  ["heap MB", (s) => s.heapMb, 1],
  ["layers", (s) => s.layers, 0],
  ["layer Mpx", (s) => s.layerMpx, 1],
];

function report(now: Results, then: Results | undefined): void {
  const rows: Record<string, Record<string, string>> = {};
  for (const [pid, byScenario] of Object.entries(now) as [ProfileId, Record<string, Sample>][]) {
    for (const [sid, s] of Object.entries(byScenario)) {
      const old = then?.[pid]?.[sid];
      rows[`${pid} ${sid}`] = Object.fromEntries(
        COLUMNS.map(([name, pick, digits]) => [
          name,
          pick(s).toFixed(digits) + pct(pick(s), old && pick(old)),
        ]),
      );
    }
  }
  console.table(rows);
}

function gitCommit(): string {
  try {
    // A developer tool run from the repository, with the developer's own PATH.
    // eslint-disable-next-line sonarjs/no-os-command-from-path
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT }).toString().trim();
  } catch {
    return "unknown";
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      label: { type: "string", default: "run" },
      runs: { type: "string", default: "3" },
      profile: { type: "string" },
      compare: { type: "string" },
      scenario: { type: "string", multiple: true },
    },
  });
  const runs = Math.max(1, Number(values.runs));
  const profiles = Object.values(PROFILES).filter(
    (p) => values.profile === undefined || p.id === values.profile,
  );
  await build({ root: ROOT, logLevel: "warn" });
  const server = await preview({ root: ROOT, preview: { port: PORT, strictPort: true } });
  const browser = await chromium.launch();
  const results: Results = {};
  try {
    for (const profile of profiles) {
      const byScenario: Record<string, Sample> = {};
      for (const sc of SCENARIOS) {
        if (sc.mouseOnly && profile.touch) continue;
        if (values.scenario && !values.scenario.includes(sc.id)) continue;
        const samples: Sample[] = [];
        for (let i = 0; i < runs; i += 1) samples.push(await runOnce(browser, profile, sc));
        byScenario[sc.id] = medianSample(samples);
        process.stderr.write(`${profile.id} ${sc.id} done\n`);
      }
      results[profile.id] = byScenario;
    }
  } finally {
    await browser.close();
    await server.close();
  }
  const file: ResultFile = {
    label: values.label,
    date: new Date().toISOString(),
    commit: gitCommit(),
    browser: chromium.name(),
    runs,
    results,
  };
  mkdirSync(RESULTS, { recursive: true });
  const out = path.join(RESULTS, `${values.label}.json`);
  writeFileSync(out, `${JSON.stringify(file, undefined, 2)}\n`);
  const then =
    values.compare === undefined
      ? undefined
      : (JSON.parse(readFileSync(values.compare, "utf8")) as ResultFile).results;
  report(results, then);
  process.stderr.write(`wrote ${path.relative(ROOT, out)}\n`);
}

await main();

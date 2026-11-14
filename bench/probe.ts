// Measurement around one scenario run: frame intervals from a rAF recorder in the page, main
// thread time from CDP metrics, paint and composite time from a trace, and memory (JS heap
// after GC, DOM nodes, composited layers and their pixel area as a GPU-memory proxy).

import type { Browser, CDPSession, Page } from "playwright";

export interface FrameStats {
  readonly frames: number;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
  /** Intervals longer than 1.5 vsyncs at 60 Hz: frames the user sees as dropped. */
  readonly long: number;
}

export interface Sample {
  readonly frame: FrameStats;
  /** Main-thread milliseconds over the scenario, by kind. */
  readonly scriptMs: number;
  readonly styleMs: number;
  readonly layoutMs: number;
  readonly taskMs: number;
  readonly styleCount: number;
  readonly layoutCount: number;
  /** Trace time in paint and compositing phases, by event name. */
  readonly paintMs: number;
  readonly compositeMs: number;
  readonly heapMb: number;
  readonly nodes: number;
  readonly layers: number;
  /** Width × height of every composited layer that draws content, in megapixels. */
  readonly layerMpx: number;
}

const PAINT_EVENTS = new Set(["Paint", "PrePaint", "PaintImage", "RasterTask"]);
const COMPOSITE_EVENTS = new Set(["Layerize", "Commit", "UpdateLayer", "CompositeLayers"]);
const TRACE_CATEGORIES = ["devtools.timeline", "disabled-by-default-devtools.timeline"];

interface Metric {
  readonly name: string;
  readonly value: number;
}

interface TraceEvent {
  readonly name?: string;
  readonly ph?: string;
  readonly dur?: number;
}

interface Layer {
  readonly drawsContent: boolean;
  readonly width: number;
  readonly height: number;
}

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[i] ?? 0;
}

function frameStats(stamps: readonly number[]): FrameStats {
  const gaps = stamps.slice(1).map((t, i) => t - (stamps[i] ?? t));
  const sorted = gaps.toSorted((a, b) => a - b);
  return {
    frames: gaps.length,
    p50: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95),
    max: sorted.at(-1) ?? 0,
    long: gaps.filter((g) => g > 25).length,
  };
}

async function metrics(cdp: CDPSession): Promise<ReadonlyMap<string, number>> {
  const { metrics: list } = (await cdp.send("Performance.getMetrics")) as {
    metrics: readonly Metric[];
  };
  return new Map(list.map((m) => [m.name, m.value]));
}

function traceTotals(buf: Buffer): { paintMs: number; compositeMs: number } {
  const parsed = JSON.parse(buf.toString("utf8")) as { traceEvents?: readonly TraceEvent[] };
  let paint = 0;
  let composite = 0;
  const events = parsed.traceEvents ?? [];
  for (const ev of events) {
    if (ev.ph !== "X" || ev.name === undefined || ev.dur === undefined) continue;
    if (PAINT_EVENTS.has(ev.name)) paint += ev.dur;
    else if (COMPOSITE_EVENTS.has(ev.name)) composite += ev.dur;
  }
  return { paintMs: paint / 1000, compositeMs: composite / 1000 };
}

/** Starts a rAF recorder in the page; frames are read back by `stop`. */
const START_FRAMES = `(() => {
  const w = window;
  w.__benchFrames = [];
  w.__benchOn = true;
  const loop = (t) => { if (!w.__benchOn) return; w.__benchFrames.push(t); requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
})()`;

const STOP_FRAMES = `(() => { window.__benchOn = false; return window.__benchFrames; })()`;

/** One measured window: call `start`, drive the page, then `stop`. */
export class Probe {
  private before: ReadonlyMap<string, number> = new Map();
  private layers: readonly Layer[] = [];
  private readonly browser: Browser;
  private readonly page: Page;
  private readonly cdp: CDPSession;

  private constructor(browser: Browser, page: Page, cdp: CDPSession) {
    this.browser = browser;
    this.page = page;
    this.cdp = cdp;
    cdp.on("LayerTree.layerTreeDidChange", (e: { layers?: readonly Layer[] }) => {
      if (e.layers) this.layers = e.layers;
    });
  }

  static async attach(browser: Browser, page: Page): Promise<Probe> {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Performance.enable");
    await cdp.send("LayerTree.enable");
    return new Probe(browser, page, cdp);
  }

  get session(): CDPSession {
    return this.cdp;
  }

  async start(): Promise<void> {
    await this.browser.startTracing(this.page, { categories: TRACE_CATEGORIES });
    this.before = await metrics(this.cdp);
    await this.page.evaluate(START_FRAMES);
  }

  async stop(): Promise<Sample> {
    const stamps = await this.page.evaluate<readonly number[]>(STOP_FRAMES);
    const after = await metrics(this.cdp);
    const trace = traceTotals(await this.browser.stopTracing());
    const delta = (k: string): number => (after.get(k) ?? 0) - (this.before.get(k) ?? 0);
    await this.cdp.send("HeapProfiler.collectGarbage");
    const settled = await metrics(this.cdp);
    const drawn = this.layers.filter((l) => l.drawsContent);
    return {
      frame: frameStats(stamps),
      scriptMs: delta("ScriptDuration") * 1000,
      styleMs: delta("RecalcStyleDuration") * 1000,
      layoutMs: delta("LayoutDuration") * 1000,
      taskMs: delta("TaskDuration") * 1000,
      styleCount: delta("RecalcStyleCount"),
      layoutCount: delta("LayoutCount"),
      ...trace,
      heapMb: (settled.get("JSHeapUsedSize") ?? 0) / 2 ** 20,
      nodes: settled.get("Nodes") ?? 0,
      layers: drawn.length,
      layerMpx: drawn.reduce((s, l) => s + l.width * l.height, 0) / 1e6,
    };
  }
}

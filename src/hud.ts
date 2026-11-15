// Performance overlay in the manner of MangoHud: frame rate, frame times and a frametime graph,
// the app's own JS time per frame, long animation frames, memory and the GPU's name. It runs
// its own rAF loop only while shown, and redraws its text and graph four times a second.
//
// What a page cannot see, it says so: there is no web API for system CPU or GPU utilisation,
// so "CPU" is the share of each frame spent in this app's physics and render, and the GPU row
// gives the renderer's name only. The heap and long-frame rows exist in Chromium only.

import { loadFlag, saveFlag } from "./storage";
import { setText } from "./view";

/** Frames kept for the graph and the percentile, at 60 Hz about five seconds. */
const HISTORY = 300;
/** Text refresh period. */
const TEXT_MS = 250;
/** Window over which the long-animation-frame count is summed. */
const LOAF_WINDOW_MS = 10_000;
/** Graph ceiling in ms; frames longer than this are drawn clipped at the top. */
const GRAPH_MAX_MS = 50;
const BUDGET_MS = 1000 / 60;

interface LongFrame {
  readonly at: number;
  readonly blocking: number;
}

/** `performance.memory`: non-standard, Chromium only. */
interface HeapInfo {
  readonly usedJSHeapSize: number;
  readonly jsHeapSizeLimit: number;
}

function heapInfo(): HeapInfo | undefined {
  const m: unknown = Reflect.get(performance, "memory");
  if (typeof m !== "object" || m === null) return undefined;
  const used: unknown = Reflect.get(m, "usedJSHeapSize");
  const limit: unknown = Reflect.get(m, "jsHeapSizeLimit");
  return typeof used === "number" && typeof limit === "number"
    ? { usedJSHeapSize: used, jsHeapSizeLimit: limit }
    : undefined;
}

/** The GPU's name as WebGL reports it; Firefox and Safari return a coarse or masked name. */
function gpuName(): string {
  const gl = document.createElement("canvas").getContext("webgl");
  if (!gl) return "no WebGL";
  const info = gl.getExtension("WEBGL_debug_renderer_info");
  const name: unknown = gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER);
  gl.getExtension("WEBGL_lose_context")?.loseContext();
  return typeof name === "string" ? name.replace(/^ANGLE \((.*)\)$/, "$1") : "unknown";
}

const mb = (bytes: number): string => (bytes / 2 ** 20).toFixed(1);

/** The q-quantile of `xs` (unsorted). */
function quantile(xs: readonly number[], q: number): number {
  const s = xs.toSorted((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? 0;
}

export interface HudFields {
  readonly fps: HTMLElement;
  readonly ft: HTMLElement;
  readonly low: HTMLElement;
  readonly cpu: HTMLElement;
  readonly loaf: HTMLElement;
  readonly ram: HTMLElement;
  readonly dom: HTMLElement;
  readonly gpu: HTMLElement;
  readonly app: HTMLElement;
  readonly graph: HTMLCanvasElement;
}

/** The APP row: a short line of the page's own counters, read four times a second. */
export type AppStats = () => string;

export class Hud {
  private readonly el: HTMLElement;
  private readonly f: HudFields;
  private readonly stats: AppStats;
  private readonly frames: number[] = [];
  private readonly stamps: number[] = [];
  private readonly loafs: LongFrame[] = [];
  /** App work (ms) recorded since the last text refresh, and the frames it ran in. */
  private work = 0;
  private workFrames = 0;
  private raf = 0;
  private last = 0;
  private lastText = 0;
  private gpu: string | undefined;
  private colours = { line: "", budget: "" };
  /** Graph size in device px, kept by a ResizeObserver so drawing never forces a layout. */
  private graphSize = { w: 0, h: 0 };
  private sizer: ResizeObserver | undefined;
  private observer: PerformanceObserver | undefined;

  constructor(el: HTMLElement, fields: HudFields, stats: AppStats) {
    this.el = el;
    this.f = fields;
    this.stats = stats;
  }

  get shown(): boolean {
    return !this.el.hidden;
  }

  /** Records `ms` of app work (physics tick and render) done in one frame. */
  record(ms: number): void {
    if (!this.shown) return;
    this.work += ms;
    this.workFrames += 1;
  }

  show(isShown: boolean): void {
    if (isShown === this.shown) return;
    this.el.hidden = !isShown;
    if (isShown) this.start();
    else this.stop();
  }

  private start(): void {
    this.gpu ??= gpuName();
    const css = getComputedStyle(this.f.graph);
    this.colours = {
      line: css.getPropertyValue("--hud-line"),
      budget: css.getPropertyValue("--hud-budget"),
    };
    setText(this.f.gpu, this.gpu);
    this.sizer = new ResizeObserver(([entry]) => {
      const box = entry?.devicePixelContentBoxSize[0];
      const dpr = window.devicePixelRatio || 1;
      this.graphSize = box
        ? { w: box.inlineSize, h: box.blockSize }
        : {
            w: Math.round((entry?.contentRect.width ?? 0) * dpr),
            h: Math.round((entry?.contentRect.height ?? 0) * dpr),
          };
    });
    this.sizer.observe(this.f.graph);
    this.observeLongFrames();
    this.frames.length = 0;
    this.stamps.length = 0;
    this.last = 0;
    this.raf = requestAnimationFrame(this.frame);
  }

  private stop(): void {
    cancelAnimationFrame(this.raf);
    this.sizer?.disconnect();
    this.sizer = undefined;
    this.observer?.disconnect();
    this.observer = undefined;
  }

  private observeLongFrames(): void {
    if (!PerformanceObserver.supportedEntryTypes.includes("long-animation-frame")) {
      setText(this.f.loaf, "n/a in this browser");
      return;
    }
    this.observer = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        const blocking: unknown = Reflect.get(e, "blockingDuration");
        this.loafs.push({ at: e.startTime, blocking: typeof blocking === "number" ? blocking : 0 });
      }
    });
    this.observer.observe({ type: "long-animation-frame", buffered: false });
  }

  private readonly frame = (now: number): void => {
    this.raf = requestAnimationFrame(this.frame);
    if (this.last) {
      this.frames.push(now - this.last);
      this.stamps.push(now);
      if (this.frames.length > HISTORY) {
        this.frames.shift();
        this.stamps.shift();
      }
    }
    this.last = now;
    if (now - this.lastText < TEXT_MS) return;
    // The graph redraws with the text, not every frame: a canvas updated every frame took
    // Firefox's software compositor from 60 to 24 fps with 60 compositor animations on screen.
    this.drawGraph();
    this.text(now);
    this.lastText = now;
  };

  private text(now: number): void {
    const f = this.f;
    const recent = this.frames.filter((_, i) => (this.stamps[i] ?? 0) > now - 1000);
    const avg = recent.length > 0 ? recent.reduce((a, b) => a + b, 0) / recent.length : 0;
    setText(f.fps, String(recent.length));
    setText(f.ft, `${avg.toFixed(1)} ms`);
    const p99 = quantile(this.frames, 0.99);
    const max = Math.max(0, ...recent);
    setText(
      f.low,
      `1% low ${p99 > 0 ? String(Math.round(1000 / p99)) : "–"} · max ${max.toFixed(1)} ms`,
    );
    const perFrame = this.workFrames > 0 ? this.work / this.workFrames : 0;
    const share = (this.work / TEXT_MS) * 100;
    setText(f.cpu, `app JS ${perFrame.toFixed(2)} ms/frame · ${share.toFixed(0)}%`);
    this.work = 0;
    this.workFrames = 0;
    if (this.observer) {
      while (this.loafs.length > 0 && (this.loafs[0]?.at ?? now) < now - LOAF_WINDOW_MS)
        this.loafs.shift();
      const blocking = this.loafs.reduce((s, l) => s + l.blocking, 0);
      setText(f.loaf, `${String(this.loafs.length)} in 10 s · ${blocking.toFixed(0)} ms blocking`);
    }
    const heap = heapInfo();
    setText(
      f.ram,
      heap
        ? `${mb(heap.usedJSHeapSize)} / ${mb(heap.jsHeapSizeLimit)} MB heap`
        : "heap n/a in this browser",
    );
    const deviceMemory: unknown = Reflect.get(navigator, "deviceMemory");
    const dev = typeof deviceMemory === "number" ? ` · device ${String(deviceMemory)} GB` : "";
    setText(f.dom, `${String(document.querySelectorAll("*").length)} nodes${dev}`);
    setText(f.app, this.stats());
  }

  /** Frametime graph: one bar per frame, newest at the right, with the 60 Hz budget line. */
  private drawGraph(): void {
    const c = this.f.graph;
    const dpr = window.devicePixelRatio || 1;
    const { w, h } = this.graphSize;
    if (w === 0 || h === 0) return;
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    const g = c.getContext("2d");
    if (!g) return;
    g.clearRect(0, 0, w, h);
    const y = (ms: number): number => h - (Math.min(ms, GRAPH_MAX_MS) / GRAPH_MAX_MS) * h;
    g.fillStyle = this.colours.budget;
    g.fillRect(0, Math.round(y(BUDGET_MS)), w, Math.max(1, Math.round(dpr)));
    g.strokeStyle = this.colours.line;
    g.lineWidth = Math.max(1, dpr);
    g.beginPath();
    const n = this.frames.length;
    for (const [i, ms] of this.frames.entries()) {
      const x = w - ((n - 1 - i) / (HISTORY - 1)) * w;
      if (i === 0) g.moveTo(x, y(ms));
      else g.lineTo(x, y(ms));
    }
    g.stroke();
  }
}

/** Label class per row kind, written out in full so Tailwind's source scan finds each one. */
const KIND = {
  gpu: "text-hud-gpu",
  cpu: "text-hud-cpu",
  ram: "text-hud-ram",
  fps: "text-hud-fps",
  app: "text-hud-app",
} as const;

/** One label + value row of the overlay. */
function row(
  parent: HTMLElement,
  kind: keyof typeof KIND,
  label: string,
  value: HTMLElement,
): HTMLElement {
  const l = document.createElement("span");
  l.className = KIND[kind];
  l.textContent = label;
  parent.append(l, value);
  return value;
}

const span = (className = ""): HTMLElement => {
  const el = document.createElement("span");
  el.className = className;
  return el;
};

/** Builds the overlay (hidden) at the end of `parent` and returns it. */
export function mountHud(parent: HTMLElement, stats: AppStats): Hud {
  const el = document.createElement("aside");
  el.className = "hud";
  el.setAttribute("aria-label", "Performance overlay");
  el.hidden = true;
  const gpu = row(el, "gpu", "GPU", span("truncate"));
  const note = row(el, "gpu", "", span("text-faint"));
  note.textContent = "utilisation: no web API";
  const cpu = row(el, "cpu", "CPU", span());
  const loaf = row(el, "cpu", "LoAF", span());
  const ram = row(el, "ram", "RAM", span());
  const dom = row(el, "ram", "DOM", span());
  const fpsLine = row(el, "fps", "FPS", span());
  const fps = document.createElement("b");
  fps.className = "font-semibold";
  const ft = span();
  fpsLine.append(fps, " · ", ft);
  const graph = document.createElement("canvas");
  graph.className = "hud-graph";
  graph.setAttribute("aria-hidden", "true");
  el.append(graph);
  const low = row(el, "fps", "FT", span());
  const app = row(el, "app", "APP", span());
  parent.append(el);
  return new Hud(el, { fps, ft, low, cpu, loaf, ram, dom, gpu, app, graph }, stats);
}

/**
 * The overlay toggles from `checkbox`, from Shift+F12 (MangoHud's key) and from `?hud`; the
 * choice is kept per viewer under `storageKey`. Without a stored choice it starts as `initial`.
 */
export function wireHudToggle(
  hud: Hud,
  options: { storageKey: string; checkbox?: HTMLInputElement; initial?: boolean },
): void {
  const set = (isShown: boolean): void => {
    hud.show(isShown);
    if (options.checkbox) options.checkbox.checked = isShown;
    saveFlag(options.storageKey, isShown);
  };
  options.checkbox?.addEventListener("change", () => {
    set(options.checkbox?.checked ?? false);
  });
  addEventListener("keydown", (e) => {
    if (e.key !== "F12" || !e.shiftKey) return;
    e.preventDefault();
    set(!hud.shown);
  });
  const isWanted =
    new URLSearchParams(location.search).has("hud") ||
    (loadFlag(options.storageKey) ?? options.initial ?? false);
  set(isWanted);
}

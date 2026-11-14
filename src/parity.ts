// The snapshot parity page (debug/parity.html): every fixture becomes a card face, and
// `window.parity.snap(id, scale)` rasterizes one through the WebGL renderer's own atlas
// path. bench/parity.py compares that with the browser's screenshot of the same face.

import "./fonts";
import "./styles/index.css";

import { FACE } from "./data";
import { SHADER_DRAWN } from "./gl/bake";
import { atlas } from "./gl/raster";

const BOARD = FACE.full;
const k = Number(new URLSearchParams(location.search).get("k") ?? "1");
document.documentElement.style.setProperty("--k", String(k));

/** Wraps a fixture's content in the slot and face boxes a card gives its face. */
function mount(section: HTMLElement, content: Element): void {
  const title = document.createElement("h2");
  title.textContent = section.dataset.fixture ?? "";
  const slot = document.createElement("div");
  slot.className = "slot";
  const face = document.createElement("div");
  face.className = "face";
  face.dataset.face = "";
  face.append(content);
  slot.append(face);
  section.replaceChildren(title, slot);
}

function addFixture(main: HTMLElement, id: string, content: Element): void {
  const section = document.createElement("section");
  section.className = "pf";
  section.dataset.fixture = id;
  mount(section, content);
  main.append(section);
}

/** The real faces: each `face-*` template in index.html, as the table fills it in, and the
 * card back. */
async function addTemplates(main: HTMLElement): Promise<void> {
  const res = await fetch(new URL("../index.html", location.href));
  const html = await res.text();
  const doc = new DOMParser().parseFromString(html, "text/html");
  for (const tpl of doc.querySelectorAll<HTMLTemplateElement>('template[id^="face-"]')) {
    const content = document.importNode(tpl.content, true).firstElementChild;
    if (!content) continue;
    for (const el of content.querySelectorAll("[data-glyph]")) el.textContent = "Q";
    for (const el of content.querySelectorAll("[data-suit]")) el.textContent = "♥";
    for (const el of content.querySelectorAll("[data-badge]")) el.textContent = "L2";
    addFixture(main, `tpl-${tpl.id.slice("face-".length)}`, content);
  }
  const card = doc.querySelector<HTMLTemplateElement>("template#tpl-card");
  const back = card && document.importNode(card.content, true).querySelector("[data-back]")?.firstElementChild;
  if (back) addFixture(main, "tpl-back", back);
}

function faceOf(id: string): HTMLElement {
  const face = document.querySelector<HTMLElement>(`[data-fixture="${CSS.escape(id)}"] [data-face]`);
  if (!face) throw new Error(`parity: no fixture ${id}`);
  return face;
}

/** Rasterizes fixture `id` through the atlas at `scale` and returns its cell as a PNG. */
async function snap(id: string, scale: number): Promise<string> {
  const { regions } = await atlas(document.body, [{ key: id, el: faceOf(id) }], BOARD, scale);
  const region = regions.get(id);
  if (!region) throw new Error(`parity: no region for ${id}`);
  const { source, uv } = region;
  if (!(source instanceof HTMLCanvasElement)) throw new TypeError("parity: atlas is not a canvas");
  const [u, v, w, h] = uv;
  const sw = Math.round(w * source.width);
  const sh = Math.round(h * source.height);
  const out = document.createElement("canvas");
  out.width = sw;
  out.height = sh;
  const ctx = out.getContext("2d");
  if (!ctx) throw new Error("parity: no 2D context");
  ctx.drawImage(source, Math.round(u * source.width), Math.round(v * source.height), sw, sh, 0, 0, sw, sh);
  return out.toDataURL("image/png");
}

/**
 * Rasterizes fixture `id` the HTML-in-Canvas way (drawable.ts): a copy of the face in an
 * invisible drawable canvas, drawn by the browser at `scale` device px per artboard px.
 */
async function snapDrawable(id: string, scale: number): Promise<string> {
  const copy = faceOf(id).cloneNode(true);
  if (!(copy instanceof HTMLElement)) throw new TypeError("parity: face copy is not an element");
  const canvas = document.createElement("canvas");
  canvas.className = "parity-drawable";
  canvas.setAttribute("content", "drawable");
  canvas.width = Math.round(BOARD.bw * scale);
  canvas.height = Math.round(BOARD.bh * scale);
  copy.setAttribute("drawable", "");
  copy.style.setProperty("transform", "none");
  for (const el of copy.querySelectorAll<HTMLElement>(SHADER_DRAWN)) el.style.setProperty("visibility", "hidden");
  canvas.append(copy);
  document.body.append(canvas);
  const ctx = canvas.getContext("2d");
  if (!ctx?.drawElementImage || !canvas.requestPaint) throw new Error("parity: no HTML-in-Canvas here");
  const draw = ctx.drawElementImage.bind(ctx);
  try {
    await new Promise<void>((resolve) => {
      canvas.onpaint = () => {
        draw(copy, 0, 0, canvas.width, canvas.height);
        resolve();
      };
      canvas.requestPaint?.();
    });
    return canvas.toDataURL("image/png");
  } finally {
    canvas.remove();
  }
}

async function start(): Promise<void> {
  const main = document.querySelector<HTMLElement>("[data-fixtures]");
  if (!main) throw new Error("parity: no fixture list");
  for (const section of main.querySelectorAll<HTMLElement>("[data-fixture]")) {
    const content = section.firstElementChild;
    if (content) mount(section, content);
  }
  await addTemplates(main);
  await document.fonts.ready;
  const ids = [...main.querySelectorAll<HTMLElement>("[data-fixture]")].map((s) => s.dataset.fixture ?? "");
  Object.assign(globalThis, { parity: { ids, k, board: BOARD, snap, snapDrawable } });
  document.documentElement.dataset.parity = "ready";
}

void start();

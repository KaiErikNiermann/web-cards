// The /debug page: draws `count` rounded boxes whose child spins with a CSS transform
// animation, clipped in the chosen way, under the performance overlay. Variant, count
// and box size live in the URL (?v=&n=&s=), so a setting can be bookmarked on a device.

import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/600.css";
import "./styles/debug-entry.css";

import { must } from "./dom";
import { mountHud, wireHudToggle } from "./hud";
import { setText } from "./view";

interface Variant {
  readonly id: string;
  readonly label: string;
  readonly note: string;
}

const VARIANTS: readonly Variant[] = [
  { id: "plain", label: "plain", note: "overflow: hidden; border-radius only (the control)." },
  {
    id: "mask-exclude",
    label: "mask + mask-composite",
    note: "A border band: two gradients composited with exclude.",
  },
  {
    id: "mask-image",
    label: "mask-image gradient",
    note: "mask-image: linear-gradient(#000, #000), a no-op mask.",
  },
  { id: "mask-radial", label: "mask-image radial", note: "A soft radial vignette mask." },
  {
    id: "mask-svg",
    label: "mask-image SVG",
    note: "A data: SVG image as the mask (no url(#id) reference).",
  },
  {
    id: "clip-path",
    label: "clip-path inset",
    note: "clip-path: inset(0 round …), a basic shape.",
  },
  {
    id: "paused-mask-exclude",
    label: "mask, paused",
    note: "The masked variant with the animation paused (control).",
  },
  {
    id: "fade-mask-image",
    label: "mask, opacity anim",
    note: "An opacity animation under the mask instead of a transform.",
  },
  {
    id: "svg-dash",
    label: "SVG dash, no mask",
    note: "An SVG stroke-dashoffset animation, no mask.",
  },
];

const variantSelect = must(document, "[data-variant-select]", HTMLSelectElement);
const count = must(document, "[data-count]", HTMLInputElement);
const countValue = must(document, "[data-count-value]", HTMLElement);
const variantNote = must(document, "[data-variant-note]", HTMLElement);
const stage = must(document, "[data-stage]", HTMLElement);
const size = must(document, "[data-size]", HTMLInputElement);
const sizeValue = must(document, "[data-size-value]", HTMLElement);

for (const v of VARIANTS) {
  const option = document.createElement("option");
  option.value = v.id;
  option.textContent = v.label;
  variantSelect.append(option);
}

const params = new URLSearchParams(location.search);
const wantedVariant = params.get("v") ?? "plain";
variantSelect.value = VARIANTS.some((v) => v.id === wantedVariant) ? wantedVariant : "plain";
const wantedCount = Number(params.get("n") ?? "0") || 0;
count.value = String(Math.min(60, Math.max(0, wantedCount)));
const wantedSize = Number(params.get("s") ?? "150") || 150;
size.value = String(Math.min(150, Math.max(30, wantedSize)));

function box(id: string): HTMLElement {
  if (id === "svg-dash") {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "debug-dash");
    svg.setAttribute("viewBox", "0 0 152 212");
    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    const attrs: readonly (readonly [string, string])[] = [
      ["x", "1"],
      ["y", "1"],
      ["width", "150"],
      ["height", "210"],
      ["rx", "11"],
      ["pathLength", "100"],
    ];
    for (const [k, v] of attrs) rect.setAttribute(k, v);
    svg.append(rect);
    const wrap = document.createElement("div");
    wrap.append(svg);
    return wrap;
  }
  const outer = document.createElement("div");
  outer.dataset.variant = id;
  const el = document.createElement("div");
  el.className = "debug-box";
  const child = document.createElement("div");
  child.className = id === "fade-mask-image" ? "debug-fade" : "debug-spin";
  el.append(child);
  outer.append(el);
  return outer;
}

function render(): void {
  const id = variantSelect.value;
  const n = count.valueAsNumber;
  setText(countValue, String(n));
  setText(sizeValue, size.value);
  stage.style.setProperty("--box-w", `${size.value}px`);
  setText(variantNote, VARIANTS.find((v) => v.id === id)?.note ?? "");
  stage.replaceChildren(...Array.from({ length: n }, () => box(id)));
  const url = new URL(location.href);
  url.searchParams.set("v", id);
  url.searchParams.set("n", String(n));
  url.searchParams.set("s", size.value);
  history.replaceState(history.state, "", url);
}

variantSelect.addEventListener("change", render);
count.addEventListener("input", render);
size.addEventListener("input", render);
render();

const hud = mountHud(document.body, () => `${count.value} × ${variantSelect.value}`);
wireHudToggle(hud, {
  storageKey: "web-cards:debug-hud",
  checkbox: must(document, "[data-hud-toggle]", HTMLInputElement),
  initial: true,
});

// Stand-ins for form controls in face snapshots. Firefox draws native controls blank or
// unthemed inside the SVG image a snapshot is (checkboxes and radios empty, a range as a white
// box, progress and meter in platform colours, no select arrow, a placeholder as typed text,
// an empty date field), so the snapshot's copy of a face swaps each control for plain elements
// drawn like it (gl-controls.css), sized to the control's box and showing its state.

/** Computed properties a field stand-in takes over from its control. */
const FIELD_STYLE = [
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "line-height",
  "letter-spacing",
  "color",
  "background-color",
  "border-top",
  "border-right",
  "border-bottom",
  "border-left",
  "border-radius",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "text-align",
] as const;

const TEXT_TYPES = new Set(["text", "search", "email", "url", "tel", "number", "password", "date", "time"]);

interface Swap {
  readonly control: HTMLElement;
  readonly box: DOMRect;
  readonly style: CSSStyleDeclaration;
}

function el(className: string): HTMLElement {
  const e = document.createElement("span");
  e.className = className;
  return e;
}

/** Whether a computed `rgb(…)` colour is light enough to need a dark mark on it. */
function isLight(rgb: string): boolean {
  const [r = 0, g = 0, b = 0] = (rgb.match(/[\d.]+/g) ?? []).map(Number);
  return 0.299 * r + 0.587 * g + 0.114 * b > 150;
}

function share(value: number, min: number, max: number): number {
  return max > min ? Math.min(1, Math.max(0, (value - min) / (max - min))) : 0;
}

function bar(kind: string, fill: number, hasThumb: boolean): HTMLElement {
  const out = el("gl-ctl");
  out.dataset.kind = kind;
  out.style.setProperty("--_fill", `${String(fill * 100)}%`);
  out.style.setProperty("--_at", String(fill));
  const track = el("gl-ctl-track");
  track.append(el("gl-ctl-fill"));
  out.append(track);
  if (hasThumb) out.append(el("gl-ctl-thumb"));
  return out;
}

function field(kind: string, text: string, style: CSSStyleDeclaration): HTMLElement {
  const out = el("gl-ctl");
  out.dataset.kind = kind;
  out.dataset.field = "";
  for (const p of FIELD_STYLE) out.style.setProperty(p, style.getPropertyValue(p));
  out.textContent = text;
  return out;
}

function textOf(input: HTMLInputElement): { text: string; isPlaceholder: boolean } {
  if (input.value === "") return { text: input.placeholder, isPlaceholder: true };
  if (input.type === "password") return { text: "•".repeat(input.value.length), isPlaceholder: false };
  if (input.type === "date" && input.valueAsDate) {
    return { text: input.valueAsDate.toLocaleDateString(undefined, { timeZone: "UTC" }), isPlaceholder: false };
  }
  return { text: input.value, isPlaceholder: false };
}

function listbox(select: HTMLSelectElement, style: CSSStyleDeclaration): HTMLElement {
  const out = field("listbox", "", style);
  delete out.dataset.field;
  for (const o of select.options) {
    const row = el("gl-ctl-option");
    row.textContent = o.text;
    row.toggleAttribute("data-on", o.selected);
    out.append(row);
  }
  return out;
}

function inputStandIn(control: HTMLInputElement, style: CSSStyleDeclaration): HTMLElement | undefined {
  switch (control.type) {
    case "checkbox":
    case "radio": {
      const out = el("gl-ctl");
      out.dataset.kind = control.type === "checkbox" ? "check" : "radio";
      out.toggleAttribute("data-on", control.checked);
      return out;
    }
    case "range": {
      const v = control.valueAsNumber;
      return bar("range", share(v, Number(control.min || 0), Number(control.max || 100)), true);
    }
    default: {
      if (!TEXT_TYPES.has(control.type)) return undefined;
      const { text, isPlaceholder } = textOf(control);
      const out = field("text", text, style);
      if (isPlaceholder) out.style.setProperty("color", getComputedStyle(control, "::placeholder").color);
      return out;
    }
  }
}

function nativeSelect(select: HTMLSelectElement, style: CSSStyleDeclaration): HTMLElement {
  const out = field("select", select.selectedOptions[0]?.text ?? "", style);
  out.toggleAttribute("data-native", style.appearance !== "none");
  return out;
}

/** The stand-in for `control`, or undefined to keep the control (it draws correctly). */
function standIn(control: HTMLElement, style: CSSStyleDeclaration): HTMLElement | undefined {
  if (control instanceof HTMLInputElement) return inputStandIn(control, style);
  if (control instanceof HTMLSelectElement) {
    return control.multiple || control.size > 1
      ? listbox(control, style)
      : nativeSelect(control, style);
  }
  if (control instanceof HTMLProgressElement) return bar("progress", Math.max(0, control.position), false);
  if (control instanceof HTMLMeterElement) {
    return bar("meter", share(control.value, control.min, control.max), false);
  }
  return undefined;
}

/**
 * Swaps the form controls in `clone` (a laid-out copy of a face) for stand-ins. Every box is
 * measured before any is swapped, so a swap never moves the next control.
 */
export function swapControls(clone: HTMLElement): void {
  const swaps: Swap[] = [...clone.querySelectorAll<HTMLElement>("input, select, progress, meter")].map(
    (control) => ({ control, box: control.getBoundingClientRect(), style: getComputedStyle(control) }),
  );
  for (const { control, box, style } of swaps) {
    const out = standIn(control, style);
    if (!out) continue;
    out.style.setProperty("inline-size", `${String(box.width)}px`);
    out.style.setProperty("block-size", `${String(box.height)}px`);
    for (const p of ["margin-top", "margin-right", "margin-bottom", "margin-left", "align-self", "flex-grow"]) {
      out.style.setProperty(p, style.getPropertyValue(p));
    }
    if (style.accentColor !== "auto") {
      out.style.setProperty("--_accent", style.accentColor);
      out.toggleAttribute("data-light", isLight(style.accentColor));
    }
    control.replaceWith(out);
  }
}

// Builds the page's dynamic parts from the <template> elements in index.html. Content is
// filled with textContent and attributes only; no markup is assembled from strings.

import {
  DECKS,
  PRESET_IDS,
  PRESETS,
  SECTION_IDS,
  type CardDef,
  type PresetId,
  type SectionId,
} from "./data";
import type { MaterialSlider } from "./physics";

/** Object position of the art window on the unit card, as in the export. */
const UNIT_ART_POSITION = "18% 30%";

export function must<T extends Element>(
  root: ParentNode,
  selector: string,
  type: abstract new () => T,
): T {
  const el = root.querySelector(selector);
  if (!(el instanceof type)) throw new TypeError(`missing ${type.name} for ${selector}`);
  return el;
}

function clone(templateId: string): DocumentFragment {
  const t = document.querySelector(`#${templateId}`);
  if (!(t instanceof HTMLTemplateElement)) throw new TypeError(`missing template #${templateId}`);
  return t.content.cloneNode(true) as DocumentFragment;
}

export interface CardRefs {
  readonly def: CardDef;
  readonly sec: SectionId;
  readonly i: number;
  readonly slot: HTMLElement;
  readonly card: HTMLElement;
  readonly grain: HTMLElement;
  readonly foil: HTMLElement;
  readonly glare: HTMLElement;
  readonly hot: HTMLElement;
  /** The parallax art window, on faces that have one. */
  readonly art: HTMLElement | undefined;
  readonly svg: SVGSVGElement | undefined;
  readonly outlines: readonly SVGRectElement[];
}

export interface SectionRefs {
  readonly id: SectionId;
  readonly note: HTMLElement;
  readonly row: HTMLElement;
  /** The live pile readout, shown while the section holds a pile. */
  readonly stackLabel: HTMLElement;
}

const TITLES: Readonly<Record<SectionId, string>> = {
  full: "Full size",
  anim: "Animated",
  stack: "Stack",
  mini: "Cardlets",
};

function fillFace(face: HTMLElement, c: CardDef): void {
  face.append(clone(`face-${c.kind}`));
  const img = face.querySelector("img");
  switch (c.kind) {
    case "img":
    case "scene":
    case "cover": {
      img?.setAttribute("src", c.src);
      if (c.kind === "cover" && c.fx === "live") img?.classList.add("kb");
      break;
    }
    case "unit": {
      img?.setAttribute("src", c.art);
      img?.style.setProperty("object-position", UNIT_ART_POSITION);
      break;
    }
    case "glyph": {
      for (const el of face.querySelectorAll("[data-glyph]")) el.textContent = c.glyph;
      must(face, "[data-suit]", HTMLElement).textContent = c.suit;
      if (c.red) must(face, "[data-ink]", HTMLElement).dataset.red = "";
      break;
    }
    case "miniart": {
      img?.setAttribute("src", c.src);
      img?.style.setProperty("object-position", c.pos);
      must(face, "[data-badge]", HTMLElement).textContent = c.badge;
      break;
    }
  }
}

function buildCard(c: CardDef, sec: SectionId, i: number): CardRefs {
  const frag = clone("tpl-card");
  const slot = must(frag, ".slot", HTMLElement);
  const card = must(frag, ".card", HTMLElement);
  const edge = must(frag, "[data-edge]", HTMLElement);
  slot.dataset.card = c.id;
  card.setAttribute("aria-label", c.label);
  fillFace(must(frag, "[data-face]", HTMLElement), c);
  if (c.fx === "live") edge.before(clone("fx-live"));
  let svg: SVGSVGElement | undefined;
  if (c.fx === "orbit") card.append(clone("fx-orbit"));
  else if (c.fx === "trace" || c.fx === "dual") {
    card.append(clone(`fx-${c.fx}`));
    svg = must(card, "svg", SVGSVGElement);
  }
  return {
    def: c,
    sec,
    i,
    slot,
    card,
    grain: must(frag, "[data-grain]", HTMLElement),
    foil: must(frag, "[data-foil]", HTMLElement),
    glare: must(frag, "[data-glare]", HTMLElement),
    hot: must(frag, "[data-hot]", HTMLElement),
    art: frag.querySelector<HTMLElement>(".par") ?? undefined,
    svg,
    outlines: svg ? [...svg.querySelectorAll("rect")] : [],
  };
}

export interface Built {
  readonly sections: readonly SectionRefs[];
  readonly cards: readonly CardRefs[];
}

export function buildSections(container: HTMLElement): Built {
  const footer = must(container, "footer", HTMLElement);
  const sections: SectionRefs[] = [];
  const cards: CardRefs[] = [];
  for (const id of SECTION_IDS) {
    const frag = clone("tpl-section");
    must(frag, "[data-title]", HTMLElement).textContent = TITLES[id];
    const row = must(frag, "[data-row]", HTMLElement);
    row.className = "card-row";
    const deck = DECKS[id];
    for (const [i, c] of deck.entries()) {
      const refs = buildCard(c, id, i);
      row.append(refs.slot);
      cards.push(refs);
    }
    const stackLabel = must(frag, "[data-stack-label]", HTMLElement);
    const note = must(frag, "[data-note]", HTMLElement);
    sections.push({ id, note, row, stackLabel });
    footer.before(frag);
  }
  return { sections, cards };
}

export interface SliderDef {
  readonly key: MaterialSlider;
  readonly label: string;
  readonly max: number;
  readonly text: (v: number) => string;
}

const unit = (v: number): string => (v / 100).toFixed(2);

export const SLIDERS: readonly SliderDef[] = [
  { key: "refl", label: "Reflectance", max: 100, text: unit },
  { key: "rough", label: "Roughness (gloss ↔ matte)", max: 100, text: unit },
  { key: "foil", label: "Foil", max: 100, text: unit },
  { key: "grain", label: "Paper grain", max: 100, text: unit },
  { key: "tilt", label: "Hover tilt", max: 30, text: (v) => `${String(v)}°` },
  { key: "sway", label: "Drag sway", max: 200, text: (v) => `${String(v)}%` },
];

export interface SliderRefs {
  readonly def: SliderDef;
  readonly input: HTMLInputElement;
  readonly value: HTMLElement;
}

export function buildSliders(container: HTMLElement): readonly SliderRefs[] {
  return SLIDERS.map((def) => {
    const frag = clone("tpl-slider");
    const input = must(frag, "input", HTMLInputElement);
    const label = must(frag, "[data-label]", HTMLLabelElement);
    input.id = `sl-${def.key}`;
    input.min = "0";
    input.max = String(def.max);
    label.htmlFor = input.id;
    label.textContent = def.label;
    const value = must(frag, "[data-value]", HTMLElement);
    container.append(frag);
    return { def, input, value };
  });
}

export function buildPresetChips(
  container: HTMLElement,
): readonly { readonly id: PresetId; readonly el: HTMLButtonElement }[] {
  return PRESET_IDS.map((id) => {
    const frag = clone("tpl-chip");
    const el = must(frag, "button", HTMLButtonElement);
    el.textContent = PRESETS[id].label;
    container.append(frag);
    return { id, el };
  });
}

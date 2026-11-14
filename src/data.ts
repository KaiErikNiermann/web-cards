// Static content of the card table: asset paths, material presets and the card decks of each
// section. Values are carried over unchanged from the Claude Design export (Main.dc.html).

import aceOfSpades from "./assets/ace-of-spades.png";
import elvishCaptain from "./assets/elvish-captain.jpg";
import kingOfClubs from "./assets/king-of-clubs.png";
import queenOfHearts from "./assets/queen-of-hearts.png";
import sevenOfDiamonds from "./assets/seven-of-diamonds.png";
import templeInTheDeep from "./assets/temple-in-the-deep.jpg";
import wesnothCover from "./assets/wesnoth-cover.jpg";

// Imported rather than served from public/, so `vite build --mode single` can inline them.
export const ASSETS = {
  qh: queenOfHearts,
  as: aceOfSpades,
  kc: kingOfClubs,
  d7: sevenOfDiamonds,
  wes: elvishCaptain,
  temple: templeInTheDeep,
  cover: wesnothCover,
} as const;

export type PresetId = "paper" | "satin" | "gloss" | "holo" | "pearl";

export interface Preset {
  readonly label: string;
  readonly refl: number;
  readonly rough: number;
  readonly foil: number;
  readonly grain: number;
}

export const PRESETS: Readonly<Record<PresetId, Preset>> = {
  paper: { label: "Paper matte", refl: 30, rough: 92, foil: 0, grain: 70 },
  satin: { label: "Satin", refl: 55, rough: 55, foil: 0, grain: 35 },
  gloss: { label: "Gloss laminate", refl: 90, rough: 10, foil: 0, grain: 10 },
  holo: { label: "Holo foil", refl: 75, rough: 30, foil: 90, grain: 20 },
  pearl: { label: "Pearl", refl: 60, rough: 45, foil: 35, grain: 25 },
};

export const PRESET_IDS = Object.keys(PRESETS) as readonly PresetId[];

/** Design-tool props of the export, at their defaults. */
export const START_FINISH: PresetId = "satin";

export type Fx = "orbit" | "trace" | "live" | "dual";

interface CardBase {
  readonly id: string;
  readonly label: string;
  readonly fx?: Fx;
  readonly mini?: true;
}

export type CardDef = CardBase &
  (
    | { readonly kind: "img" | "scene" | "cover"; readonly src: string }
    | { readonly kind: "unit"; readonly art: string }
    | {
        readonly kind: "glyph";
        readonly glyph: string;
        readonly suit: string;
        /** Ink colour token; black ink when absent. */
        readonly red?: true;
      }
    | {
        readonly kind: "miniart";
        readonly src: string;
        readonly pos: string;
        readonly badge: string;
      }
    /** Lab faces (`?lab`): live DOM content a snapshot renderer has to keep up with. */
    | { readonly kind: "note" | "form" | "clock" | "list" }
  );

export type CardKind = CardDef["kind"];

export type SectionId = "full" | "anim" | "stack" | "mini" | "lab";

/**
 * Sections on the page. The Lab section, cards with editable, live and scrolling content to
 * test renderers against, is added with `?lab`.
 */
export const SECTION_IDS: readonly SectionId[] =
  typeof location !== "undefined" && new URLSearchParams(location.search).has("lab")
    ? ["full", "anim", "stack", "mini", "lab"]
    : ["full", "anim", "stack", "mini"];

/** Sections whose deck starts as a single pile rather than one card per slot. */
export const PILED_SECTIONS: ReadonlySet<SectionId> = new Set(["stack"]);

const A = ASSETS;

export const DECKS: Readonly<Record<SectionId, readonly CardDef[]>> = {
  full: [
    { id: "qh", kind: "img", src: A.qh, label: "Queen of hearts" },
    { id: "as", kind: "img", src: A.as, label: "Ace of spades" },
    { id: "unit", kind: "unit", art: A.wes, label: "Elvish Captain unit card" },
    { id: "cover", kind: "cover", src: A.cover, label: "The Battle for Wesnoth cover" },
  ],
  anim: [
    {
      id: "a-orbit",
      kind: "scene",
      src: A.temple,
      fx: "orbit",
      label: "Scene card with orbiting border light",
    },
    {
      id: "a-trace",
      kind: "img",
      src: A.kc,
      fx: "trace",
      label: "King of clubs with perimeter trace",
    },
    {
      id: "a-live",
      kind: "cover",
      src: A.cover,
      fx: "live",
      label: "Cover with light sweep and slow pan",
    },
    {
      id: "a-dual",
      kind: "img",
      src: A.d7,
      fx: "dual",
      label: "Seven of diamonds with counter-running traces",
    },
  ],
  stack: [
    { id: "s-qh", kind: "img", src: A.qh, label: "Queen of hearts" },
    { id: "s-kc", kind: "img", src: A.kc, label: "King of clubs" },
    { id: "s-as", kind: "img", src: A.as, label: "Ace of spades" },
    { id: "s-d7", kind: "img", src: A.d7, label: "Seven of diamonds" },
    { id: "s-unit", kind: "unit", art: A.wes, label: "Elvish Captain" },
    { id: "s-orbit", kind: "scene", src: A.temple, fx: "orbit", label: "Temple in the Deep" },
    { id: "s-cover", kind: "cover", src: A.cover, label: "The Battle for Wesnoth" },
    {
      id: "s-live",
      kind: "cover",
      src: A.cover,
      fx: "live",
      label: "The Battle for Wesnoth (animated)",
    },
  ],
  mini: [
    {
      id: "m-qh",
      mini: true,
      kind: "glyph",
      glyph: "Q",
      suit: "♥︎",
      red: true,
      label: "Queen of hearts cardlet",
    },
    {
      id: "m-as",
      mini: true,
      kind: "glyph",
      glyph: "A",
      suit: "♠︎",
      label: "Ace of spades cardlet",
    },
    {
      id: "m-kc",
      mini: true,
      kind: "glyph",
      glyph: "K",
      suit: "♣︎",
      fx: "trace",
      label: "King of clubs cardlet",
    },
    {
      id: "m-d7",
      mini: true,
      kind: "glyph",
      glyph: "7",
      suit: "♦︎",
      red: true,
      fx: "dual",
      label: "Seven of diamonds cardlet",
    },
    {
      id: "m-unit",
      mini: true,
      kind: "miniart",
      src: A.wes,
      pos: "14% 30%",
      badge: "L2",
      label: "Elvish Captain cardlet",
    },
    {
      id: "m-cover",
      mini: true,
      kind: "miniart",
      src: A.cover,
      pos: "60% 40%",
      badge: "BfW",
      fx: "live",
      label: "Wesnoth cover cardlet",
    },
    {
      id: "m-orbit",
      mini: true,
      kind: "miniart",
      src: A.temple,
      pos: "50% 50%",
      badge: "ch.6",
      fx: "orbit",
      label: "Temple cardlet with orbit",
    },
  ],
  lab: [
    { id: "l-note", kind: "note", label: "Note with an editable title and text" },
    { id: "l-form", kind: "form", label: "Form with checkboxes, a select and a slider" },
    { id: "l-clock", kind: "clock", fx: "trace", label: "Clock and counter updated every second" },
    { id: "l-list", kind: "list", label: "Scrolling list with mixed scripts" },
  ],
};

export interface Geometry {
  readonly w: number;
  readonly h: number;
  readonly mw: number;
  readonly mh: number;
  readonly step: number;
  /** Row gaps in px for full-size cards and cardlets. */
  readonly gap: number;
  readonly miniGap: number;
  readonly liftPad: number;
  readonly small: boolean;
}

/** Viewport width below which the compact geometry applies. */
export const SMALL_VIEWPORT = 700;

export function geometryFor(viewportWidth: number): Geometry {
  const isSmall = viewportWidth < SMALL_VIEWPORT;
  const base = isSmall
    ? { w: 150, h: 210, mw: 76, mh: 106, gap: 14, miniGap: 10, step: 22 }
    : { w: 220, h: 308, mw: 100, mh: 140, gap: 32, miniGap: 24, step: 40 };
  return { ...base, small: isSmall, liftPad: Math.round(base.h * 0.16) };
}

/** Unscaled face artboard and corner radius, by card size. */
export const FACE = {
  full: { bw: 220, bh: 308, radius: 11, parallax: 0.9 },
  mini: { bw: 100, bh: 140, radius: 6, parallax: 0.45 },
} as const;

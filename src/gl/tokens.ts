// Design tokens the WebGL renderer needs, read from the stylesheet at start-up so the look
// has one source: colours as premultiplied RGBA, lengths in px, percentages as numbers.

export type Rgba = readonly [number, number, number, number];

export interface GlTokens {
  readonly paper: Rgba;
  readonly glint: Rgba;
  readonly shade: Rgba;
  readonly gold: Rgba;
  readonly traceRun: Rgba;
  readonly traceRunB: Rgba;
  readonly traceBase: Rgba;
  readonly grainSize: number;
  readonly hairline: number;
  readonly ringPad: number;
  readonly ringGlowPad: number;
  readonly ringGlowBlur: number;
  readonly tracePad: number;
  /** Side of the glare square and of the spinning sweeps, as a multiple of the card width. */
  readonly spotSize: number;
  readonly ringSpan: number;
  /** Foil tile as a multiple of the card size. */
  readonly foilSize: number;
  /** How far a section's canvas reaches past its row, sideways and above and below. */
  readonly surfaceInline: number;
  readonly surfaceBlock: number;
}

/** A computed colour, which browsers serialize as `rgb(r, g, b)` or `rgba(r, g, b, a)`. */
function premultiplied(css: string): Rgba {
  const parts = css.slice(css.indexOf("(") + 1, css.lastIndexOf(")")).split(/[\s,/]+/);
  const [r, g, b, alpha = "1"] = parts.filter((p) => p !== "").map((p) => p.trim());
  if (r === undefined || g === undefined || b === undefined) {
    throw new Error(`gl tokens: cannot parse colour ${css}`);
  }
  const a = alpha.endsWith("%") ? Number(alpha.slice(0, -1)) / 100 : Number(alpha);
  return [(Number(r) / 255) * a, (Number(g) / 255) * a, (Number(b) / 255) * a, a];
}

export function readTokens(root: HTMLElement): GlTokens {
  const probe = document.createElement("div");
  probe.hidden = true;
  root.append(probe);
  const colour = (name: string): Rgba => {
    probe.style.color = `var(${name})`;
    return premultiplied(getComputedStyle(probe).color);
  };
  const raw = getComputedStyle(root);
  const num = (name: string): number => {
    // Lengths are px and percentages %, the only units these tokens use.
    const [first = ""] = raw.getPropertyValue(name).trim().split(" ", 1);
    const v = Number(first.replace(/px$|%$/, ""));
    if (Number.isNaN(v)) throw new TypeError(`gl tokens: ${name} is not a number`);
    return v;
  };
  try {
    return {
      paper: colour("--color-paper"),
      glint: colour("--glint"),
      shade: colour("--shade"),
      gold: colour("--ring-gold"),
      traceRun: colour("--trace-run"),
      traceRunB: colour("--trace-runb"),
      traceBase: colour("--trace-base"),
      grainSize: num("--grain-size"),
      hairline: num("--edge-hairline"),
      ringPad: num("--ring-pad"),
      ringGlowPad: num("--ring-glow-pad"),
      ringGlowBlur: num("--ring-glow-blur"),
      tracePad: num("--trace-pad"),
      spotSize: num("--spot-size") / 100,
      ringSpan: num("--ring-span") / 100,
      foilSize: num("--foil-size") / 100,
      surfaceInline: num("--gl-margin-inline"),
      surfaceBlock: num("--gl-margin-block"),
    };
  } finally {
    probe.remove();
  }
}

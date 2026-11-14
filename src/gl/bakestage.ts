// The build bake's stage (`?bake`, driven by scripts/bake-faces.ts). Every face and card back
// that resolves to "build" (bake.ts) is laid out at its artboard size, untransformed and on
// screen, with what the shader or the DOM draws hidden, so the headless browser's screenshot
// of each cell is the baked image. `globalThis.bakeStage` lists the cells once fonts are in.

import { FACE } from "../data";
import type { CardRefs } from "../dom";
import { bakeKey, DOM_PART, isBuildBaked, SHADER_DRAWN } from "./bake";

export interface BakeStage {
  /** Keys of the staged cells, each the `data-bake-key` of one `.bake-cell`. */
  readonly keys: readonly string[];
}

export async function stageBuildBakes(cards: readonly CardRefs[]): Promise<void> {
  const stage = document.createElement("div");
  stage.className = "bake-stage";
  const keys = new Set<string>();
  const add = (root: Element | null | undefined, board: { readonly bw: number; readonly bh: number }): void => {
    if (!root || !isBuildBaked(root)) return;
    const key = bakeKey(root, board);
    if (keys.has(key)) return;
    keys.add(key);
    const cell = document.createElement("div");
    cell.className = "bake-cell";
    cell.dataset.bakeKey = key;
    cell.style.setProperty("--cell-w", `${String(board.bw)}px`);
    cell.style.setProperty("--cell-h", `${String(board.bh)}px`);
    const copy = root.cloneNode(true);
    if (!(copy instanceof Element)) return;
    for (const el of copy.querySelectorAll<HTMLElement>(`${SHADER_DRAWN}, ${DOM_PART}`)) {
      el.style.setProperty("visibility", "hidden");
    }
    cell.append(copy);
    stage.append(cell);
  };
  for (const c of cards) {
    const board = c.def.mini ? FACE.mini : FACE.full;
    add(c.card.querySelector("[data-face]")?.firstElementChild, board);
    add(c.card.querySelector("[data-back]")?.firstElementChild, board);
  }
  document.body.prepend(stage);
  await document.fonts.ready;
  const result: BakeStage = { keys: [...keys] };
  Reflect.set(globalThis, "bakeStage", result);
}

// Images baked at build time (bake.ts, scripts/bake-faces.ts), loaded in place of a snapshot on
// the device. Without a manifest (the dev server, a build without the bake step) or without an
// image for a face's key, the face is rasterized on the device as before.

import { bakeKey, isBuildBaked, type BakeManifest } from "./bake";

interface Loaded {
  readonly manifest: BakeManifest;
  readonly base: URL;
}

const MANIFEST = "baked/manifest.json";
const state: { loading?: Promise<Loaded | undefined> } = {};
/** Keys already reported missing, so each is reported once. */
const missing = new Set<string>();
const images = new Map<string, Promise<ImageBitmap | undefined>>();

function isManifest(v: unknown): v is BakeManifest {
  return (
    typeof v === "object" &&
    v !== null &&
    "scale" in v &&
    typeof v.scale === "number" &&
    "images" in v &&
    typeof v.images === "object" &&
    v.images !== null
  );
}

async function load(): Promise<Loaded | undefined> {
  const url = new URL(MANIFEST, document.baseURI);
  const res = await fetch(url);
  // The dev server answers a missing file with the page itself.
  if (!res.ok || !(res.headers.get("content-type") ?? "").includes("json")) return undefined;
  const body: unknown = await res.json();
  if (!isManifest(body)) throw new Error(`gl: ${MANIFEST} is not a bake manifest`);
  return { manifest: body, base: url };
}

async function fetchImage(url: URL): Promise<ImageBitmap> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`gl: baked image ${url.href}: ${String(res.status)}`);
  return createImageBitmap(await res.blob());
}

/** The build-baked image of `root` (a face's content or a card back), if there is one. */
export async function bakedImage(
  root: Element | null | undefined,
  board: { readonly bw: number; readonly bh: number },
): Promise<ImageBitmap | undefined> {
  if (!root || !isBuildBaked(root)) return undefined;
  state.loading ??= load();
  const loaded = await state.loading;
  const key = bakeKey(root, board);
  const file = loaded?.manifest.images[key];
  if (!loaded || file === undefined) {
    const what = loaded ? key : "any face (no bake manifest)";
    if (!missing.has(what)) console.warn(`gl: no build-baked image for ${what}; rasterizing on the device`);
    missing.add(what);
    return undefined;
  }
  let image = images.get(key);
  if (!image) {
    image = fetchImage(new URL(file, loaded.base));
    images.set(key, image);
  }
  return image;
}

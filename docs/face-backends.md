# Face backends

The cards are drawn with WebGL (the default; where WebGL cannot start, the DOM cards draw themselves, which `?nogl` forces for testing), and each card's face reaches the GPU as a texture. Where that texture comes from is a backend, chosen per browser, and per element by `data-bake`.

## The backends

| Backend | Where | How a face becomes a texture | Interactivity |
| --- | --- | --- | --- |
| Drawable (`src/gl/drawable.ts`) | Browsers with HTML-in-Canvas: Chromium 157 and later | The real face lives in a small 2D canvas (`content="drawable"`) inside its card; the browser paints it with `drawElementImage`, and every `paint` event uploads it again | The face is the real element: typing, caret, selection, controls and scrolling work directly, and the rendering follows on the next paint |
| Snapshot (`src/gl/raster.ts`) | Every browser; the default where HTML-in-Canvas is missing (Firefox, Safari) | The faces are copied into an off-screen grid and rasterized through an SVG `foreignObject` into one atlas per card size. Stand-ins cover what that misses: form controls are redrawn with CSS, one-line text is kept on one line, changing text is repainted with Canvas2D (`data-bake="live"`) | The face is an invisible copy that takes input; a card being edited is drawn by the DOM until it goes quiet, then snapshotted again; `data-bake="none"` parts stay DOM over the canvas |
| Build bake (`scripts/bake-faces.ts`) | Any browser, for faces and backs marked `data-bake="build"` | Screenshotted at 4x in headless Chromium during `pnpm build`, loaded as images, keyed by a hash of the markup | Static |

Choosing:

- By default Drawable where the browser has it, else Snapshot.
- `?glsrc=snapshot` uses Snapshot in any browser, Chromium included.
- `?glsrc=drawable` insists on Drawable and fails where it is missing.
- With Snapshot faces, hybrid rendering is opt-in (`?hybrid`, or the panel's "Hybrid rendering" toggle, remembered per browser; `?hybrid=0` forces it off): cards at rest draw in CSS and only cards that move, are showcased or scroll draw in WebGL. On the phone it matched CSS at rest and WebGL while moving, but full WebGL held up better overall, so it is off by default.
- `data-bake="build"` on a face or back uses its baked image with either backend; on the dev server, which has no bake, it falls back to the backend.

The HUD (`?hud`) shows the backend in use next to "webgl".

## HTML-in-Canvas outside Chromium

As of 2026-11-15, Firefox has no HTML-in-Canvas and no announced plans for it, so Snapshot is the Firefox backend for the foreseeable future. Mozilla's standards-position request ([mozilla/standards-positions#1076](https://github.com/mozilla/standards-positions/issues/1076), open since September 2024) carries no position yet, and no implementation bug turned up on Bugzilla. Chromium's intent to extend its experiment lists Gecko as "No signal" ([blink-dev](http://www.mail-archive.com/blink-dev@chromium.org/msg17385.html)). In that thread (March 2026), Mozilla engineers objected that the API lets scripts read back how the browser rendered HTML: it would make rendering observable, upgrade fingerprinting (fonts, GPU and driver quirks, colour profiles, accessibility settings), and invite pages that depend on one browser's exact pixels. They also said that rich UIs drawn in canvas are something Mozilla wants to push back on rather than make easier. Chromium's answer, a privacy-preserving painting mode instead of tainting the canvas, was still under discussion. Safari has no implementation either.

## What was measured

`bench/matrix.py` (`just matrix --serial …`) ran on a Samsung SM-A576B (Android 17, Xclipse GPU) with Firefox 160 and Chrome 157, on 2026-11-14. Full tables: `bench/results/face-backends-2026-11-14.md`.

Fidelity is a backend's face against the same browser's own rendering of the same element (`bench/parity.py`, 34 fixtures at the card scale 0.68). Cells are wrong pixels with a 1 px tolerance and the mean difference out of 255. The harness has a floor of about 1.5% on shapes: a backend drawing the very same picture still scores that, since the reference screenshot and the canvas differ by about a pixel in size.

### Fidelity

- Drawable in Chrome was the most faithful: 31 of 34 fixtures under 0.75% wrong pixels, form controls at 0.02-0.55% (it uses the browser's own controls), the worst the unit face (1.49%) and borders (1.37%), at the harness floor.
- Snapshot in Firefox: most fixtures under 1%; above it were gradients (3.9%, the repeating linear gradients Firefox for Android paints solid in SVG images; the card back avoids them), text fields (2.2%), borders (1.9%), pseudo-elements (1.2%, the lost `::first-letter`) and the Lab note (2.5%, by design: its textarea is a DOM part, left out of the snapshot).
- Snapshot in Chrome was worse than in Firefox on controls (select 6.1%, slider 3.9%), because the stand-ins are drawn like Firefox for Android's controls, not Chrome's.
- Build bakes matched graphics and display type (glyph faces 0.12-0.16%, the back 0.19% in Firefox) but not body text or controls (unit face 5.4-6.7%: Chromium on Linux wraps "25% more damage." onto a third line; select 9.9% in Firefox).

### Consistency between the browsers

- Firefox's and Chrome's own renderings differed most on form controls (select 10.7%, slider 7.5%, text fields 4.2%, the Lab form 4.0%) and less on text (unit face 2.0%, list 3.0%).
- Through Snapshot, the two browsers looked most alike (select 7.1%, slider 5.3%, unit face 0.15%): the stand-ins draw the same controls in both.
- Firefox Snapshot against Chrome Drawable differed as much as the browsers' own renderings on controls (select 10.9%, slider 7.5%), and little elsewhere (unit face 0.06%).

So Drawable shows each browser's faces as that browser draws them; Snapshot makes Firefox and Chrome look more alike, at the cost of controls that do not match Chrome's; Build makes them identical, for what it covers.

### Speed and memory (medians of 3 rounds, `?lab`)

| Config | Time to WebGL | Rasterizing faces | Lab at rest | Opening the showcase | Browser PSS at rest / after |
| --- | --- | --- | --- | --- | --- |
| Firefox, Snapshot | 2773 ms | 2099 ms | 119 fps median, p5 118 | 119 fps median, p5 40, 9 frames over 25 ms | 1344 / 1494 MB |
| Chrome, Drawable | 978 ms | 557 ms | 60 fps median, p5 59 | 60 fps median, p5 59, 0 frames over 25 ms | 789 / 776 MB |
| Chrome, Snapshot | 1783 ms | 1347 ms | 60 fps median, p5 59 | 60 fps median, p5 59, 3 frames over 25 ms | 870 / 888 MB |

- In Chrome, Drawable was ready in about half the time of Snapshot (557 against 1347 ms to rasterize), dropped no frames while the showcase opened (Snapshot dropped 3, from its sharper re-snapshot), and used about 80-110 MB less.
- Chrome ran page frames at 60 Hz on this phone although the display was pinned to 120 Hz, so frame rates compare within Chrome only. This is Chromium's main-frame throttle (`ThrottleMainFrameTo60Hz`, on by default on Android): on displays above about 108 Hz, `requestAnimationFrame` and everything drawn from it run at half the refresh rate while the compositor keeps the full rate. In Chrome 157 on this phone, main-thread rAF ran at 59.6 fps and a worker's `OffscreenCanvas` rAF at 119.4 fps on the same page. With the feature turned off (`--disable-features=ThrottleMainFrameTo60Hz`), both backends ran the Lab and the showcase at 119 fps median, 117.6 fps 5th percentile, in two interleaved rounds; with it on, at 59.5-59.9. The 60 fps is the browser default, not a limit of either backend. Firefox ran at 120 Hz; its 9 long frames in the showcase are the sharper re-snapshot about 900 ms in.
- PSS is the browser's whole footprint (every process), so it compares the two Chrome backends with each other better than Chrome with Firefox.

## Limits

- Drawable: a back is drawn from a copy in its own invisible canvas, since a hidden canvas draws nothing; with the face's own `scale(--face-k)` left on, Chromium 159 drew the face at that share of the canvas, so the face's transform is removed inside the canvas.
- Snapshot: see the stand-ins above; `::first-letter`, `counter()` content and the line-clamp ellipsis are still lost.
- Build: whole faces and backs only; a build face holding runtime or live parts falls back.

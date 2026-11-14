# /// script
# requires-python = ">=3.12"
# dependencies = ["selenium==4.52.0", "playwright==1.65.1", "pillow==12.0.0", "numpy==2.3.5", "typer==0.20.0"]
# ///
"""Snapshot parity: the WebGL renderer's face snapshots against the browser's own rendering.

  uv run bench/parity.py dist --target phone --serial SERIAL
  uv run bench/parity.py dist --target firefox --k 0.68 --baker canvas

DIR is a built site (`vite build` output) holding debug/parity.html, a page of fixtures, one
card face each, covering kinds of text, boxes, layout and form controls, plus the real faces
from index.html. For every fixture the browser's screenshot of the face is the reference, and
the face rasterized through the renderer's atlas (src/gl/raster.ts) is compared with it.

Pixels are compared with a 1 px tolerance in position: a pixel counts as wrong when no pixel
of the snapshot within one pixel of it is within 48 of it in every colour channel. That
ignores antialiasing and subpixel shifts and keeps changed line breaks, missing controls and
wrong colours. The mean difference is reported too, since a tint or wash moves every pixel a
little and none past the tolerance. The report (report.html in the output directory) ranks
fixtures by both, with the reference, the snapshot and a map of the wrong pixels.

--k scales the faces the way a card on the table does (0.68 for a 150 px card), and the
snapshot is taken at k x devicePixelRatio, as the renderer takes it. --factor multiplies the
snapshot scale further (3 for the showcase's sharper copy); the snapshot is then resized to
the reference before comparing. --baker canvas uses the html2canvas baker (?glsrc=canvas).
"""

import base64
import enum
import html
import io
import json
import time
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Annotated, Protocol

import numpy as np
import typer
from device import android_firefox, reverse, serve
from numpy.typing import NDArray
from PIL import Image
from playwright.sync_api import Page, sync_playwright
from selenium.webdriver.common.by import By
from selenium.webdriver.firefox.webdriver import WebDriver

PORT = 18771
PAGE_BG = (20, 22, 28)
TOLERANCE = 48
ALIGN = 4
EDGE = 2
FACE = '[data-fixture="{}"] .slot'


class Target(enum.StrEnum):
    PHONE = "phone"
    FIREFOX = "firefox"
    CHROMIUM = "chromium"


class Baker(enum.StrEnum):
    SVG = "svg"
    CANVAS = "canvas"


class Browser(Protocol):
    def goto(self, url: str) -> None: ...
    def js(self, expr: str) -> object: ...
    def snap(self, fixture: str, scale: float) -> str: ...
    def shot(self, fixture: str) -> bytes: ...


class SeleniumBrowser:
    def __init__(self, driver: WebDriver) -> None:
        self.d = driver
        self.d.set_script_timeout(120)

    def goto(self, url: str) -> None:
        self.d.get(url)

    def js(self, expr: str) -> object:
        return self.d.execute_script(f"return {expr};")

    def snap(self, fixture: str, scale: float) -> str:
        return str(
            self.d.execute_async_script(
                "const done = arguments[arguments.length - 1];"
                "parity.snap(arguments[0], arguments[1]).then(done, (e) => done('ERR ' + e));",
                fixture,
                scale,
            )
        )

    def shot(self, fixture: str) -> bytes:
        el = self.d.find_element(By.CSS_SELECTOR, FACE.format(fixture))
        self.d.execute_script("arguments[0].scrollIntoView({block: 'center'});", el)
        time.sleep(0.3)
        return el.screenshot_as_png


class PlaywrightBrowser:
    def __init__(self, page: Page) -> None:
        self.page = page

    def goto(self, url: str) -> None:
        self.page.goto(url)

    def js(self, expr: str) -> object:
        return self.page.evaluate(expr)

    def snap(self, fixture: str, scale: float) -> str:
        return str(self.page.evaluate("([id, s]) => parity.snap(id, s).catch((e) => 'ERR ' + e)", [fixture, scale]))

    def shot(self, fixture: str) -> bytes:
        loc = self.page.locator(FACE.format(fixture))
        loc.scroll_into_view_if_needed()
        return loc.screenshot()


@contextmanager
def browser(target: Target, serial: str | None, dpr: float) -> Iterator[Browser]:
    if target is Target.PHONE:
        if serial is None:
            raise typer.BadParameter("--serial is required for the phone")
        with reverse(serial, PORT), android_firefox(serial) as driver:
            yield SeleniumBrowser(driver)
        return
    with sync_playwright() as pw:
        kind = pw.firefox if target is Target.FIREFOX else pw.chromium
        b = kind.launch()
        try:
            ctx = b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=dpr)
            yield PlaywrightBrowser(ctx.new_page())
        finally:
            b.close()


@dataclass(frozen=True)
class Result:
    fixture: str
    wrong_pct: float
    mean_diff: float
    size: tuple[int, int]
    shift: tuple[int, int]

    @property
    def score(self) -> float:
        """Ranking: wrong pixels, plus the mean difference, which catches a tint or wash that
        moves every pixel a little and no pixel past the tolerance."""
        return self.wrong_pct + self.mean_diff / 5


def rgb(png: bytes) -> NDArray[np.uint8]:
    """Decodes a PNG, flattened onto the page background."""
    im = Image.open(io.BytesIO(png)).convert("RGBA")
    bg = Image.new("RGBA", im.size, (*PAGE_BG, 255))
    return np.asarray(Image.alpha_composite(bg, im).convert("RGB"), dtype=np.uint8)


def shifted(img: NDArray[np.int16], dy: int, dx: int) -> NDArray[np.int16]:
    """`img` moved by (dy, dx), edges repeated."""
    pad = max(abs(dy), abs(dx))
    h, w = img.shape[:2]
    p = np.pad(img, ((pad, pad), (pad, pad), (0, 0)), mode="edge")
    return p[pad - dy : pad - dy + h, pad - dx : pad - dx + w]


def align(ref: NDArray[np.int16], snap: NDArray[np.int16]) -> tuple[int, int]:
    """The whole-pixel shift of `snap` (up to ALIGN px) that best matches `ref`. The reference
    screenshot of a box at a fractional position lands a pixel or two off the snapshot."""
    inner = (slice(ALIGN, -ALIGN), slice(ALIGN, -ALIGN))
    shifts = [(dy, dx) for dy in range(-ALIGN, ALIGN + 1) for dx in range(-ALIGN, ALIGN + 1)]
    return min(shifts, key=lambda s: float(np.abs(ref[inner] - shifted(snap, *s)[inner]).mean()))


def wrong_pixels(ref: NDArray[np.uint8], snap: NDArray[np.uint8]) -> tuple[NDArray[np.bool_], float, tuple[int, int]]:
    """Mask of reference pixels with no snapshot pixel within 1 px that matches them (after
    the best whole-image shift, and leaving out a frame of EDGE px), the mean per-pixel
    difference after the shift, and the shift."""
    a = ref.astype(np.int16)
    shift = align(a, snap.astype(np.int16))
    b = shifted(snap.astype(np.int16), *shift)
    best = np.full(a.shape[:2], 255, dtype=np.int16)
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            best = np.minimum(best, np.abs(a - shifted(b, dy, dx)).max(axis=2))
    mask = best > TOLERANCE
    mask[:EDGE] = mask[-EDGE:] = False
    mask[:, :EDGE] = mask[:, -EDGE:] = False
    return mask, float(np.abs(a - b).mean()), shift


def heat(ref: NDArray[np.uint8], mask: NDArray[np.bool_]) -> Image.Image:
    grey = (ref.mean(axis=2) * 0.35).astype(np.uint8)
    out = np.stack([grey, grey, grey], axis=2)
    out[mask] = (255, 40, 40)
    return Image.fromarray(out)


def compare(b: Browser, fixture: str, scale: float, out: Path) -> Result:
    ref_png = b.shot(fixture)
    data = b.snap(fixture, scale)
    if not data.startswith("data:image/png;base64,"):
        raise RuntimeError(f"{fixture}: snapshot failed: {data[:200]}")
    ref = rgb(ref_png)
    snap_img = Image.fromarray(rgb(base64.b64decode(data.split(",", 1)[1])))
    snap = np.asarray(snap_img.resize((ref.shape[1], ref.shape[0]), Image.Resampling.LANCZOS), dtype=np.uint8)
    mask, mean, shift = wrong_pixels(ref, snap)
    Image.fromarray(ref).save(out / f"{fixture}-ref.png")
    Image.fromarray(shifted(snap.astype(np.int16), *shift).astype(np.uint8)).save(out / f"{fixture}-snap.png")
    heat(ref, mask).save(out / f"{fixture}-wrong.png")
    return Result(fixture, float(mask.mean() * 100), mean, (ref.shape[1], ref.shape[0]), shift)


def report(results: list[Result], title: str, out: Path) -> None:
    rows = "\n".join(
        f"<tr><td><b>{html.escape(r.fixture)}</b><br>{r.wrong_pct:.2f}% wrong<br>mean diff {r.mean_diff:.1f}<br>{r.size[0]}x{r.size[1]}<br>shift {r.shift}</td>"
        + "".join(f'<td><img src="{html.escape(r.fixture)}-{k}.png" alt="{k}"></td>' for k in ("ref", "snap", "wrong"))
        + "</tr>"
        for r in sorted(results, key=lambda r: -r.score)
    )
    (out / "report.html").write_text(
        f"""<!doctype html><meta charset="utf-8"><title>{html.escape(title)}</title>
<style>body{{font:13px system-ui,sans-serif;background:#f4f4f4;color:#111;margin:16px}}
td{{vertical-align:top;padding:6px}}img{{max-width:240px;height:auto;display:block}}
th{{text-align:start}}</style>
<h1>{html.escape(title)}</h1><p>Reference (the browser's rendering), snapshot, wrong pixels in red.</p>
<table><tr><th>fixture</th><th>reference</th><th>snapshot</th><th>wrong</th></tr>{rows}</table>""",
        encoding="utf-8",
    )


def main(
    dist: Annotated[Path, typer.Argument(help="built site holding debug/parity.html")],
    target: Annotated[Target, typer.Option()] = Target.PHONE,
    serial: Annotated[str | None, typer.Option(help="adb serial, for the phone")] = None,
    k: Annotated[float, typer.Option(help="card scale applied to the faces")] = 1.0,
    factor: Annotated[float, typer.Option(help="extra snapshot scale")] = 1.0,
    baker: Annotated[Baker, typer.Option()] = Baker.SVG,
    dpr: Annotated[float, typer.Option(help="device scale for desktop browsers")] = 2.857,
    only: Annotated[str | None, typer.Option(help="comma-separated fixture ids")] = None,
    out: Annotated[Path, typer.Option()] = Path(".scratch/parity"),
) -> None:
    """Compare face snapshots with the browser's rendering, fixture by fixture."""
    name = f"{target}-{baker}-k{k:g}-f{factor:g}"
    run_dir = out / name
    run_dir.mkdir(parents=True, exist_ok=True)
    query = f"?k={k:g}" + ("&glsrc=canvas" if baker is Baker.CANVAS else "")
    with serve(dist, PORT) as base, browser(target, serial, dpr) as b:
        b.goto(f"{base}/debug/parity.html{query}")
        for _ in range(120):
            if b.js("document.documentElement.dataset.parity") == "ready":
                break
            time.sleep(0.5)
        else:
            raise RuntimeError("parity page did not get ready")
        ids = b.js("parity.ids")
        page_dpr = b.js("devicePixelRatio")
        assert isinstance(ids, list) and isinstance(page_dpr, (int, float))
        wanted = set(only.split(",")) if only else None
        results: list[Result] = []
        for fixture in (str(i) for i in ids):
            if wanted is not None and fixture not in wanted:
                continue
            r = compare(b, fixture, k * float(page_dpr) * factor, run_dir)
            results.append(r)
            print(f"{r.wrong_pct:7.2f}%  {r.mean_diff:5.1f}  {r.shift}  {fixture}", flush=True)
    report(results, f"Snapshot parity: {name}, devicePixelRatio {page_dpr}", run_dir)
    (run_dir / "results.json").write_text(json.dumps([r.__dict__ for r in results], indent=1), encoding="utf-8")
    print(f"report: {run_dir / 'report.html'}")


if __name__ == "__main__":
    typer.run(main)

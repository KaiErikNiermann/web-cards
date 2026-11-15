# /// script
# requires-python = ">=3.12"
# dependencies = ["selenium==4.52.0", "playwright==1.65.1", "pillow==12.0.0", "numpy==2.3.5", "typer==0.20.0"]
# ///
"""Face backends side by side on one Android phone: Firefox (snapshots) and Chrome (HTML-in-Canvas
or snapshots), for design consistency, speed and memory.

  uv run bench/matrix.py dist --serial SERIAL [--rounds 2] [--skip-parity]

DIR is a built site (`vite build`, with the bake). Three parts, written to one report
(.scratch/matrix/report.md and results.json):

1. Fidelity: bench/parity.py for each backend in its browser, the face it makes against that
   browser's own rendering: Firefox snapshot, Chrome snapshot, Chrome drawable, and the build
   bake against each browser.
2. Consistency: the two browsers' own renderings of each fixture against each other, and what
   a user of each sees through WebGL (Firefox snapshot against Chrome drawable), with the
   parity metric (wrong pixels with a 1 px tolerance, mean difference).
3. Speed and memory, in the app (?lab) for Firefox snapshot, Chrome drawable and Chrome
   snapshot, in interleaved rounds with the display pinned to 120 Hz: time until WebGL draws,
   frame rate with the Lab in view at rest and while a card opens in the showcase (median and
   5th percentile rates from the frame gaps, and frames over 25 ms), and the browser's total PSS (all its processes,
   from dumpsys meminfo) at rest and after the showcase.
"""

import itertools
import json
import re
import statistics
import subprocess
import sys
import time
from collections.abc import Callable
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Annotated

import numpy as np
import typer
from device import adb, serve
from parity import Browser, PlaywrightBrowser, Target, browser, rgb, wrong_pixels
from PIL import Image

PORT = 18771
FIREFOX = "org.mozilla.firefox"
CHROME = "com.android.chrome"
K = 0.68
FIDELITY = (
    ("phone", "svg"),
    ("phone-chrome", "svg"),
    ("phone-chrome", "drawable"),
    ("phone", "build"),
    ("phone-chrome", "build"),
)


@dataclass(frozen=True)
class AppConfig:
    name: str
    target: Target
    package: str
    query: str


APPS = (
    AppConfig("Firefox, snapshot", Target.PHONE, FIREFOX, "?lab&hybrid=0"),
    AppConfig("Chrome, drawable", Target.PHONE_CHROME, CHROME, "?lab"),
    AppConfig("Chrome, snapshot", Target.PHONE_CHROME, CHROME, "?lab&glsrc=snapshot"),
)


@dataclass(frozen=True)
class Rates:
    """From the gaps between animation frames: the median rate, the 5th percentile rate (95% of
    frames came at least this fast) and the frames that took over 25 ms."""

    median_fps: float
    p5_fps: float
    long_frames: int


@dataclass
class AppRun:
    config: str
    ready_ms: float
    raster_ms: float
    faces: str
    idle: Rates
    show: Rates
    opened: bool
    pss_rest_mb: float
    pss_show_mb: float


def run_parity(dist: Path, serial: str, target: str, baker: str, out: Path) -> Path:
    cmd = ["uv", "run", "-q", "bench/parity.py", str(dist), "--target", target, "--serial", serial, "--k", str(K), "--baker", baker, "--out", str(out)]
    subprocess.run(cmd, check=True)
    return out / f"{target}-{baker}-k{K:g}-f1"


def pair(a_dir: Path, a_kind: str, b_dir: Path, b_kind: str) -> dict[str, tuple[float, float]]:
    """Per fixture: wrong pixels (%) and mean difference between two runs' images."""
    out: dict[str, tuple[float, float]] = {}
    for f in sorted(a_dir.glob(f"*-{a_kind}.png")):
        fixture = f.name.removesuffix(f"-{a_kind}.png")
        g = b_dir / f"{fixture}-{b_kind}.png"
        if not g.exists():
            continue
        a = rgb(f.read_bytes())
        b = np.asarray(Image.fromarray(rgb(g.read_bytes())).resize((a.shape[1], a.shape[0]), Image.Resampling.LANCZOS))
        mask, mean, _ = wrong_pixels(a, b)
        out[fixture] = (float(mask.mean() * 100), mean)
    return out


def pss_mb(serial: str, package: str) -> float:
    """Total PSS of every process whose name starts with `package`, in MB."""
    text = adb(serial, "shell", "dumpsys", "meminfo")
    block = text.split("Total PSS by process:", 1)[-1].split("Total PSS by OOM", 1)[0]
    total = 0
    for m in re.finditer(r"([\d,]+)K: (\S+)", block):
        if m.group(2).startswith(package) and "chromecustomizations" not in m.group(2):
            total += int(m.group(1).replace(",", ""))
    return total / 1024


# One expression: the WebDriver wrapper prefixes `return`, which would end a statement list early.
SAMPLE = "(() => { window.__f = []; (function l(t) { window.__f.push(t); if (window.__f.length < 2000) requestAnimationFrame(l); })(performance.now()); return 0; })()"


def rates(b: Browser, seconds: float) -> Rates:
    b.js(SAMPLE)
    time.sleep(seconds)
    ts = b.js("window.__f.splice(0)")
    assert isinstance(ts, list) and len(ts) > 2
    gaps = sorted(b2 - a for a, b2 in itertools.pairwise(float(x) for x in ts) if b2 > a)
    return Rates(1000 / statistics.median(gaps), 1000 / gaps[int(len(gaps) * 0.95)], sum(g > 25 for g in gaps))


def tap_card(b: Browser, serial: str, card: str) -> None:
    """A tap at the bottom edge of `card` (its empty part on the Lab faces): a DevTools touch in
    Chrome, a real touch through adb in Firefox."""
    where = b.js(
        f"(() => {{ const r = document.querySelector('[data-card=\"{card}\"] .card').getBoundingClientRect();"
        " return [r.x + r.width / 2, r.y + r.height - 6, devicePixelRatio, window.mozInnerScreenY ?? 0]; })()"
    )
    assert isinstance(where, list)
    x, y, dpr, top = (float(v) for v in where)
    if isinstance(b, PlaywrightBrowser):
        # A browser attached over DevTools has no touchscreen in Playwright; send the touch.
        cdp = b.page.context.new_cdp_session(b.page)
        cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [{"x": x, "y": y}]})
        cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
    else:
        adb(serial, "shell", "input", "tap", str(int(x * dpr)), str(int((y + top) * dpr)))


def app_run(base: str, serial: str, cfg: AppConfig) -> AppRun:
    adb(serial, "shell", "am", "force-stop", cfg.package)
    with browser(cfg.target, serial, 1.0) as b:
        t0 = time.monotonic()
        b.goto(f"{base}/index.html{cfg.query}")
        for _ in range(200):
            if b.js("document.querySelector('[data-root]')?.dataset.gl") in ("on", "failed"):
                break
            time.sleep(0.1)
        ready = (time.monotonic() - t0) * 1000
        raster = float(str(b.js("document.querySelector('[data-root]').dataset.glRasterMs ?? 'nan'")))
        faces = str(b.js("document.querySelector('[data-root]').dataset.glFaces ?? ''"))
        b.js("(() => { document.querySelector('[data-card=\"l-form\"]').scrollIntoView({block: 'center'}); return 0; })()")
        time.sleep(3)
        idle = rates(b, 3)
        rest = pss_mb(serial, cfg.package)
        tap_card(b, serial, "l-form")
        show = rates(b, 1.5)
        opened = bool(b.js("document.querySelector('[data-card=\"l-form\"]').hasAttribute('data-show')"))
        time.sleep(2)
        shown = pss_mb(serial, cfg.package)
    return AppRun(cfg.name, ready, raster, faces, idle, show, opened, rest, shown)


def table(rows: list[list[str]], head: list[str]) -> str:
    out = ["| " + " | ".join(head) + " |", "| " + " | ".join("---" for _ in head) + " |"]
    out += ["| " + " | ".join(r) + " |" for r in rows]
    return "\n".join(out)


def main(
    dist: Annotated[Path, typer.Argument(help="built site")],
    serial: Annotated[str, typer.Option()],
    rounds: Annotated[int, typer.Option()] = 2,
    skip_parity: Annotated[bool, typer.Option(help="reuse the parity runs already in --out")] = False,
    out: Annotated[Path, typer.Option()] = Path(".scratch/matrix"),
) -> None:
    """Fidelity, cross-browser consistency, speed and memory of the face backends on a phone."""
    out.mkdir(parents=True, exist_ok=True)
    runs = {
        (t, k): (out / f"{t}-{k}-k{K:g}-f1" if skip_parity else run_parity(dist, serial, t, k, out))
        for t, k in FIDELITY
    }
    fidelity = {f"{t} {k}": json.loads((d / "results.json").read_text()) for (t, k), d in runs.items()}
    consistency = {
        "Firefox native vs Chrome native": pair(runs["phone", "svg"], "ref", runs["phone-chrome", "svg"], "ref"),
        "Firefox snapshot vs Chrome drawable": pair(runs["phone", "svg"], "snap", runs["phone-chrome", "drawable"], "snap"),
        "Firefox snapshot vs Chrome snapshot": pair(runs["phone", "svg"], "snap", runs["phone-chrome", "svg"], "snap"),
    }
    # Speed and memory, with the display pinned to 120 Hz and rounds interleaved.
    adb(serial, "shell", "settings", "put", "system", "min_refresh_rate", "120.0")
    adb(serial, "shell", "settings", "put", "system", "peak_refresh_rate", "120.0")
    app: list[AppRun] = []
    try:
        with serve(dist, PORT) as base:
            for r in range(rounds):
                for cfg in APPS:
                    run = app_run(base, serial, cfg)
                    app.append(run)
                    print(f"round {r}: {run}", flush=True)
    finally:
        adb(serial, "shell", "settings", "delete", "system", "min_refresh_rate", check=False)
        adb(serial, "shell", "settings", "delete", "system", "peak_refresh_rate", check=False)
    write_report(out, fidelity, consistency, app)


def median(xs: list[float]) -> float:
    return statistics.median(xs) if xs else float("nan")


def write_report(
    out: Path,
    fidelity: dict[str, list[dict[str, object]]],
    consistency: dict[str, dict[str, tuple[float, float]]],
    app: list[AppRun],
) -> None:
    fixtures = sorted({str(r["fixture"]) for rs in fidelity.values() for r in rs})
    pct: Callable[[dict[str, object]], str] = lambda r: f"{float(str(r['wrong_pct'])):.2f}% / {float(str(r['mean_diff'])):.1f}"
    fid_rows = [[f] + [next((pct(r) for r in rs if r["fixture"] == f), "") for rs in fidelity.values()] for f in fixtures]
    con_rows = [[f] + [f"{v[f][0]:.2f}% / {v[f][1]:.1f}" if f in v else "" for v in consistency.values()] for f in fixtures]
    by_cfg: dict[str, list[AppRun]] = {}
    for a in app:
        by_cfg.setdefault(a.config, []).append(a)
    app_rows = [
        [
            name,
            f"{runs[0].faces} ({sum(r.opened for r in runs)}/{len(runs)} opened)",
            f"{median([r.ready_ms for r in runs]):.0f}",
            f"{median([r.raster_ms for r in runs]):.0f}",
            f"{median([r.idle.median_fps for r in runs]):.0f} / {median([r.idle.p5_fps for r in runs]):.0f} / {median([float(r.idle.long_frames) for r in runs]):.0f}",
            f"{median([r.show.median_fps for r in runs]):.0f} / {median([r.show.p5_fps for r in runs]):.0f} / {median([float(r.show.long_frames) for r in runs]):.0f}",
            f"{median([r.pss_rest_mb for r in runs]):.0f}",
            f"{median([r.pss_show_mb for r in runs]):.0f}",
        ]
        for name, runs in by_cfg.items()
    ]
    report = "\n\n".join(
        [
            "# Face backends on one phone",
            f"Measured {time.strftime('%Y-%m-%d %H:%M')} by bench/matrix.py. Cells are wrong pixels (1 px tolerance, after the best whole-pixel shift) / mean difference (0-255). The harness floor: a backend that draws the very same picture still scored up to about 1.5% on shapes, since the reference screenshot and the canvas differ by about a pixel in size.",
            "## Fidelity: each backend against its own browser's rendering",
            table(fid_rows, ["fixture", *fidelity.keys()]),
            "## Consistency between the browsers",
            table(con_rows, ["fixture", *consistency.keys()]),
            f"## Speed and memory in the app (?lab), medians of {len(app) // max(1, len(by_cfg))} rounds",
            table(app_rows, ["config", "faces", "ready ms", "raster ms", "Lab at rest fps (median / p5 / frames >25 ms in 3 s)", "showcase fps (median / p5 / frames >25 ms in 1.5 s)", "PSS at rest MB", "PSS after showcase MB"]),
        ]
    )
    (out / "report.md").write_text(report + "\n", encoding="utf-8")
    (out / "results.json").write_text(
        json.dumps({"fidelity": fidelity, "consistency": consistency, "app": [asdict(a) for a in app]}, indent=1),
        encoding="utf-8",
    )
    print(f"report: {out / 'report.md'}")


if __name__ == "__main__":
    sys.exit(typer.run(main))

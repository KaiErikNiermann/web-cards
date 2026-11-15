# /// script
# requires-python = ">=3.12"
# dependencies = ["selenium==4.52.0", "typer==0.20.0"]
# ///
"""Erratic scrolling over the whole card table on an Android phone, measured as presented.

  uv run bench/phone_scroll.py SERIAL DIR [DIR ...] [--query DIR=QUERY] [--css NAME=CSS]
                               [--refresh adaptive|120] [--rounds 2] [--seed 1]

Each DIR is a built site served from this host through `adb reverse`. For every version (and
query or injected-CSS variant) the page is loaded, scrolled to the top, and then swiped with
real touch input (`adb shell input swipe`, so Firefox scrolls and flings through its async
pan-zoom) down to the bottom, up to the top, down and up again: swipes of random length and
speed, a fifth of them against the sweep's direction, with short random pauses. The same
seeded sequence is used for every variant.

What reaches the screen is read from SurfaceFlinger's per-layer frame statistics
(`dumpsys SurfaceFlinger --timestats`, no root needed): frames Firefox presented, frames
dropped, janky frames, and the present-to-present intervals. requestAnimationFrame intervals in
the page are reported too, but scrolling runs on Firefox's compositor, so the page's main
thread can be smooth while the scroll stutters. `--refresh 120` pins the display (restored
afterwards); `adaptive` leaves the phone's own refresh switching, which is what a person gets.
"""

import functools
import http.server
import random
import re
import shutil
import statistics
import subprocess
import threading
import time
from dataclasses import dataclass
from typing import Annotated, Literal

import typer
from android_prompts import auto_answer
from selenium import webdriver
from selenium.webdriver.firefox.service import Service
from selenium.webdriver.support.wait import WebDriverWait

PORT = 18767
INJECT = "const s = document.createElement('style'); s.textContent = arguments[0]; document.head.append(s);"
START_FRAMES = """
window.__frames = []; window.__on = true;
const loop = (t) => { if (!window.__on) return; window.__frames.push(t); requestAnimationFrame(loop); };
requestAnimationFrame(loop);
"""
STOP_FRAMES = "window.__on = false; return window.__frames;"
SCROLL = "return [scrollY, document.documentElement.scrollHeight - innerHeight];"
#: Scroll offset (CSS px) under which no swipe drags the page downward.
NEAR_TOP = 600


@dataclass(frozen=True)
class Swipe:
    """One swipe in screen px: `dy` > 0 moves the finger up, which scrolls the page down."""

    dy: int
    ms: int
    pause: float


@dataclass(frozen=True)
class LayerStats:
    frames: int
    dropped: int
    janky: int
    intervals: dict[int, int]  # present-to-present bucket (ms) -> count


@dataclass(frozen=True)
class Result:
    seconds: float
    layer: LayerStats
    raf: list[float]
    display: str


def adb(serial: str, *args: str, check: bool = True) -> str:
    return subprocess.run(
        ["adb", "-s", serial, *args], capture_output=True, text=True, check=check
    ).stdout


def swipes(rng: random.Random, sign: int) -> list[Swipe]:
    """A pool of erratic swipes for one sweep direction (`sign` 1 = down the page)."""
    out = []
    for _ in range(60):
        fast = rng.random() < 0.5
        dy = rng.randint(250, 1300) * (sign if rng.random() > 0.2 else -sign)
        out.append(
            Swipe(
                dy,
                rng.randint(35, 90) if fast else rng.randint(150, 450),
                rng.uniform(0, 0.25),
            )
        )
    return out


def _field(block: str, key: str) -> int:
    m = re.search(rf"{key} = (\d+)", block)
    return int(m.group(1)) if m else 0


def parse_timestats(dump: str) -> LayerStats:
    """The Firefox SurfaceView layer with the most frames from a `--timestats -dump`."""
    best = LayerStats(0, 0, 0, {})
    for block in dump.split("layerName = ")[1:]:
        name = block.split("\n", 1)[0]
        if "org.mozilla.firefox" not in name:
            continue
        hist = re.search(r"present2present histogram is as below:\n(.*)\n", block)
        intervals = {
            int(k): int(v)
            for k, v in re.findall(r"(\d+)ms=(\d+)", hist.group(1) if hist else "")
            if int(v) > 0
        }
        stats = LayerStats(
            _field(block, "totalFrames"),
            _field(block, "droppedFrames"),
            _field(block, "jankyFrames"),
            intervals,
        )
        if stats.frames > best.frames:
            best = stats
    return best


def display_time(dump: str) -> str:
    """Time the display spent at each refresh rate during the run, from the global stats."""
    part = dump.split("displayConfigStats is as below:", 1)[-1].split(
        "totalP2PTime", 1
    )[0]
    return " ".join(
        f"{hz}:{int(ms) / 1000:.1f}s"
        for hz, ms in re.findall(r"(\d+)fps = (\d+)ms", part)
    )


def screen_size(serial: str) -> tuple[int, int]:
    """The phone's screen in device px."""
    size = re.search(r"(\d+)x(\d+)", adb(serial, "shell", "wm", "size"))
    return (int(size.group(1)), int(size.group(2))) if size else (1080, 2340)


def erratic_scroll(
    driver: webdriver.Firefox,
    serial: str,
    seed: int,
    size: tuple[int, int],
    sweeps: tuple[int, ...] = (1, -1, 1, -1),
) -> None:
    """Swipes the page with real touch input, one sweep per entry of `sweeps` (1 = down the
    page to the bottom, -1 = up to the top), from a seeded pool of erratic swipes."""
    rng = random.Random(seed)
    width, height = size
    x = width - 40  # the page gutter, clear of the cards
    y = 0
    for sign in sweeps:
        for s in swipes(rng, sign)[:40]:
            # Never drag the page down while it is near the top: Firefox would take it as
            # pull-to-refresh and reload the page.
            dy = abs(s.dy) if s.dy < 0 and y < NEAR_TOP else s.dy
            y0 = height // 2 + dy // 2
            y1 = height // 2 - dy // 2
            adb(
                serial,
                "shell",
                "input",
                "swipe",
                str(x),
                str(y0),
                str(x),
                str(y1),
                str(s.ms),
            )
            time.sleep(s.pause)
            y, bottom = driver.execute_script(SCROLL)
            if (sign > 0 and y >= bottom - 2) or (sign < 0 and y <= NEAR_TOP):
                break
    time.sleep(1.0)  # let the last fling settle


def run_sequence(
    driver: webdriver.Firefox, serial: str, seed: int, width: int, height: int
) -> Result:
    adb(serial, "shell", "dumpsys", "SurfaceFlinger", "--timestats", "-disable")
    adb(
        serial, "shell", "dumpsys", "SurfaceFlinger", "--timestats", "-clear", "-enable"
    )
    driver.execute_script(START_FRAMES)
    t0 = time.monotonic()
    erratic_scroll(driver, serial, seed, (width, height))
    seconds = time.monotonic() - t0
    raf = driver.execute_script(STOP_FRAMES)
    dump = adb(serial, "shell", "dumpsys", "SurfaceFlinger", "--timestats", "-dump")
    adb(serial, "shell", "dumpsys", "SurfaceFlinger", "--timestats", "-disable")
    return Result(seconds, parse_timestats(dump), raf, display_time(dump))


def summarize(rs: list[Result]) -> str:
    frames = sum(r.layer.frames for r in rs)
    secs = sum(r.seconds for r in rs)
    hist: dict[int, int] = {}
    for r in rs:
        for k, v in r.layer.intervals.items():
            hist[k] = hist.get(k, 0) + v
    # Gaps over 100 ms are the page going idle between swipes, not missed frames.
    total = sum(v for k, v in hist.items() if k <= 100) or 1

    def share(lo: int, hi: int) -> float:
        return sum(v for k, v in hist.items() if lo <= k <= hi) / total

    gaps = [b - a for r in rs for a, b in zip(r.raf, r.raf[1:], strict=False)]
    long_raf = sum(1 for g in gaps if g > 20) / max(1, len(gaps))
    return (
        f"{frames / secs:6.1f} fps shown  "
        f"{share(0, 9) * 100:5.1f}% at 120 Hz cadence  {share(10, 17) * 100:5.1f}% at 60  "
        f"{share(18, 100) * 100:5.1f}% 18-100 ms  idle gaps {sum(v for k, v in hist.items() if k > 100):3d}  dropped {sum(r.layer.dropped for r in rs):3d}  "
        f"janky {sum(r.layer.janky for r in rs):3d}  "
        f"rAF {len(gaps) / secs:5.1f}/s, >20 ms {long_raf * 100:4.1f}%  "
        f"display {rs[-1].display}"
    )


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, format: str, *args: object) -> None:  # noqa: A002
        pass


def main(
    serial: str,
    versions: list[str],
    root: Annotated[
        str, typer.Option(help="Directory that holds the version directories")
    ] = ".scratch/versions",
    query: Annotated[
        list[str] | None, typer.Option(help="DIR=QUERY, repeatable")
    ] = None,
    css: Annotated[
        list[str] | None, typer.Option(help="NAME=CSS injected, repeatable")
    ] = None,
    refresh: Annotated[Literal["adaptive", "120"], typer.Option()] = "adaptive",
    rounds: Annotated[int, typer.Option()] = 2,
    seed: Annotated[int, typer.Option()] = 1,
) -> None:
    server = http.server.ThreadingHTTPServer(
        ("127.0.0.1", PORT), functools.partial(QuietHandler, directory=root)
    )
    threading.Thread(target=server.serve_forever, daemon=True).start()
    adb(serial, "reverse", f"tcp:{PORT}", f"tcp:{PORT}")
    width, height = screen_size(serial)
    if refresh == "120":
        adb(serial, "shell", "settings", "put", "system", "min_refresh_rate", "120.0")
        adb(serial, "shell", "settings", "put", "system", "peak_refresh_rate", "120.0")
    adb(serial, "shell", "svc", "power", "stayon", "usb")
    adb(serial, "shell", "input", "keyevent", "KEYCODE_WAKEUP")
    rows: list[tuple[str, str, str, str]] = [(v, v, "", "") for v in versions]
    rows += [(f"{d} ?{q}", d, q, "") for d, q in (s.split("=", 1) for s in query or [])]
    rows += [
        (f"{v} +{n}", v, "", c)
        for v in versions
        for n, c in (s.split("=", 1) for s in css or [])
    ]
    results: dict[str, list[Result]] = {}
    opts = webdriver.FirefoxOptions()
    opts.enable_mobile(android_package="org.mozilla.firefox", device_serial=serial)
    try:
        with auto_answer(serial):
            driver = webdriver.Firefox(
                options=opts, service=Service(shutil.which("geckodriver"))
            )
        try:
            for r in range(rounds):
                for label, v, q, extra in rows:
                    driver.get(
                        f"http://127.0.0.1:{PORT}/{v}/index.html"
                        + (f"?{q}" if q else "")
                    )
                    if extra:
                        driver.execute_script(INJECT, extra)
                    if "gl" in q.split("&"):
                        WebDriverWait(driver, 30).until(
                            lambda d: d.execute_script(
                                "return document.querySelector('[data-root]')?.dataset.gl === 'on'"
                            )
                        )
                    driver.execute_script("scrollTo(0, 0);")
                    time.sleep(1.5)
                    res = run_sequence(driver, serial, seed + r, width, height)
                    results.setdefault(label, []).append(res)
                    print(f"round {r + 1} {label}: {summarize([res])}", flush=True)
        finally:
            driver.quit()
    finally:
        server.shutdown()
        adb(serial, "reverse", "--remove", f"tcp:{PORT}", check=False)
        if refresh == "120":
            adb(
                serial,
                "shell",
                "settings",
                "delete",
                "system",
                "min_refresh_rate",
                check=False,
            )
            adb(
                serial,
                "shell",
                "settings",
                "delete",
                "system",
                "peak_refresh_rate",
                check=False,
            )
    print(f"\nrefresh {refresh}, {rounds} rounds, seed {seed}")
    for label, rs in results.items():
        print(f"{label:<24} {summarize(rs)}")
    if len(results) > 1:
        print(
            "median fps shown per variant:",
            {
                k: round(statistics.median(r.layer.frames / r.seconds for r in rs), 1)
                for k, rs in results.items()
            },
        )


if __name__ == "__main__":
    typer.run(main)

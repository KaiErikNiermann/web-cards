# /// script
# requires-python = ">=3.12"
# dependencies = ["selenium==4.52.0", "typer==0.20.0"]
# ///
"""Frame rates (mean and 95% floor) of built versions of the card table in Firefox for Android, over USB.

  uv run bench/phone.py SERIAL DIR [DIR ...] [--rounds 2] [--seconds 3]

Each DIR is a built site (vite build output). They are served from this host and reached from
the device through `adb reverse`. For every version and section (page top, Animated row, Stack,
Cardlets) the page is loaded fresh, the section scrolled to the middle of the screen, and
requestAnimationFrame recorded for a few seconds after a 1 s settle; then two touch gestures
(a card dragged along the full-size row, a finger slid along the Stack) are measured while
they run, and `scroll`: the whole page swiped down and back up with real touch input
(`adb shell input swipe`, erratic swipes and flings from phone_scroll.py, seeded per round, the
same for every version). Rounds interleave the versions so heat and drift affect all of them alike. Pin the display's refresh rate first
(`adb shell settings put system min_refresh_rate 120.0` and `peak_refresh_rate 120.0`; undo
with `settings delete system ...`): an adaptive display otherwise drops to 60 Hz on its own.
Firefox's start-up prompts are answered by android_prompts.auto_answer, and the screen is kept
on (stay awake while plugged in) for the run and set back afterwards.
"""

import functools
import http.server
import pathlib
import shutil
import statistics
import subprocess
import threading
import time
from dataclasses import dataclass
from typing import Annotated

import typer
from android_prompts import auto_answer
from phone_scroll import erratic_scroll, screen_size
from selenium import webdriver
from selenium.webdriver.common.actions import interaction
from selenium.webdriver.common.actions.action_builder import ActionBuilder
from selenium.webdriver.common.actions.pointer_input import PointerInput
from selenium.webdriver.common.by import By
from selenium.webdriver.firefox.service import Service
from selenium.webdriver.support.wait import WebDriverWait

PORT = 18766
SECTIONS = {
    "top": None,
    "animated": "a-orbit",
    "stack": "s-live",
    "cardlets": "m-orbit",
    # Only with ?lab: a clock face rewritten every second (snapshotted again under ?gl).
    "lab": "l-clock",
}
# Touch gestures measured while they run: (card to start on, dx, dy) in CSS px, over 1.5 s.
GESTURES: dict[str, tuple[str, int, int, float, float]] = {
    "drag-row": ("qh", 220, 40, 0.5, 0.5),
    "scrub-stack": ("s-live", 120, 0, 0.5, 0.5),
    # Only with ?lab: drag the form card's slider thumb (at 68% across, 54% down the card).
    "slider": ("l-form", -80, 0, 0.68, 0.54),
}
# Showcase scenarios (tap to open, tap to turn): name -> card. The Lab one only with ?lab.
SHOWCASES = {"showcase": "cover", "showcase-lab": "l-note"}
PROBE = """
const [target, seconds] = arguments;
if (target) document.querySelector(`[data-card="${target}"]`)?.scrollIntoView({ block: "center" });
return new Promise((done) => setTimeout(() => {
  const ts = [];
  const t0 = performance.now();
  window.__jsStart = window.__jsNow();
  const loop = (t) => { ts.push(t); if (t - t0 < seconds * 1000) requestAnimationFrame(loop); else done(ts); };
  requestAnimationFrame(loop);
}, 1000)).then((ts) => window.__rates(ts));
"""


START_FRAMES = """
window.__frames = []; window.__on = true; window.__jsStart = window.__jsNow();
const loop = (t) => { if (!window.__on) return; window.__frames.push(t); requestAnimationFrame(loop); };
requestAnimationFrame(loop);
"""
STOP_FRAMES = """
window.__on = false; return window.__rates(window.__frames);
"""
# Mean frame rate and the 95% frame-rate floor (Liu et al. 2023, CHI): the frame time at the
# 95th percentile, as a rate; it tracked perceived quality far better than the mean.
RATES = """
// JS time the page reports for its own frames (main loop + WebGL renderer, with ?gldebug).
window.__jsNow = () => (window.__appTotals?.ms ?? 0) + (window.__glTotals?.ms ?? 0);
window.__rates = (ts) => {
  const gaps = ts.slice(1).map((t, i) => t - ts[i]).sort((a, b) => a - b);
  const p95 = gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * 0.95))];
  const js = (window.__jsNow() - (window.__jsStart ?? 0)) / Math.max(1, ts.length - 1);
  return [(ts.length - 1) / ((ts.at(-1) - ts[0]) / 1000), 1000 / p95, js];
};
"""


@dataclass(frozen=True)
class Rates:
    """Frame rate over a measurement: the mean, and the 95% floor (the slowest 5% of frames)."""

    mean: float
    floor: float
    #: The page's own JS per frame in ms (main loop + WebGL renderer; 0 without ?gldebug).
    js: float = 0.0

    def __str__(self) -> str:
        return f"{self.mean:.0f}/{self.floor:.0f} js {self.js:.2f}ms"


def gesture(
    driver: webdriver.Firefox,
    target: str,
    dx: int,
    dy: int,
    fx: float = 0.5,
    fy: float = 0.5,
) -> Rates:
    """Frame rates during a one-finger drag by (dx, dy) from (fx, fy) of `target`'s box."""
    el = driver.find_element(By.CSS_SELECTOR, f'[data-card="{target}"]')
    driver.execute_script("arguments[0].scrollIntoView({ block: 'center' });", el)
    time.sleep(1)
    # Scroll again if a late layout change (fonts, a row resizing) moved the card off screen,
    # and keep every point of the gesture inside the viewport, which WebDriver requires.
    x, y, vw, vh = driver.execute_script(
        "const r = arguments[0].getBoundingClientRect();"
        "if (r.bottom < 0 || r.top > innerHeight) arguments[0].scrollIntoView({ block: 'center' });"
        "const q = arguments[0].getBoundingClientRect();"
        "return [q.x + q.width * arguments[1], q.y + q.height * arguments[2], innerWidth, innerHeight];",
        el,
        fx,
        fy,
    )

    def inside(px: float, py: float) -> tuple[int, int]:
        return int(min(max(px, 1), vw - 2)), int(min(max(py, 1), vh - 2))

    finger = PointerInput(interaction.POINTER_TOUCH, "finger")
    actions = ActionBuilder(driver, mouse=finger, duration=0)
    actions.pointer_action.move_to_location(*inside(x, y)).pointer_down()
    steps = 30
    for i in range(1, steps + 1):
        actions.pointer_action.pause(0.05).move_to_location(
            *inside(x + dx * i / steps, y + dy * i / steps)
        )
    actions.pointer_action.pointer_up()
    driver.execute_script(START_FRAMES)
    actions.perform()
    mean, floor, js = driver.execute_script(STOP_FRAMES)
    return Rates(float(mean), float(floor), float(js))


def has_card(driver: webdriver.Firefox, card: str) -> bool:
    """Whether the page has `card` (Lab cards exist only with ?lab)."""
    return bool(driver.find_elements(By.CSS_SELECTOR, f'[data-card="{card}"]'))


def showcase(driver: webdriver.Firefox, target: str) -> Rates:
    """Frame rates while `target` opens in the showcase (a tap) and is turned over (a tap)."""
    el = driver.find_element(By.CSS_SELECTOR, f'[data-card="{target}"] .card')
    driver.execute_script("arguments[0].scrollIntoView({ block: 'center' });", el)
    time.sleep(1)
    driver.execute_script(START_FRAMES)
    for _ in range(2):
        x, y = driver.execute_script(
            "const r = arguments[0].getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2];",
            el,
        )
        finger = PointerInput(interaction.POINTER_TOUCH, "finger")
        tap = ActionBuilder(driver, mouse=finger, duration=0)
        tap.pointer_action.move_to_location(int(x), int(y)).pointer_down()
        tap.pointer_action.pause(0.05).pointer_up()
        tap.perform()
        time.sleep(1.4)
    mean, floor, js = driver.execute_script(STOP_FRAMES)
    return Rates(float(mean), float(floor), float(js))


INJECT = "const s = document.createElement('style'); s.textContent = arguments[0]; document.head.append(s);"


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, format: str, *args: object) -> None:
        pass


def main(
    serial: str,
    versions: list[pathlib.Path],
    rounds: Annotated[int, typer.Option()] = 2,
    seconds: Annotated[float, typer.Option()] = 3.0,
    css: Annotated[
        list[str] | None,
        typer.Option(
            help="NAME=CSS, repeatable: also measure each version with CSS injected"
        ),
    ] = None,
    only: Annotated[
        list[str] | None, typer.Option(help="Measure only these sections/gestures")
    ] = None,
    query: Annotated[
        list[str] | None,
        typer.Option(
            help="DIR=QUERY, repeatable: also measure version DIR with ?QUERY (e.g. gl=gl);"
            " ?gl runs wait for the WebGL renderer to take over"
        ),
    ] = None,
) -> None:
    root = versions[0].resolve().parent
    if any(v.resolve().parent != root for v in versions):
        raise typer.BadParameter("all version directories must share one parent")
    server = http.server.ThreadingHTTPServer(
        ("127.0.0.1", PORT), functools.partial(QuietHandler, directory=str(root))
    )
    threading.Thread(target=server.serve_forever, daemon=True).start()
    subprocess.run(
        ["adb", "-s", serial, "reverse", f"tcp:{PORT}", f"tcp:{PORT}"],
        check=True,
        capture_output=True,
    )
    opts = webdriver.FirefoxOptions()
    opts.enable_mobile(android_package="org.mozilla.firefox", device_serial=serial)
    # Keep the screen on while plugged in for the run (a dark screen gets no animation
    # frames), then put the user's setting back.
    stay_on = subprocess.run(
        [
            "adb",
            "-s",
            serial,
            "shell",
            "settings",
            "get",
            "global",
            "stay_on_while_plugged_in",
        ],
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()
    subprocess.run(
        ["adb", "-s", serial, "shell", "svc", "power", "stayon", "usb"], check=True
    )
    subprocess.run(
        ["adb", "-s", serial, "shell", "input", "keyevent", "KEYCODE_WAKEUP"],
        check=True,
    )
    results: dict[tuple[str, str], list[Rates]] = {}
    variants = [("", "")] + [tuple(c.split("=", 1)) for c in css or []]  # type: ignore[misc]
    sections = {k: v for k, v in SECTIONS.items() if not only or k in only}
    gestures = {k: v for k, v in GESTURES.items() if not only or k in only}
    queries = [tuple(q.split("=", 1)) for q in query or []]
    rows = [(v, name, extra, "") for v in versions for name, extra in variants] + [
        (v, f"?{q}", "", q) for d, q in queries for v in versions if v.name == d
    ]
    size = screen_size(serial)
    with auto_answer(serial):
        driver = webdriver.Firefox(
            options=opts, service=Service(shutil.which("geckodriver"))
        )
        try:
            for round_no in range(rounds):
                for v, label, extra, q in rows:
                    key = f"{v.name}{' ' + label if label else ''}"

                    def load(
                        v: pathlib.Path = v, extra: str = extra, q: str = q
                    ) -> None:
                        driver.get(
                            f"http://127.0.0.1:{PORT}/{v.name}/index.html"
                            + (f"?{q}" if q else "")
                        )
                        driver.execute_script(RATES)
                        if extra:
                            driver.execute_script(INJECT, extra)
                        if "gl" in q.split("&"):
                            WebDriverWait(driver, 30).until(
                                lambda d: d.execute_script(
                                    "return document.querySelector('[data-root]')"
                                    "?.dataset.gl === 'on'"
                                )
                            )

                    for section, target in sections.items():
                        load()
                        r = driver.execute_script(PROBE, target, seconds)
                        rates = Rates(float(r[0]), float(r[1]), float(r[2]))
                        results.setdefault((key, section), []).append(rates)
                        print(f"{key} {section}: {rates}", flush=True)
                    for name, card in SHOWCASES.items():
                        if only and name not in only:
                            continue
                        load()
                        if not has_card(driver, card):
                            continue
                        fps = showcase(driver, card)
                        results.setdefault((key, name), []).append(fps)
                        print(f"{key} {name}: {fps}", flush=True)
                    for name, (target, dx, dy, fx, fy) in gestures.items():
                        load()
                        if not has_card(driver, target):
                            continue
                        fps = gesture(driver, target, dx, dy, fx, fy)
                        results.setdefault((key, name), []).append(fps)
                        print(f"{key} {name}: {fps}", flush=True)
                    if not only or "scroll" in only:
                        load()
                        time.sleep(1)
                        driver.execute_script(START_FRAMES)
                        erratic_scroll(driver, serial, 1 + round_no, size, (1, -1))
                        mean, floor, js = driver.execute_script(STOP_FRAMES)
                        fps = Rates(float(mean), float(floor), float(js))
                        results.setdefault((key, "scroll"), []).append(fps)
                        print(f"{key} scroll: {fps}", flush=True)
        finally:
            driver.quit()
            server.shutdown()
            subprocess.run(
                [
                    "adb",
                    "-s",
                    serial,
                    "shell",
                    "settings",
                    "put",
                    "global",
                    "stay_on_while_plugged_in",
                    stay_on or "0",
                ],
                check=False,
            )
    columns = [
        *sections,
        *(n for n in SHOWCASES if not only or n in only),
        *gestures,
        *(["scroll"] if not only or "scroll" in only else []),
    ]
    keys = list(dict.fromkeys(k for k, _ in results))
    width = max(10, *(len(k) for k in keys))
    print(
        "fps per cell: median mean / median 95% floor (the rate of the slowest 5% of frames)"
    )
    print(f"{'version':<{width}}" + "".join(f"{c:>13}" for c in columns))
    for k in keys:
        cells = [
            f"{statistics.median(r.mean for r in results[(k, c)]):>7.0f}/"
            f"{statistics.median(r.floor for r in results[(k, c)]):<5.0f}"
            if (k, c) in results
            else f"{'-':>13}"
            for c in columns
        ]
        print(f"{k:<{width}}" + "".join(cells))


if __name__ == "__main__":
    typer.run(main)

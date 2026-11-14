# /// script
# requires-python = ">=3.12"
# dependencies = ["selenium==4.52.0", "typer==0.20.0"]
# ///
"""Frame rate of built versions of the card table in Firefox for Android, over USB.

  uv run bench/phone.py SERIAL DIR [DIR ...] [--rounds 2] [--seconds 3]

Each DIR is a built site (vite build output). They are served from this host and reached from
the device through `adb reverse`. For every version and section (page top, Animated row, Stack,
Cardlets) the page is loaded fresh, the section scrolled to the middle of the screen, and
requestAnimationFrame recorded for a few seconds after a 1 s settle; then two touch gestures
(a card dragged along the full-size row, a finger slid along the Stack) are measured while
they run. Rounds interleave the
versions so heat and drift affect all of them alike. Pin the display's refresh rate first
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
from typing import Annotated

import typer
from android_prompts import auto_answer
from selenium import webdriver
from selenium.webdriver.common.actions import interaction
from selenium.webdriver.common.actions.action_builder import ActionBuilder
from selenium.webdriver.common.actions.pointer_input import PointerInput
from selenium.webdriver.common.by import By
from selenium.webdriver.firefox.service import Service

PORT = 18766
SECTIONS = {
    "top": None,
    "animated": "a-orbit",
    "stack": "s-live",
    "cardlets": "m-orbit",
}
# Touch gestures measured while they run: (card to start on, dx, dy) in CSS px, over 1.5 s.
GESTURES = {"drag-row": ("qh", 220, 40), "scrub-stack": ("s-live", 120, 0)}
PROBE = """
const [target, seconds] = arguments;
if (target) document.querySelector(`[data-card="${target}"]`)?.scrollIntoView({ block: "center" });
return new Promise((done) => setTimeout(() => {
  const ts = [];
  const t0 = performance.now();
  const loop = (t) => { ts.push(t); if (t - t0 < seconds * 1000) requestAnimationFrame(loop); else done(ts); };
  requestAnimationFrame(loop);
}, 1000)).then((ts) => {
  const gaps = ts.slice(1).map((t, i) => t - ts[i]).sort((a, b) => a - b);
  return { fps: (ts.length - 1) / ((ts.at(-1) - ts[0]) / 1000), p95: gaps[Math.floor(gaps.length * 0.95)] };
});
"""


START_FRAMES = """
window.__frames = []; window.__on = true;
const loop = (t) => { if (!window.__on) return; window.__frames.push(t); requestAnimationFrame(loop); };
requestAnimationFrame(loop);
"""
STOP_FRAMES = """
window.__on = false; const ts = window.__frames;
return (ts.length - 1) / ((ts.at(-1) - ts[0]) / 1000);
"""


def gesture(driver: webdriver.Firefox, target: str, dx: int, dy: int) -> float:
    """Frame rate during a one-finger drag from the centre of `target` by (dx, dy)."""
    el = driver.find_element(By.CSS_SELECTOR, f'[data-card="{target}"]')
    driver.execute_script("arguments[0].scrollIntoView({ block: 'center' });", el)
    time.sleep(1)
    rect = driver.execute_script(
        "const r = arguments[0].getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2];",
        el,
    )
    finger = PointerInput(interaction.POINTER_TOUCH, "finger")
    actions = ActionBuilder(driver, mouse=finger, duration=0)
    actions.pointer_action.move_to_location(int(rect[0]), int(rect[1])).pointer_down()
    steps = 30
    for i in range(1, steps + 1):
        actions.pointer_action.pause(0.05).move_to_location(
            int(rect[0] + dx * i / steps), int(rect[1] + dy * i / steps)
        )
    actions.pointer_action.pointer_up()
    driver.execute_script(START_FRAMES)
    actions.perform()
    return float(driver.execute_script(STOP_FRAMES))


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
    results: dict[tuple[str, str], list[float]] = {}
    variants = [("", "")] + [tuple(c.split("=", 1)) for c in css or []]  # type: ignore[misc]
    sections = {k: v for k, v in SECTIONS.items() if not only or k in only}
    gestures = {k: v for k, v in GESTURES.items() if not only or k in only}
    rows = [(v, name, extra) for v in versions for name, extra in variants]
    with auto_answer(serial):
        driver = webdriver.Firefox(
            options=opts, service=Service(shutil.which("geckodriver"))
        )
        try:
            for _ in range(rounds):
                for v, label, extra in rows:
                    key = f"{v.name}{' ' + label if label else ''}"

                    def load(v: pathlib.Path = v, extra: str = extra) -> None:
                        driver.get(f"http://127.0.0.1:{PORT}/{v.name}/index.html")
                        if extra:
                            driver.execute_script(INJECT, extra)

                    for section, target in sections.items():
                        load()
                        r = driver.execute_script(PROBE, target, seconds)
                        results.setdefault((key, section), []).append(r["fps"])
                    for name, (target, dx, dy) in gestures.items():
                        load()
                        results.setdefault((key, name), []).append(
                            gesture(driver, target, dx, dy)
                        )
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
    columns = [*sections, *gestures]
    keys = list(dict.fromkeys(k for k, _ in results))
    width = max(10, *(len(k) for k in keys))
    print(f"{'version':<{width}}" + "".join(f"{c:>13}" for c in columns))
    for k in keys:
        cells = [statistics.median(results[(k, c)]) for c in columns]
        print(f"{k:<{width}}" + "".join(f"{c:>13.1f}" for c in cells))


typer.run(main)

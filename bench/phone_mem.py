# /// script
# requires-python = ">=3.12"
# dependencies = ["selenium==4.52.0", "typer==0.20.0"]
# ///
"""Memory of the card table in Firefox for Android, per built version, over USB.

  uv run bench/phone_mem.py SERIAL DIR [DIR ...] [--query DIR=QUERY] [--rounds 2]

Each DIR is a built site under --root, served from this host through `adb reverse`. For every
version (and query variant) a fresh tab loads the page; after it settles, Android's
`dumpsys meminfo` is read for every Firefox process: the PSS of the busiest tab process (the
page), the GPU process's "GL mtrack" (textures, canvas and render-target memory the driver
reports) and the PSS of all Firefox processes together. It is read once idle at the top of
the page, and once more after scrolling over the whole page and opening the showcase (a tap
on the first full-size card), so lazily created resources are counted. Pages wait for the
WebGL renderer to take over before measuring, unless the query has `nogl` (the DOM fallback).
"""

import functools
import http.server
import re
import shutil
import statistics
import subprocess
import threading
import time
from dataclasses import dataclass
from typing import Annotated

import typer
from android_prompts import auto_answer
from device import uses_webgl
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.firefox.service import Service
from selenium.webdriver.support.wait import WebDriverWait

PORT = 18768
SETTLE_S = 4.0


@dataclass(frozen=True)
class Memory:
    """Megabytes: the page's tab process, the GPU process's GL memory, all of Firefox."""

    tab: float
    gl: float
    total: float


def adb(serial: str, *args: str) -> str:
    return subprocess.run(
        ["adb", "-s", serial, *args], capture_output=True, text=True, check=True
    ).stdout


def read_memory(serial: str) -> Memory:
    procs = adb(serial, "shell", "ps", "-A", "-o", "PID,NAME")
    tab = gl = total = 0.0
    for line in procs.splitlines():
        if "org.mozilla.firefox" not in line:
            continue
        pid, name = line.split()[:2]
        info = adb(serial, "shell", "dumpsys", "meminfo", pid)
        pss = re.search(r"TOTAL PSS:\s+(\d+)", info)
        mb = int(pss.group(1)) / 1024 if pss else 0.0
        total += mb
        if "tab" in name:
            tab = max(tab, mb)
        if "gpu" in name and (m := re.search(r"^\s*GL mtrack\s+(\d+)", info, re.M)):
            gl = int(m.group(1)) / 1024
    return Memory(tab, gl, total)


def exercise(driver: webdriver.Firefox) -> None:
    """Scrolls over the whole page, back to the top, and opens the showcase."""
    height = driver.execute_script("return document.documentElement.scrollHeight;")
    for y in range(0, int(height), 600):
        driver.execute_script("scrollTo(0, arguments[0]);", y)
        time.sleep(0.25)
    driver.execute_script("scrollTo(0, 0);")
    card = driver.find_element(By.CSS_SELECTOR, '[data-card="qh"] .card')
    driver.execute_script("arguments[0].scrollIntoView({ block: 'center' });", card)
    time.sleep(0.5)
    card.click()
    time.sleep(2.0)


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, format: str, *args: object) -> None:  # noqa: A002
        pass


def main(
    serial: str,
    versions: list[str],
    root: Annotated[str, typer.Option()] = ".scratch/versions",
    query: Annotated[
        list[str] | None, typer.Option(help="DIR=QUERY, repeatable")
    ] = None,
    rounds: Annotated[int, typer.Option()] = 2,
) -> None:
    server = http.server.ThreadingHTTPServer(
        ("127.0.0.1", PORT), functools.partial(QuietHandler, directory=root)
    )
    threading.Thread(target=server.serve_forever, daemon=True).start()
    adb(serial, "reverse", f"tcp:{PORT}", f"tcp:{PORT}")
    adb(serial, "shell", "svc", "power", "stayon", "usb")
    adb(serial, "shell", "input", "keyevent", "KEYCODE_WAKEUP")
    rows = [(v, v, "") for v in versions]
    rows += [(f"{d} ?{q}", d, q) for d, q in (s.split("=", 1) for s in query or [])]
    results: dict[tuple[str, str], list[Memory]] = {}
    opts = webdriver.FirefoxOptions()
    opts.enable_mobile(android_package="org.mozilla.firefox", device_serial=serial)
    try:
        for _ in range(rounds):
            for label, v, q in rows:
                # A fresh browser per measurement, so nothing of the last page is counted.
                with auto_answer(serial):
                    driver = webdriver.Firefox(
                        options=opts, service=Service(shutil.which("geckodriver"))
                    )
                try:
                    driver.get(
                        f"http://127.0.0.1:{PORT}/{v}/index.html"
                        + (f"?{q}" if q else "")
                    )
                    if uses_webgl(q):
                        WebDriverWait(driver, 30).until(
                            lambda d: d.execute_script(
                                "return document.querySelector('[data-root]')"
                                "?.dataset.gl === 'on'"
                            )
                        )
                    time.sleep(SETTLE_S)
                    idle = read_memory(serial)
                    exercise(driver)
                    time.sleep(SETTLE_S)
                    used = read_memory(serial)
                finally:
                    driver.quit()
                results.setdefault((label, "idle"), []).append(idle)
                results.setdefault((label, "used"), []).append(used)
                print(f"{label}: idle {idle}  used {used}", flush=True)
    finally:
        server.shutdown()
        subprocess.run(
            ["adb", "-s", serial, "reverse", "--remove", f"tcp:{PORT}"], check=False
        )
    print(f"\nmedian MB over {rounds} rounds")
    print(f"{'version':<16}{'state':>6}{'tab':>8}{'GPU GL':>9}{'Firefox':>9}")
    for (label, state), ms in results.items():
        tab = statistics.median(m.tab for m in ms)
        gl = statistics.median(m.gl for m in ms)
        total = statistics.median(m.total for m in ms)
        print(f"{label:<16}{state:>6}{tab:8.0f}{gl:9.0f}{total:9.0f}")


typer.run(main)

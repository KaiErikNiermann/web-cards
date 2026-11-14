"""Answers the prompts Firefox for Android shows when geckodriver starts it, during a run.

A background thread reads the on-screen UI with `uiautomator dump` about once a second and taps
a button labelled Continue (or OK) that belongs to Firefox. Android's own permission dialogs
(notifications and the like) get Back instead, which closes them without granting or denying
anything for the user's Firefox. Everything it does is printed, so new prompts are visible.
"""

import re
import subprocess
import threading
from collections.abc import Iterator
from contextlib import contextmanager

FIREFOX = "org.mozilla.firefox"
PRESS = {"continue", "ok"}
NODE = re.compile(
    r'<node [^>]*?text="([^"]*)"[^>]*?package="([^"]*)"[^>]*?bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"'
)


def _adb(serial: str, *args: str) -> str:
    return subprocess.run(
        ["adb", "-s", serial, *args], capture_output=True, text=True, check=False
    ).stdout


def answer_once(serial: str) -> str | None:
    """Handles one prompt if one is showing; returns what it did, or None."""
    _adb(serial, "shell", "uiautomator", "dump", "/sdcard/repro-ui.xml")
    xml = _adb(serial, "shell", "cat", "/sdcard/repro-ui.xml")
    for text, package, x1, y1, x2, y2 in NODE.findall(xml):
        if package.endswith("permissioncontroller"):
            _adb(serial, "shell", "input", "keyevent", "KEYCODE_BACK")
            return f"dismissed a permission dialog ({package})"
        if package == FIREFOX and text.strip().lower() in PRESS:
            x, y = (int(x1) + int(x2)) // 2, (int(y1) + int(y2)) // 2
            _adb(serial, "shell", "input", "tap", str(x), str(y))
            return f"tapped {text!r} at {x},{y}"
    return None


@contextmanager
def auto_answer(serial: str) -> Iterator[None]:
    """Keeps answering prompts until the block exits."""
    stop = threading.Event()

    def loop() -> None:
        while not stop.wait(1.0):
            if done := answer_once(serial):
                print(f"[prompts] {done}", flush=True)

    worker = threading.Thread(target=loop, daemon=True)
    worker.start()
    try:
        yield
    finally:
        stop.set()
        worker.join(timeout=5)

"""Shared plumbing for scripts that drive Firefox for Android over USB.

`serve` serves a directory over HTTP from this host for the length of a `with` block;
`reverse` makes a host port reachable on the device as localhost; `android_firefox` starts a
WebDriver session in Firefox for Android, answering its start-up prompts, and keeps the screen
on while it runs.
"""

import functools
import http.server
import shutil
import subprocess
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from android_prompts import FIREFOX, auto_answer
from selenium import webdriver
from selenium.webdriver.firefox.service import Service


class _Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, format: str, *args: object) -> None:
        pass


@contextmanager
def serve(root: Path, port: int) -> Iterator[str]:
    """Serves `root` on 127.0.0.1:`port`; yields the base URL."""
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", port), functools.partial(_Quiet, directory=str(root)))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        yield f"http://127.0.0.1:{port}"
    finally:
        srv.shutdown()


def adb(serial: str, *args: str, check: bool = True) -> str:
    return subprocess.run(["adb", "-s", serial, *args], capture_output=True, text=True, check=check).stdout


@contextmanager
def reverse(serial: str, port: int) -> Iterator[None]:
    """Forwards the device's localhost:`port` to this host's."""
    adb(serial, "reverse", f"tcp:{port}", f"tcp:{port}")
    try:
        yield
    finally:
        adb(serial, "reverse", "--remove", f"tcp:{port}", check=False)


@contextmanager
def android_firefox(serial: str) -> Iterator[webdriver.Firefox]:
    """A WebDriver session in Firefox for Android, with the screen kept on."""
    stay_on = adb(serial, "shell", "settings", "get", "global", "stay_on_while_plugged_in").strip()
    adb(serial, "shell", "settings", "put", "global", "stay_on_while_plugged_in", "3")
    opts = webdriver.FirefoxOptions()
    opts.enable_mobile(android_package=FIREFOX, device_serial=serial)
    try:
        with auto_answer(serial):
            driver = webdriver.Firefox(options=opts, service=Service(shutil.which("geckodriver")))
        try:
            yield driver
        finally:
            driver.quit()
    finally:
        if stay_on == "null":
            adb(serial, "shell", "settings", "delete", "global", "stay_on_while_plugged_in", check=False)
        else:
            adb(serial, "shell", "settings", "put", "global", "stay_on_while_plugged_in", stay_on, check=False)

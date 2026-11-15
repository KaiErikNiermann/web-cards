# /// script
# requires-python = ">=3.12"
# dependencies = ["selenium==4.52.0", "typer==0.20.0"]
# ///
"""Frame-by-frame trace of erratic scrolling on an Android phone, in Firefox.

  uv run bench/scroll_trace.py SERIAL DIR [--query QUERY ...] [--seed 1] [--wait 2]

DIR is a built site. For every query (default: CSS, ?gl and ?gl&hybrid) the page is loaded in
a fresh Firefox session, given --wait seconds after the WebGL renderer takes over, and swiped
down to the bottom and back up with the core bench's erratic swipes (phone_scroll.py, the same
seed for every query). Every animation frame records its time, the scroll offset and how many
cards WebGL draws in hybrid rendering (`data-gl-hy`). The summary separates frames where the
page scrolled from frames where it did not, and counts long frames (over 20 ms) that coincided
with cards being handed between CSS and WebGL, which phone.py's one mean and floor cannot tell
apart. Traces are written as JSON to --out.

A fresh session per query keeps one page's leftovers (the previous page's GPU memory and
contexts) out of the next one's numbers.
"""

import itertools
import json
import statistics
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Annotated

import typer
from device import android_firefox, reverse, serve
from phone_scroll import erratic_scroll, screen_size

PORT = 18780
#: Records each frame as [time, scrollY, cards drawn by WebGL in hybrid rendering].
RECORD = """
window.__trace = []; window.__tracing = true;
const loop = (t) => {
  if (!window.__tracing) return;
  window.__trace.push([t, scrollY, document.querySelectorAll('.slot[data-gl-hy]').length]);
  requestAnimationFrame(loop);
};
requestAnimationFrame(loop);
"""
STOP = "window.__tracing = false; return window.__trace;"
LONG_MS = 20.0


@dataclass(frozen=True)
class Frame:
    gap: float
    scrolled: bool
    handover: bool


@dataclass(frozen=True)
class Summary:
    fps: float
    floor: float
    scrolling: int
    scrolling_long: int
    still: int
    still_long: int
    handover_long: int

    def __str__(self) -> str:
        return (
            f"{self.fps:5.0f}/{self.floor:<4.0f} fps  scrolling {self.scrolling:4d} frames, {self.scrolling_long:3d} long"
            f"  still {self.still:4d}, {self.still_long:3d} long  long at a handover {self.handover_long:3d}"
        )


def frames(trace: list[list[float]]) -> list[Frame]:
    return [Frame(b[0] - a[0], b[1] != a[1], b[2] != a[2]) for a, b in itertools.pairwise(trace)]


def summarize(trace: list[list[float]]) -> Summary:
    fs = frames(trace)
    gaps = sorted(f.gap for f in fs)
    seconds = (trace[-1][0] - trace[0][0]) / 1000
    scrolling = [f for f in fs if f.scrolled]
    still = [f for f in fs if not f.scrolled]
    return Summary(
        fps=len(fs) / seconds,
        floor=1000 / gaps[min(len(gaps) - 1, int(len(gaps) * 0.95))],
        scrolling=len(scrolling),
        scrolling_long=sum(f.gap > LONG_MS for f in scrolling),
        still=len(still),
        still_long=sum(f.gap > LONG_MS for f in still),
        handover_long=sum(f.gap > LONG_MS and f.handover for f in fs),
    )


def trace_one(serial: str, base: str, query: str, seed: int, wait: float) -> list[list[float]]:
    with android_firefox(serial) as d:
        d.get(f"{base}/index.html{query}")
        if "gl" in query.lstrip("?").split("&"):
            for _ in range(300):
                if d.execute_script("return document.querySelector('[data-root]')?.dataset.gl") == "on":
                    break
                time.sleep(0.1)
        time.sleep(wait)
        d.execute_script(RECORD)
        erratic_scroll(d, serial, seed, screen_size(serial), (1, -1))
        trace = d.execute_script(STOP)
    assert isinstance(trace, list)
    return trace


def main(
    serial: Annotated[str, typer.Argument(help="adb serial of the phone")],
    dist: Annotated[Path, typer.Argument(help="built site")],
    query: Annotated[list[str] | None, typer.Option(help='page query, repeatable ("" for CSS)')] = None,
    seed: Annotated[int, typer.Option(help="swipe sequence seed")] = 1,
    rounds: Annotated[int, typer.Option(help="traces per query, interleaved")] = 1,
    wait: Annotated[float, typer.Option(help="seconds after start-up before scrolling")] = 2.0,
    out: Annotated[Path, typer.Option()] = Path(".scratch/scroll-trace"),
) -> None:
    """Trace erratic scrolling frame by frame on the phone, per query."""
    queries = query or ["", "?gl", "?gl&hybrid"]
    out.mkdir(parents=True, exist_ok=True)
    results: dict[str, list[Summary]] = {}
    with serve(dist, PORT) as base, reverse(serial, PORT):
        for r in range(rounds):
            for q in queries:
                trace = trace_one(serial, base, q, seed + r, wait)
                name = q.lstrip("?") or "css"
                (out / f"{name.replace('&', '+')}-{r}.json").write_text(json.dumps(trace), encoding="utf-8")
                s = summarize(trace)
                results.setdefault(name, []).append(s)
                print(f"{name:<16} round {r}: {s}", flush=True)
    if rounds > 1:
        for name, ss in results.items():
            print(
                f"{name:<16} median {statistics.median(s.fps for s in ss):5.0f}/"
                f"{statistics.median(s.floor for s in ss):<4.0f} fps"
            )


if __name__ == "__main__":
    typer.run(main)

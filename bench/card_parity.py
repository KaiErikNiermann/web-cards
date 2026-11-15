# /// script
# requires-python = ">=3.12"
# dependencies = ["selenium==4.52.0", "playwright==1.65.1", "pillow==12.0.0", "numpy==2.3.5", "typer==0.20.0"]
# ///
"""Card parity: whole cards on the table as each renderer draws them, on one phone.

  uv run bench/card_parity.py dist --serial SERIAL [--only ID,ID] [--freeze 1.5]

DIR is a built site. Every card of the page (the Lab included) is screenshotted, its slot box
on the page, by three renderers:

- css: Firefox, `?gl&hybrid`, where every card at rest draws in CSS;
- gl-ff: Firefox, `?gl`, snapshot faces drawn by the WebGL shader;
- gl-chrome: Chrome, `?gl`, HTML-in-Canvas faces drawn by the same shader.

Effects are held at one time: `?glfreeze` fixes the WebGL clock, and every CSS animation is
paused at the same time before each screenshot. Each pair is scored with parity.py's metric
(wrong pixels with a 1 px tolerance after the best whole-pixel shift, and the mean difference),
and report.html shows the three renders and the wrong pixels of each pair, worst cards first.
Unlike parity.py, which compares faces alone, this covers material layers, lighting, effects,
corners and the shader's sampling.
"""

import html
import json
import time
from contextlib import ExitStack
from dataclasses import dataclass
from pathlib import Path
from typing import Annotated, Literal

import numpy as np
import typer
from device import serve
from numpy.typing import NDArray
from parity import PORT, Browser, Target, browser, heat, rgb, shifted, wrong_pixels
from PIL import Image

Renderer = Literal["css", "gl-ff", "gl-chrome"]
RENDERERS: dict[Renderer, tuple[Target, str]] = {
    "css": (Target.PHONE, "?gl&hybrid&lab"),
    "gl-ff": (Target.PHONE, "?gl&lab&glsrc=snapshot&glfreeze={t}"),
    "gl-chrome": (Target.PHONE_CHROME, "?gl&lab&glfreeze={t}"),
}
PAIRS: tuple[tuple[Renderer, Renderer], ...] = (("css", "gl-ff"), ("gl-ff", "gl-chrome"), ("css", "gl-chrome"))
FREEZE_JS = "(() => {{ for (const a of document.getAnimations()) {{ a.pause(); a.currentTime = {ms}; }} return 0; }})()"


@dataclass(frozen=True)
class PairScore:
    card: str
    a: Renderer
    b: Renderer
    wrong_pct: float
    mean_diff: float


def wait_ready(b: Browser, query: str) -> None:
    """Waits until the WebGL renderer has taken over (every renderer here runs under `?gl`)."""
    for _ in range(300):
        match b.js("document.querySelector('[data-root]')?.dataset.gl ?? ''"):
            case "on":
                return
            case "failed":
                raise RuntimeError(f"WebGL failed to start for {query}")
            case _:
                time.sleep(0.1)
    raise RuntimeError(f"WebGL did not start for {query}")


def capture(b: Browser, base: str, query: str, freeze: float, only: set[str] | None, out: Path) -> list[str]:
    b.goto(f"{base}/index.html{query}")
    wait_ready(b, query)
    ids = b.js("[...document.querySelectorAll('[data-card]')].map((e) => e.dataset.card)")
    assert isinstance(ids, list)
    cards = [str(i) for i in ids if only is None or str(i) in only]
    for card in cards:
        sel = f'[data-card="{card}"]'
        b.js(f"(() => {{ document.querySelector('{sel}').scrollIntoView({{ block: 'center' }}); return 0; }})()")
        # Off-screen cards hold their effects still; once shown they run again, then freeze.
        time.sleep(0.6)
        b.js(FREEZE_JS.format(ms=freeze * 1000))
        time.sleep(0.3)
        (out / f"{card}.png").write_bytes(b.shot_of(sel))
    return cards


def score(card: str, a: Renderer, b: Renderer, imgs: dict[Renderer, NDArray[np.uint8]], out: Path) -> PairScore:
    ref = imgs[a]
    other = np.asarray(
        Image.fromarray(imgs[b]).resize((ref.shape[1], ref.shape[0]), Image.Resampling.LANCZOS), dtype=np.uint8
    )
    mask, mean, shift = wrong_pixels(ref, other)
    heat(ref, mask).save(out / f"{card}-{a}-vs-{b}.png")
    Image.fromarray(shifted(other.astype(np.int16), *shift).astype(np.uint8)).save(out / f"{card}-{b}-on-{a}.png")
    return PairScore(card, a, b, float(mask.mean() * 100), mean)


def report(scores: list[PairScore], cards: list[str], out: Path) -> None:
    by_card = {c: [s for s in scores if s.card == c] for c in cards}
    order = sorted(cards, key=lambda c: -max((s.wrong_pct for s in by_card[c]), default=0))
    head = "".join(f"<th>{a} vs {b}</th>" for a, b in PAIRS)
    rows = []
    for c in order:
        cells = "".join(
            f'<td>{s.wrong_pct:.2f}% / {s.mean_diff:.1f}<img src="{html.escape(c)}-{s.a}-vs-{s.b}.png" alt="wrong pixels"></td>'
            for s in by_card[c]
        )
        renders = "".join(f'<td><img src="{r}/{html.escape(c)}.png" alt="{r}"></td>' for r in RENDERERS)
        rows.append(f"<tr><td><b>{html.escape(c)}</b></td>{renders}{cells}</tr>")
    (out / "report.html").write_text(
        f"""<!doctype html><meta charset="utf-8"><title>Card parity</title>
<style>body{{font:13px system-ui,sans-serif;background:#f4f4f4;color:#111;margin:16px}}
td{{vertical-align:top;padding:6px}}img{{max-width:200px;height:auto;display:block}}th{{text-align:start}}</style>
<h1>Card parity</h1><p>Cells: wrong pixels / mean difference, wrong pixels of the first renderer in red.</p>
<table><tr><th>card</th>{"".join(f"<th>{r}</th>" for r in RENDERERS)}{head}</tr>{"".join(rows)}</table>""",
        encoding="utf-8",
    )


def main(
    dist: Annotated[Path, typer.Argument(help="built site")],
    serial: Annotated[str, typer.Option(help="adb serial of the phone")],
    freeze: Annotated[float, typer.Option(help="effect time in seconds for every renderer")] = 1.5,
    only: Annotated[str | None, typer.Option(help="comma-separated card ids")] = None,
    out: Annotated[Path, typer.Option()] = Path(".scratch/card-parity"),
) -> None:
    """Screenshot every card in three renderers on the phone and compare them pairwise."""
    wanted = set(only.split(",")) if only else None
    cards: list[str] = []
    with serve(dist, PORT) as base:
        for name, (target, query) in RENDERERS.items():
            (out / name).mkdir(parents=True, exist_ok=True)
            with ExitStack() as stack:
                b = stack.enter_context(browser(target, serial, 1.0))
                cards = capture(b, base, query.format(t=freeze), freeze, wanted, out / name)
            print(f"{name}: {len(cards)} cards", flush=True)
    scores: list[PairScore] = []
    for card in cards:
        imgs: dict[Renderer, NDArray[np.uint8]] = {r: rgb((out / r / f"{card}.png").read_bytes()) for r in RENDERERS}
        for a, b in PAIRS:
            s = score(card, a, b, imgs, out)
            scores.append(s)
        print(
            "  ".join(f"{s.a}~{s.b} {s.wrong_pct:5.2f}%/{s.mean_diff:4.1f}" for s in scores[-len(PAIRS) :]),
            card,
            flush=True,
        )
    report(scores, cards, out)
    (out / "results.json").write_text(json.dumps([s.__dict__ for s in scores], indent=1), encoding="utf-8")
    print(f"report: {out / 'report.html'}")


if __name__ == "__main__":
    typer.run(main)

"""Build the header brand mark from the supplied AquaNexus logo image.

Crops the circular emblem out of the reference screenshot, floods the outer
white background to transparency (interior whites are kept so the logo keeps
its highlight detail), trims to the visible pixels and downsamples for the
header. Result: tools/brand/aquanexus-mark.png + a base64 data URI text file.
"""
from __future__ import annotations

import base64
import pathlib
from collections import deque

from PIL import Image

HERE = pathlib.Path(__file__).resolve().parent
SOURCE = pathlib.Path(
    r"C:\Users\ARNAV\AppData\Local\Temp\freebuff-desktop-pastes\paste-1792871650083-12600.png"
)
CROP = (265, 45, 605, 350)  # circular emblem inside the reference screenshot
TOLERANCE = 26  # how far from "background white" still counts as background
TARGET_HEIGHT = 132  # generous for a ~44px header mark on 2x displays


def main() -> None:
    img = Image.open(SOURCE).convert("RGB").crop(CROP)
    w, h = img.size
    px = img.load()
    bg = px[w // 2, 2]  # white just inside the card, above the emblem

    def is_bg(x: int, y: int) -> bool:
        r, g, b = px[x, y]
        return (
            abs(r - bg[0]) <= TOLERANCE
            and abs(g - bg[1]) <= TOLERANCE
            and abs(b - bg[2]) <= TOLERANCE
        )

    outside = bytearray(w * h)
    queue: deque[tuple[int, int]] = deque()
    for x in range(w):
        for y in (0, h - 1):
            if is_bg(x, y) and not outside[y * w + x]:
                outside[y * w + x] = 1
                queue.append((x, y))
    for y in range(h):
        for x in (0, w - 1):
            if is_bg(x, y) and not outside[y * w + x]:
                outside[y * w + x] = 1
                queue.append((x, y))

    while queue:
        x, y = queue.popleft()
        for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
            if 0 <= nx < w and 0 <= ny < h and not outside[ny * w + nx] and is_bg(nx, ny):
                outside[ny * w + nx] = 1
                queue.append((nx, ny))

    out = img.convert("RGBA")
    op = out.load()
    for y in range(h):
        for x in range(w):
            if outside[y * w + x]:
                op[x, y] = (255, 255, 255, 0)

    box = out.getbbox()
    assert box, "no visible pixels after keying the background"
    out = out.crop(box)

    scale = TARGET_HEIGHT / out.height
    width = max(1, round(out.width * scale))
    out = out.resize((width, TARGET_HEIGHT), Image.LANCZOS)

    target = HERE / "aquanexus-mark.png"
    out.save(target, optimize=True)
    data = base64.b64encode(target.read_bytes()).decode("ascii")
    (HERE / "aquanexus-mark.b64").write_text(data, encoding="utf-8")
    print("mark:", out.size, target.stat().st_size, "bytes; base64", len(data), "chars")


if __name__ == "__main__":
    main()

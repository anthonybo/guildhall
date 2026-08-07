#!/usr/bin/env python3
"""Render ANSI-coloured terminal output as a self-contained SVG.

    guildhall --demo --once | python3 tools/ansi-to-svg.py -o docs/room.svg

Why SVG rather than a screenshot:
  * crisp at any zoom, and a few KB instead of a few hundred
  * regenerable by anyone with no image tooling installed, so the picture in the
    README cannot drift away from what the program actually prints
  * no window chrome, no font the reader does not have, no retina/non-retina
    difference between contributors

The room is drawn with half-block characters, so a cell carries a foreground AND a
background colour — every pixel of the office is a coloured rectangle plus a U+2580.
That is why background handling matters here more than it does for a status line.

Adapted from the same tool in `foxglove`, with truecolor (38;2;R;G;B) added:
guildhall picks its colours against measured contrast ratios rather than from the
xterm cube, so 256-colour parsing alone rendered the whole room grey.
"""

import argparse
import re
import sys

CW = 8.4          # advance width of one cell at FONT_SIZE
LH = 22.0         # line height
FONT_SIZE = 14
PAD = 14.0
BG = "#282634"    # the office floor colour, so the page matches the room
FG_DEFAULT = "#CCCCCC"

CAP_LEFT = ""
CAP_RIGHT = ""
SGR = re.compile(r"\x1b\[([0-9;]*)m")


def xterm(n: int) -> str:
    if n < 16:
        base = [(0, 0, 0), (128, 0, 0), (0, 128, 0), (128, 128, 0), (0, 0, 128),
                (128, 0, 128), (0, 128, 128), (192, 192, 192), (128, 128, 128),
                (255, 0, 0), (0, 255, 0), (255, 255, 0), (0, 0, 255),
                (255, 0, 255), (0, 255, 255), (255, 255, 255)]
        r, g, b = base[n]
    elif n < 232:
        i = n - 16
        lv = [0, 95, 135, 175, 215, 255]
        r, g, b = lv[i // 36], lv[(i % 36) // 6], lv[i % 6]
    else:
        v = 8 + (n - 232) * 10
        r = g = b = v
    return f"#{r:02X}{g:02X}{b:02X}"


def parse(line: str):
    """-> list of (char, fg, bg, bold) with escapes consumed."""
    cells = []
    fg, bg, bold = FG_DEFAULT, None, False
    i = 0
    while i < len(line):
        m = SGR.match(line, i)
        if m:
            params = [p for p in m.group(1).split(";") if p != ""] or ["0"]
            j = 0
            while j < len(params):
                p = int(params[j])
                if p == 0:
                    fg, bg, bold = FG_DEFAULT, None, False
                elif p == 1:
                    bold = True
                elif p == 22:
                    bold = False
                elif p == 30:
                    fg = "#000000"
                elif p == 39:
                    fg = FG_DEFAULT
                elif p == 49:
                    bg = None
                elif p in (38, 48) and j + 4 < len(params) and params[j + 1] == "2":
                    # truecolor: guildhall emits 38;2;R;G;B throughout, since the
                    # palette is chosen against measured contrast ratios rather
                    # than picked from the xterm cube
                    r, g, b = (int(params[j + 2]), int(params[j + 3]), int(params[j + 4]))
                    col = f"#{r:02X}{g:02X}{b:02X}"
                    if p == 38:
                        fg = col
                    else:
                        bg = col
                    j += 4
                elif p in (38, 48) and j + 2 < len(params) and params[j + 1] == "5":
                    col = xterm(int(params[j + 2]))
                    if p == 38:
                        fg = col
                    else:
                        bg = col
                    j += 2
                j += 1
            i = m.end()
            continue
        cells.append((line[i], fg, bg, bold))
        i += 1
    return cells


def esc(s: str) -> str:
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def row(cells, top: float) -> list:
    """One line of cells, drawn with its top edge at `top`."""
    cols = len(cells)
    out = []
    baseline = top + LH * 0.72

    # 1. background runs first, so glyphs sit on top of them
    x = 0
    while x < cols:
        bg = cells[x][2]
        if bg is None:
            x += 1
            continue
        run = x
        while run < cols and cells[run][2] == bg:
            run += 1
        out.append(
            f'<rect x="{PAD + x * CW:.2f}" y="{top:.2f}" width="{(run - x) * CW:.2f}" '
            f'height="{LH:.2f}" fill="{bg}"/>'
        )
        x = run

    # 2. the powerline caps as drawn shapes, so no Nerd Font is needed
    for idx, (ch, fg, _bg, _bold) in enumerate(cells):
        if ch not in (CAP_LEFT, CAP_RIGHT):
            continue
        cx = PAD + idx * CW
        r = LH / 2
        if ch == CAP_LEFT:
            out.append(
                f'<path d="M{cx + CW:.2f},{top:.2f} L{cx + CW:.2f},{top + LH:.2f} '
                f'A{r:.2f},{r:.2f} 0 0 1 {cx + CW:.2f},{top:.2f} Z" fill="{fg}"/>'
            )
        else:
            out.append(
                f'<path d="M{cx:.2f},{top:.2f} L{cx:.2f},{top + LH:.2f} '
                f'A{r:.2f},{r:.2f} 0 0 0 {cx:.2f},{top:.2f} Z" fill="{fg}"/>'
            )

    # 3. text, grouped into runs sharing colour and weight
    x = 0
    while x < cols:
        ch, fg, _bg, bold = cells[x]
        if ch in (CAP_LEFT, CAP_RIGHT):
            x += 1
            continue
        run = x
        text = []
        while run < cols:
            c2, f2, _b2, bd2 = cells[run]
            if f2 != fg or bd2 != bold or c2 in (CAP_LEFT, CAP_RIGHT):
                break
            text.append(c2)
            run += 1
        s = "".join(text)
        if s.strip():
            w = 'font-weight="700" ' if bold else ""
            out.append(
                f'<text x="{PAD + x * CW:.2f}" y="{baseline:.2f}" fill="{fg}" {w}'
                f'xml:space="preserve">{esc(s)}</text>'
            )
        x = max(run, x + 1)
    return out


def render(rows, title=None) -> str:
    # The caption can be longer than the rendered line (a short bar with a long model
    # id, say). Sizing the panel from the line alone clipped the caption.
    span = max([len(r) for r in rows] + [len(title) if title else 0])
    width = span * CW + PAD * 2
    top = PAD + (LH if title else 0)
    height = top + LH * len(rows) + PAD
    out = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width:.0f}" height="{height:.0f}" '
        f'viewBox="0 0 {width:.0f} {height:.0f}" font-family="ui-monospace, SFMono-Regular, '
        f'Menlo, Consolas, monospace" font-size="{FONT_SIZE}">',
        f'<rect width="100%" height="100%" rx="6" fill="{BG}"/>',
    ]
    if title:
        out.append(
            f'<text x="{PAD:.1f}" y="{PAD + LH * 0.7:.1f}" fill="#7A8288" '
            f'font-size="{FONT_SIZE - 2}">{esc(title)}</text>'
        )

    for i, cells in enumerate(rows):
        out += row(cells, top + LH * i)

    out.append("</svg>")
    return "\n".join(out)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("-o", "--out", help="write here instead of stdout")
    ap.add_argument("-t", "--title", help="small caption drawn above the line")
    a = ap.parse_args()

    lines = [l.rstrip() for l in sys.stdin.read().split("\n")]
    while lines and not lines[-1]:
        lines.pop()
    if not lines:
        print("no input on stdin", file=sys.stderr)
        return 1
    svg = render([parse(l) for l in lines], a.title)
    if a.out:
        with open(a.out, "w", encoding="utf-8") as fh:
            fh.write(svg + "\n")
        print(f"wrote {a.out} ({len(svg)} bytes)", file=sys.stderr)
    else:
        print(svg)
    return 0


if __name__ == "__main__":
    sys.exit(main())

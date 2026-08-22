#!/usr/bin/env python3
"""
Draws the widget picker previews.

App Store guideline 1.10 asks for "a simplified representation" built from
simple shapes on a transparent background, with no text and nothing resembling
a screenshot. So these are deliberately abstract: the silhouette of each layout
rather than its contents. Bars stand in for readings, and the only literal
element is the exchanger itself, because that shape is what distinguishes this
widget from every other one in the picker.

    python3 tools/make_widget_preview.py
"""

from PIL import Image, ImageDraw
import math
import os

SIZE = 1024
SS = 3  # supersample; the diagonals alias badly at final size otherwise
ROOT = os.path.join(os.path.dirname(__file__), '..', 'widgets')

# The air colours carry the widget's identity, so they stay in the preview.
COLD = (63, 150, 216)
WARM = (231, 154, 69)
BLUE = (43, 142, 222)

THEMES = {
    'light': dict(card=(255, 255, 255), tile=(233, 238, 243),
                  bar=(203, 213, 223), dim=(224, 230, 236)),
    'dark': dict(card=(30, 36, 44), tile=(44, 52, 62),
                 bar=(78, 90, 104), dim=(52, 61, 72)),
}


def mix(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def bar(d, x, y, w, h, colour, radius=None):
    d.rounded_rectangle([x, y, x + w, y + h], radius=radius or h / 2, fill=colour)


def tile(d, box, th, bars=(0.5, 0.75)):
    """A card with two abstract bars where a label and value would sit."""
    d.rounded_rectangle(box, radius=20 * SS, fill=th['tile'])
    x, y, w = box[0] + 22 * SS, box[1] + 22 * SS, box[2] - box[0]
    bar(d, x, y, (w - 44 * SS) * bars[0], 9 * SS, th['bar'])
    bar(d, x, y + 24 * SS, (w - 44 * SS) * bars[1], 15 * SS, th['dim'])


def bezier(p0, p1, p2, p3, steps=140):
    out = []
    for i in range(steps + 1):
        t = i / steps
        u = 1 - t
        out.append((u**3 * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t**3 * p3[0],
                    u**3 * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t**3 * p3[1]))
    return out


def stream(img, pts, c_from, c_to, width):
    d = ImageDraw.Draw(img)
    for i in range(len(pts) - 1):
        colour = mix(c_from, c_to, i / max(1, len(pts) - 2))
        d.line([pts[i], pts[i + 1]], fill=colour, width=width)
        r = width / 2
        d.ellipse([pts[i][0] - r, pts[i][1] - r, pts[i][0] + r, pts[i][1] + r], fill=colour)


def canvas():
    return Image.new('RGBA', (SIZE * SS, SIZE * SS), (0, 0, 0, 0))


def finish(img):
    return img.resize((SIZE, SIZE), Image.LANCZOS)


def draw_status(theme):
    """The detailed widget: two streams crossing through the exchanger."""
    th = THEMES[theme]
    img = canvas()
    d = ImageDraw.Draw(img)

    cw, ch = 760 * SS, 640 * SS
    cx, cy = (SIZE * SS - cw) // 2, (SIZE * SS - ch) // 2
    d.rounded_rectangle([cx, cy, cx + cw, cy + ch], radius=44 * SS, fill=th['card'])

    pad = 46 * SS
    x0, x1 = cx + pad, cx + cw - pad

    # Header: a name bar and a mode pill.
    bar(d, x0, cy + pad, 200 * SS, 20 * SS, th['bar'])
    bar(d, x1 - 130 * SS, cy + pad - 4 * SS, 130 * SS, 30 * SS, mix(th['card'], BLUE, .22), radius=10 * SS)

    ex_top = cy + pad + 62 * SS
    ex_h = 300 * SS
    mid_x, mid_y = cx + cw / 2, ex_top + ex_h / 2
    left, right = x0 + 120 * SS, x1 - 120 * SS
    top, bottom = ex_top + 46 * SS, ex_top + ex_h - 46 * SS

    stream(img, bezier((left, top), (left + 150 * SS, top),
                       (right - 150 * SS, bottom), (right, bottom)), WARM, COLD, 16 * SS)
    stream(img, bezier((right, top), (right - 150 * SS, top),
                       (left + 150 * SS, bottom), (left, bottom)), COLD, WARM, 16 * SS)

    d = ImageDraw.Draw(img)
    r = 78 * SS
    d.polygon([(mid_x, mid_y - r), (mid_x + r, mid_y), (mid_x, mid_y + r), (mid_x - r, mid_y)],
              fill=th['card'])
    d.polygon([(mid_x, mid_y - r + 20 * SS), (mid_x + r - 20 * SS, mid_y),
               (mid_x, mid_y + r - 20 * SS), (mid_x - r + 20 * SS, mid_y)], fill=th['tile'])

    # Four corner readings, reduced to paired bars.
    for x, y, right_align in ((x0, ex_top, False), (x1, ex_top, True),
                              (x0, ex_top + ex_h - 54 * SS, False),
                              (x1, ex_top + ex_h - 54 * SS, True)):
        for w, h, dy, colour in ((70 * SS, 9 * SS, 0, th['bar']),
                                 (108 * SS, 20 * SS, 20 * SS, th['dim'])):
            bar(d, x - w if right_align else x, y + dy, w, h, colour)

    # Tile row, then the level buttons.
    ty = ex_top + ex_h + 22 * SS
    gap = 12 * SS
    tw = (x1 - x0 - gap * 2) / 3
    for i in range(3):
        tile(d, [x0 + i * (tw + gap), ty, x0 + i * (tw + gap) + tw, ty + 84 * SS], th)

    by = ty + 106 * SS
    n, bgap = 5, 10 * SS
    bw = (x1 - x0 - bgap * (n - 1)) / n
    for i in range(n):
        bx = x0 + i * (bw + bgap)
        d.rounded_rectangle([bx, by, bx + bw, by + 52 * SS], radius=14 * SS,
                            fill=mix(th['card'], BLUE, .3) if i == 3 else th['tile'])

    return finish(img)


def draw_compact(theme):
    """The small widget: one dial, four readings, the levels."""
    th = THEMES[theme]
    img = canvas()
    d = ImageDraw.Draw(img)

    cw, ch = 760 * SS, 400 * SS
    cx, cy = (SIZE * SS - cw) // 2, (SIZE * SS - ch) // 2
    d.rounded_rectangle([cx, cy, cx + cw, cy + ch], radius=44 * SS, fill=th['card'])

    pad = 46 * SS
    x0, x1 = cx + pad, cx + cw - pad

    bar(d, x0, cy + pad, 200 * SS, 20 * SS, th['bar'])
    bar(d, x1 - 130 * SS, cy + pad - 4 * SS, 130 * SS, 30 * SS, mix(th['card'], BLUE, .22), radius=10 * SS)

    # Dial: three quarters of a ring, filled to roughly four fifths.
    dr, dw = 92 * SS, 20 * SS
    dcx, dcy = x0 + dr + 6 * SS, cy + pad + 52 * SS + dr
    box = [dcx - dr, dcy - dr, dcx + dr, dcy + dr]
    d.arc(box, start=135, end=45, fill=th['tile'], width=dw)
    d.arc(box, start=135, end=135 + 270 * 0.8, fill=BLUE, width=dw)
    bar(d, dcx - 46 * SS, dcy - 16 * SS, 92 * SS, 30 * SS, th['dim'], radius=10 * SS)

    tx0 = dcx + dr + 34 * SS
    gap = 12 * SS
    tw = (x1 - tx0 - gap) / 2
    for i in range(4):
        bx = tx0 + (i % 2) * (tw + gap)
        by = dcy - 92 * SS + (i // 2) * 96 * SS
        tile(d, [bx, by, bx + tw, by + 84 * SS], th)

    by = cy + ch - pad - 52 * SS
    n, bgap = 5, 10 * SS
    bw = (x1 - x0 - bgap * (n - 1)) / n
    for i in range(n):
        bx = x0 + i * (bw + bgap)
        d.rounded_rectangle([bx, by, bx + bw, by + 52 * SS], radius=14 * SS,
                            fill=mix(th['card'], BLUE, .3) if i == 3 else th['tile'])

    return finish(img)


if __name__ == '__main__':
    for widget, draw in (('status', draw_status), ('compact', draw_compact)):
        for theme in ('light', 'dark'):
            path = os.path.join(ROOT, widget, f'preview-{theme}.png')
            draw(theme).save(path, 'PNG', optimize=True)
            print(f'{widget}/preview-{theme}.png -> {os.path.getsize(path) // 1024} KB')

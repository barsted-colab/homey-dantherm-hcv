#!/usr/bin/env python3
"""
Draws the widget picker previews: a mock of each widget in light and dark.

These are illustrations of the real layouts, not screenshots — a widget needs a
paired unit to render, and the previews must exist before it can be installed.
Keep them in step with the two public/index.html files when a layout changes.

    python3 tools/make_widget_preview.py
"""

from PIL import Image, ImageDraw, ImageFont
import math
import os

SIZE = 1024
ROOT = os.path.join(os.path.dirname(__file__), '..', 'widgets')

# Air colours are identical in both themes on purpose: a temperature must not
# change meaning when the dashboard goes dark.
COLD = (63, 150, 216)
COOL = (116, 184, 228)
TEPID = (147, 162, 176)
WARM = (231, 154, 69)
HOT = (221, 101, 53)
BLUE = (43, 142, 222)

THEMES = {
    'light': dict(page=(238, 241, 244), card=(255, 255, 255), text=(22, 25, 29),
                  muted=(122, 130, 141), tile=(242, 245, 248), line=(224, 229, 234),
                  core=(255, 255, 255)),
    'dark': dict(page=(13, 16, 20), card=(23, 28, 35), text=(238, 242, 246),
                 muted=(141, 151, 163), tile=(30, 36, 44), line=(42, 50, 59),
                 core=(23, 28, 35)),
}

FONTS = ['/System/Library/Fonts/Supplemental/Arial.ttf',
         '/System/Library/Fonts/Helvetica.ttc',
         '/Library/Fonts/Arial.ttf']


def font(size, bold=False):
    for path in FONTS:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size, index=1 if bold and path.endswith('.ttc') else 0)
            except OSError:
                continue
    return ImageFont.load_default()


def colour_for(c):
    for limit, colour in ((0, COLD), (12, COOL), (19, TEPID), (24, WARM)):
        if c <= limit:
            return colour
    return HOT


def mix(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def tile(d, box, th, label, value, unit, f_k, f_v, f_u, value_colour=None):
    d.rounded_rectangle(box, radius=9, fill=th['tile'], outline=th['line'], width=1)
    x, y = box[0] + 13, box[1] + 9
    d.text((x, y), label.upper(), font=f_k, fill=th['muted'])
    d.text((x, y + 20), value, font=f_v, fill=value_colour or th['text'])
    if unit:
        w = d.textlength(value, font=f_v)
        d.text((x + w + 6, y + 28), unit, font=f_u, fill=th['muted'])


def header(d, th, x0, x1, y, title, chip):
    d.text((x0, y), title, font=font(26, bold=True), fill=th['text'])
    f = font(20)
    w = d.textlength(chip, font=f)
    d.rounded_rectangle([x1 - w - 26, y - 5, x1, y + 31], radius=8,
                        fill=mix(th['card'], BLUE, .16), outline=mix(th['card'], BLUE, .4), width=1)
    d.text((x1 - w - 13, y + 1), chip, font=f, fill=BLUE)


def levels(d, th, x0, x1, y, active, height=46):
    n, gap = 5, 7
    w = (x1 - x0 - gap * (n - 1)) / n
    f = font(21)
    for i in range(n):
        bx = x0 + i * (w + gap)
        on = i == active
        d.rounded_rectangle([bx, y, bx + w, y + height], radius=9,
                            fill=mix(th['card'], BLUE, .18) if on else th['card'],
                            outline=BLUE if on else th['line'], width=2 if on else 1)
        label = str(i)
        lw = d.textlength(label, font=f)
        d.text((bx + (w - lw) / 2, y + height / 2 - 13), label, font=f,
               fill=BLUE if on else th['muted'])


# --- status widget -----------------------------------------------------------

def bezier(p0, p1, p2, p3, steps=90):
    pts = []
    for i in range(steps + 1):
        t = i / steps
        u = 1 - t
        pts.append((u**3 * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t**3 * p3[0],
                    u**3 * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t**3 * p3[1]))
    return pts


def gradient_path(img, pts, c_from, c_to, width):
    """Draws a polyline whose colour shifts along its length."""
    d = ImageDraw.Draw(img)
    for i in range(len(pts) - 1):
        t = i / max(1, len(pts) - 2)
        colour = mix(c_from, c_to, t)
        d.line([pts[i], pts[i + 1]], fill=colour, width=width)
        d.ellipse([pts[i][0] - width / 2, pts[i][1] - width / 2,
                   pts[i][0] + width / 2, pts[i][1] + width / 2], fill=colour)


def arrow(d, tip, direction, colour, size=15):
    ang = math.atan2(direction[1], direction[0])
    pts = [(tip[0], tip[1])]
    for offset in (2.5, -2.5):
        pts.append((tip[0] - size * math.cos(ang - offset * 0.32),
                    tip[1] - size * math.sin(ang - offset * 0.32)))
    d.polygon(pts, fill=colour)


def draw_status(theme):
    th = THEMES[theme]
    img = Image.new('RGB', (SIZE, SIZE), th['page'])
    d = ImageDraw.Draw(img)

    cw, ch = 880, 720
    cx, cy = (SIZE - cw) // 2, (SIZE - ch) // 2
    d.rounded_rectangle([cx, cy, cx + cw, cy + ch], radius=26, fill=th['card'])

    pad = 40
    x0, x1 = cx + pad, cx + cw - pad
    header(d, th, x0, x1, cy + pad, 'HCV400 P2', 'Automatisk')

    f_lbl, f_deg, f_flow = font(17), font(36, bold=True), font(17)
    f_k, f_v, f_u = font(16), font(27, bold=True), font(17)

    ex_top = cy + pad + 76
    ex_h = 300
    mid_x, mid_y = cx + cw / 2, ex_top + ex_h / 2

    # Two streams crossing through the core, each drawn in the colour of the
    # air at that end so the heat swap happens visibly in the middle.
    left, right = x0 + 150, x1 - 150
    top, bottom = ex_top + 40, ex_top + ex_h - 40

    warm = bezier((left, top), (left + 150, top), (right - 150, bottom), (right, bottom))
    cool = bezier((right, top), (right - 150, top), (left + 150, bottom), (left, bottom))
    gradient_path(img, warm, colour_for(25.2), colour_for(2.1), 13)
    gradient_path(img, cool, colour_for(-3.5), colour_for(19.4), 13)
    d = ImageDraw.Draw(img)
    arrow(d, warm[-1], (warm[-1][0] - warm[-6][0], warm[-1][1] - warm[-6][1]), colour_for(2.1))
    arrow(d, cool[-1], (cool[-1][0] - cool[-6][0], cool[-1][1] - cool[-6][1]), colour_for(19.4))

    # Core diamond over the crossing
    r = 78
    d.polygon([(mid_x, mid_y - r), (mid_x + r, mid_y), (mid_x, mid_y + r), (mid_x - r, mid_y)],
              fill=th['core'], outline=th['line'], width=3)
    d.polygon([(mid_x, mid_y - r + 16), (mid_x + r - 16, mid_y),
               (mid_x, mid_y + r - 16), (mid_x - r + 16, mid_y)],
              outline=th['line'], width=1)
    pct = '88%'
    pw = d.textlength(pct, font=font(34, bold=True))
    d.text((mid_x - pw / 2, mid_y - 26), pct, font=font(34, bold=True), fill=th['text'])
    cap = 'GENVINDING'
    cw2 = d.textlength(cap, font=font(14))
    d.text((mid_x - cw2 / 2, mid_y + 14), cap, font=font(14), fill=th['muted'])

    def port(x, y, label, value, flow, right_align=False):
        text = f'{value:.1f}'.replace('.', ',') + '°'
        rows = [(label.upper(), f_lbl, th['muted'], 0),
                (text, f_deg, colour_for(value), 22),
                (f'{flow} m³/h', f_flow, th['muted'], 62)]
        for content, fnt, colour, dy in rows:
            w = d.textlength(content, font=fnt)
            d.text((x - w if right_align else x, y + dy), content, font=fnt, fill=colour)

    port(x0, ex_top, 'Fraluft', 25.2, 214)
    port(x1, ex_top, 'Udeluft', -3.5, 200, right_align=True)
    port(x0, ex_top + ex_h - 86, 'Tilluft', 19.4, 200)
    port(x1, ex_top + ex_h - 86, 'Afkast', 2.1, 214, right_align=True)

    ty = ex_top + ex_h + 16
    data = [('Fugt', '41', '%'), ('Bypass', 'Lukket', ''), ('Genvundet', '1,66', 'kW'),
            ('Effekt', '39', 'W'), ('Filter', '173', 'dage')]
    gap = 8
    tw = (x1 - x0 - gap * 2) / 3
    for i, (k, v, u) in enumerate(data):
        col, row = i % 3, i // 3
        bx = x0 + col * (tw + gap)
        by = ty + row * 78
        tile(d, [bx, by, bx + tw, by + 68], th, k, v, u, f_k, f_v, f_u)

    d.text((x0, ty + 168), 'TRIN', font=font(15), fill=th['muted'])
    levels(d, th, x0, x1, ty + 190, 3, height=44)
    return img


# --- compact widget ----------------------------------------------------------

def draw_compact(theme):
    th = THEMES[theme]
    img = Image.new('RGB', (SIZE, SIZE), th['page'])
    d = ImageDraw.Draw(img)

    cw, ch = 880, 470
    cx, cy = (SIZE - cw) // 2, (SIZE - ch) // 2
    d.rounded_rectangle([cx, cy, cx + cw, cy + ch], radius=26, fill=th['card'])

    pad = 40
    x0, x1 = cx + pad, cx + cw - pad
    header(d, th, x0, x1, cy + pad, 'HCV400 P2', 'Automatisk')

    # Dial: 270° of arc, filled against the commissioned nominal flow.
    dial_r, dial_w = 118, 20
    dcx, dcy = x0 + dial_r + 10, cy + pad + 76 + dial_r
    box = [dcx - dial_r, dcy - dial_r, dcx + dial_r, dcy + dial_r]
    d.arc(box, start=135, end=45, fill=th['line'], width=dial_w)
    # Full scale is the nominal flow with headroom, so the nominal level sits
    # at four fifths rather than pegged against the end.
    d.arc(box, start=135, end=135 + 270 * min(1.0, 214 / (216 * 1.25)), fill=BLUE, width=dial_w)

    big, unit, sub = '214', 'm³/h', '88% genv.'
    f_big, f_unit, f_sub = font(52, bold=True), font(20), font(18)
    for content, fnt, colour, dy in ((big, f_big, th['text'], -42),
                                     (unit, f_unit, th['muted'], 16),
                                     (sub, f_sub, BLUE, 44)):
        w = d.textlength(content, font=fnt)
        d.text((dcx - w / 2, dcy + dy), content, font=fnt, fill=colour)

    f_k, f_v, f_u = font(16), font(27, bold=True), font(17)
    tx0 = dcx + dial_r + 30
    gap = 8
    tw = (x1 - tx0 - gap) / 2
    cells = [('Fraluft', '25,2°', '', colour_for(25.2)), ('Tilluft', '19,4°', '', colour_for(19.4)),
             ('Fugt', '41', '%', None), ('Filter', '173', 'dage', None)]
    for i, (k, v, u, colour) in enumerate(cells):
        bx = tx0 + (i % 2) * (tw + gap)
        by = dcy - 78 + (i // 2) * 78
        tile(d, [bx, by, bx + tw, by + 68], th, k, v, u, f_k, f_v, f_u, value_colour=colour)

    fy = cy + ch - pad - 50
    d.text((x0, fy + 16), 'TRIN', font=font(15), fill=th['muted'])
    levels(d, th, x0 + 66, x1, fy, 3, height=46)
    return img


if __name__ == '__main__':
    for widget, draw in (('status', draw_status), ('compact', draw_compact)):
        for theme in ('light', 'dark'):
            path = os.path.join(ROOT, widget, f'preview-{theme}.png')
            draw(theme).save(path, 'PNG', optimize=True)
            print(f'{widget}/preview-{theme}.png -> {os.path.getsize(path) // 1024} KB')

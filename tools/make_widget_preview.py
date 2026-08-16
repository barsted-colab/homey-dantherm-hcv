#!/usr/bin/env python3
"""
Draws the widget picker previews: a mock of the widget in light and dark.

These are illustrations of the real layout, not screenshots — the widget needs
a live unit to render, and a preview has to exist before it can be installed.
Keep them in step with public/index.html when the layout changes.
"""

from PIL import Image, ImageDraw, ImageFont
import os

SIZE = 1024
OUT = os.path.join(os.path.dirname(__file__), '..', 'widgets', 'status')

# Air colours are deliberately identical in both themes: a temperature should
# not change meaning when the dashboard switches to dark.
COLD = (74, 163, 224)
COOL = (123, 191, 232)
NEUTRAL = (154, 167, 180)
WARM = (234, 161, 75)
HOT = (226, 112, 58)
BLUE = (43, 142, 222)

THEMES = {
    'light': {
        'page': (238, 241, 245),
        'card': (255, 255, 255),
        'text': (22, 25, 29),
        'muted': (122, 130, 139),
        'track': (223, 228, 233),
        'core': (243, 245, 247),
        'seg': (238, 240, 243),
    },
    'dark': {
        'page': (18, 20, 24),
        'card': (32, 36, 42),
        'text': (240, 243, 246),
        'muted': (142, 152, 163),
        'track': (56, 62, 70),
        'core': (44, 49, 57),
        'seg': (48, 53, 61),
    },
}

FONT_CANDIDATES = [
    '/System/Library/Fonts/Supplemental/Arial.ttf',
    '/System/Library/Fonts/Helvetica.ttc',
    '/Library/Fonts/Arial.ttf',
]


def font(size, bold=False):
    for path in FONT_CANDIDATES:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size, index=1 if bold and path.endswith('.ttc') else 0)
            except OSError:
                continue
    return ImageFont.load_default()


def colour_for(celsius):
    if celsius <= 0:
        return COLD
    if celsius <= 12:
        return COOL
    if celsius <= 19:
        return NEUTRAL
    if celsius <= 24:
        return WARM
    return HOT


def gradient_bar(draw, box, left, right):
    """Horizontal gradient inside a rounded bar, drawn one column at a time."""
    x0, y0, x1, y1 = box
    radius = (y1 - y0) / 2
    width = max(1, int(x1 - x0))
    for i in range(width):
        t = i / max(1, width - 1)
        colour = tuple(int(left[c] + (right[c] - left[c]) * t) for c in range(3))
        draw.line([(x0 + i, y0), (x0 + i, y1)], fill=colour)
    # Mask the ends back to a rounded shape.
    return radius


def draw_preview(theme_name):
    th = THEMES[theme_name]
    img = Image.new('RGB', (SIZE, SIZE), th['page'])
    d = ImageDraw.Draw(img)

    # Card
    cw, ch = 880, 512
    cx, cy = (SIZE - cw) // 2, (SIZE - ch) // 2
    d.rounded_rectangle([cx, cy, cx + cw, cy + ch], radius=28, fill=th['card'])

    pad = 44
    x0, y0 = cx + pad, cy + pad
    x1 = cx + cw - pad

    f_title = font(28, bold=True)
    f_label = font(20)
    f_value = font(40, bold=True)
    f_chip = font(22)
    f_small = font(22)
    f_pct = font(38, bold=True)
    f_cap = font(18)

    # --- header ---
    d.text((x0, y0), 'HCV400 P2', font=f_title, fill=th['text'])
    chip = 'Automatisk'
    cw_chip = d.textlength(chip, font=f_chip)
    d.rounded_rectangle([x1 - cw_chip - 28, y0 - 6, x1, y0 + 34], radius=8,
                        fill=tuple(int(th['card'][i] + (BLUE[i] - th['card'][i]) * 0.16) for i in range(3)))
    d.text((x1 - cw_chip - 14, y0 + 1), chip, font=f_chip, fill=BLUE)

    # --- exchange block ---
    ex_top = y0 + 78
    core_w, core_h = 150, 128
    core_x = cx + (cw - core_w) // 2
    core_y = ex_top + 46

    def temp_block(x, y, label, value, align_right=False):
        text = f'{value:.1f}'.replace('.', ',') + '°'
        if align_right:
            lw = d.textlength(label, font=f_label)
            vw = d.textlength(text, font=f_value)
            d.text((x - lw, y), label, font=f_label, fill=th['muted'])
            d.text((x - vw, y + 26), text, font=f_value, fill=colour_for(value))
        else:
            d.text((x, y), label, font=f_label, fill=th['muted'])
            d.text((x, y + 26), text, font=f_value, fill=colour_for(value))

    temp_block(x0, ex_top, 'UDELUFT', -3.5)
    temp_block(x1, ex_top, 'TILLUFT', 19.4, align_right=True)

    # Core badge
    d.rounded_rectangle([core_x, core_y, core_x + core_w, core_y + core_h],
                        radius=16, fill=th['core'])
    pct = '84%'
    pw = d.textlength(pct, font=f_pct)
    d.text((core_x + (core_w - pw) / 2, core_y + 30), pct, font=f_pct, fill=th['text'])
    cap = 'GENVINDING'
    capw = d.textlength(cap, font=f_cap)
    d.text((core_x + (core_w - capw) / 2, core_y + 78), cap, font=f_cap, fill=th['muted'])

    # Flow bars, one either side of the badge
    bar_h = 12
    gap = 26
    for row, (left_c, right_c) in enumerate([
        (colour_for(-3.5), colour_for(19.4)),   # intake, cold -> warm
        (colour_for(21.8), colour_for(2.1)),    # extract, warm -> cold
    ]):
        by = core_y + 28 + row * (bar_h + gap)
        for seg_x0, seg_x1 in [(x0, core_x - 22), (core_x + core_w + 22, x1)]:
            bar = Image.new('RGB', (int(seg_x1 - seg_x0), bar_h))
            bd = ImageDraw.Draw(bar)
            gradient_bar(bd, (0, 0, bar.width, bar_h), left_c, right_c)
            mask = Image.new('L', (bar.width, bar_h), 0)
            ImageDraw.Draw(mask).rounded_rectangle([0, 0, bar.width - 1, bar_h - 1],
                                                  radius=bar_h // 2, fill=255)
            img.paste(bar, (int(seg_x0), int(by)), mask)

    bottom_top = core_y + core_h + 26
    temp_block(x0, bottom_top, 'AFKAST', 2.1)
    temp_block(x1, bottom_top, 'FRALUFT', 21.8, align_right=True)

    # --- footer ---
    fy = cy + ch - pad - 52
    seg_w, seg_h, seg_gap = 56, 52, 7
    for i in range(5):
        sx = x0 + i * (seg_w + seg_gap)
        on = i == 2
        d.rounded_rectangle([sx, fy, sx + seg_w, fy + seg_h], radius=10,
                            fill=BLUE if on else th['seg'])
        label = str(i)
        lw = d.textlength(label, font=f_small)
        d.text((sx + (seg_w - lw) / 2, fy + 13), label,
               font=f_small, fill=(255, 255, 255) if on else th['muted'])

    stats = '42%  ·  90d'
    sw = d.textlength(stats, font=f_small)
    d.text((x1 - sw, fy + 14), stats, font=f_small, fill=th['muted'])

    return img


if __name__ == '__main__':
    for name in ('light', 'dark'):
        path = os.path.join(OUT, f'preview-{name}.png')
        draw_preview(name).save(path, 'PNG', optimize=True)
        print(f'preview-{name}.png -> {os.path.getsize(path) // 1024} KB')

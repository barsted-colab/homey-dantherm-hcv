#!/usr/bin/env python3
"""Generates Homey app and driver images from the Dantherm product render."""

from PIL import Image, ImageDraw, ImageFilter
import math
import os

SRC = os.path.expanduser('~/Downloads/dantherm-hcv-460-p2-a-bp-rh.jpg')
APP = os.path.expanduser('~/Documents/Github/Homey App Development/dk.fredskilde.dantherm')

WHITE = (255, 255, 255)


def load_product():
    """Returns the render cropped tight to the unit, plus an alpha mask."""
    im = Image.open(SRC).convert('RGB')

    # The render sits on white, so anything below the threshold is product.
    grey = im.convert('L')
    mask = grey.point(lambda p: 255 if p < 244 else 0).convert('L')
    box = mask.getbbox()
    if box is None:
        raise SystemExit('Could not locate the product in the render')

    product = im.crop(box)
    alpha = mask.crop(box)
    # Soften the cut edge so the composite does not look stamped on.
    alpha = alpha.filter(ImageFilter.GaussianBlur(0.6)).point(lambda p: min(255, int(p * 1.6)))
    product.putalpha(alpha)
    return product


def fit(img, size, margin=0.08):
    """Scales img to fit a square of `size` with a proportional margin."""
    inner = int(size * (1 - margin * 2))
    scaled = img.copy()
    scaled.thumbnail((inner, inner), Image.LANCZOS)
    return scaled


def driver_image(product, size):
    """White background, product centred — what the guidelines ask for."""
    canvas = Image.new('RGB', (size, size), WHITE)
    # Tiny sizes need a tighter crop or the unit becomes an unreadable speck.
    item = fit(product, size, margin=0.04 if size <= 100 else 0.09)
    canvas.paste(item, ((size - item.width) // 2, (size - item.height) // 2), item)
    return canvas


def app_image(product, width, height):
    """
    Landscape composition. The guidelines reject 'a single flat shape on a
    plain, monochrome background', so this builds a graded field with airflow
    arcs behind the unit rather than dropping it on a solid colour.
    """
    canvas = Image.new('RGB', (width, height), WHITE)
    draw = ImageDraw.Draw(canvas)

    # Vertical gradient: cool air at the top, warm recovered air at the bottom.
    top = (222, 238, 248)
    bottom = (245, 240, 232)
    for y in range(height):
        t = y / max(1, height - 1)
        draw.line(
            [(0, y), (width, y)],
            fill=tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3)),
        )

    # Airflow streamlines: sine curves that drift and fade as they cross the
    # frame, so they read as moving air rather than drawn-on arcs. Rendered at
    # 3x and downsampled, because thin diagonal strokes alias badly otherwise.
    ss = 3
    flow = Image.new('RGBA', (width * ss, height * ss), (0, 0, 0, 0))
    fd = ImageDraw.Draw(flow)

    for i in range(7):
        base = height * ss * (0.10 + i * 0.13)
        amplitude = height * ss * (0.045 + (i % 3) * 0.018)
        period = width * ss * (0.85 + (i % 2) * 0.35)
        alpha = 60 - abs(i - 3) * 9
        thickness = max(2, int(height * ss * (0.009 - (i % 3) * 0.001)))

        points = []
        for step in range(0, width * ss + 1, 6):
            phase = (step / period) * 6.2831853
            # Curves ride slightly upward as they travel, like warm air.
            drift = -(step / (width * ss)) * height * ss * 0.05
            points.append((step, base + amplitude * math.sin(phase) + drift))

        fd.line(points, fill=(0, 138, 205, alpha), width=thickness, joint='curve')

    flow = flow.resize((width, height), Image.LANCZOS)
    flow = flow.filter(ImageFilter.GaussianBlur(max(0.4, height * 0.0016)))
    canvas = Image.alpha_composite(canvas.convert('RGBA'), flow).convert('RGB')

    # Unit on the right, sized to the canvas height.
    item = product.copy()
    item.thumbnail((int(width * 0.42), int(height * 0.82)), Image.LANCZOS)
    x = int(width * 0.60)
    y = (height - item.height) // 2

    # Soft contact shadow so the unit sits in the scene.
    shadow = Image.new('RGBA', (width, height), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow)
    sd.ellipse(
        [x + item.width * 0.05, y + item.height * 0.93,
         x + item.width * 0.95, y + item.height * 1.06],
        fill=(60, 70, 80, 70),
    )
    shadow = shadow.filter(ImageFilter.GaussianBlur(max(2, height * 0.02)))
    canvas = Image.alpha_composite(canvas.convert('RGBA'), shadow).convert('RGB')

    canvas.paste(item, (x, y), item)
    return canvas


def main():
    product = load_product()
    print(f'produkt beskaaret til {product.width}x{product.height}')

    for name, size in [('small', 75), ('large', 500), ('xlarge', 1000)]:
        path = f'{APP}/drivers/hcv/assets/images/{name}.png'
        driver_image(product, size).save(path, 'PNG', optimize=True)
        print(f'driver {name:7} {size}x{size}  -> {os.path.getsize(path) // 1024} KB')

    for name, w, h in [('small', 250, 175), ('large', 500, 350), ('xlarge', 1000, 700)]:
        path = f'{APP}/assets/images/{name}.png'
        app_image(product, w, h).save(path, 'PNG', optimize=True)
        print(f'app    {name:7} {w}x{h}  -> {os.path.getsize(path) // 1024} KB')


if __name__ == '__main__':
    main()

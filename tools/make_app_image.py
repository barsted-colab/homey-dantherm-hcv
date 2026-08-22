#!/usr/bin/env python3
"""
Builds the App Store app images.

Certification asked for lifestyle imagery rather than the device on a
decorative background. A ventilation unit lives in a utility room, so putting
it inside a living room would be a lie — it stands in front of the scene
instead, which reads as "this product, for this kind of home".

Both source images are Dantherm's own: the product render and an interior
photograph from their residential ventilation material.

    python3 tools/make_app_image.py
"""

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter
import os

APP = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PRODUCT = os.path.expanduser('~/Downloads/dantherm-hcv-460-p2-a-bp-rh.jpg')
# Dantherm's own interior photograph, from their residential ventilation
# material. Kept out of the repository — it is their asset, not this app's.
SCENE = os.path.expanduser('~/Downloads/Insights-Dantherm-home-ventilation-full.jpg')

SIZES = (('small', 250, 175), ('large', 500, 350), ('xlarge', 1000, 700))


def cutout(path):
    """
    Lifts the unit off its white studio background.

    Thresholding alone leaves a fringe of half-white pixels — invisible against
    white, but a halo the moment the unit stands on anything else. One pixel of
    erosion removes it; two starts eating the thin rings of the duct spigots,
    which are nearly as light as the background they sit on.
    """
    im = Image.open(path).convert('RGB')
    mask = im.convert('L').point(lambda p: 255 if p < 246 else 0).convert('L')
    mask = mask.filter(ImageFilter.MinFilter(3))
    mask = mask.filter(ImageFilter.GaussianBlur(0.7))
    box = mask.getbbox()
    out = im.crop(box)
    out.putalpha(mask.crop(box))
    return out


def build(width, height, product, scene_path):
    scene = Image.open(scene_path).convert('RGB')
    w, h = scene.size
    cw = int(h * width / height)
    left = int((w - cw) * 0.10)
    scene = scene.crop((left, 0, left + cw, h)).resize((width, height), Image.LANCZOS)

    # Push the room back so the unit is the subject rather than competing with
    # the furniture behind it.
    scene = scene.filter(ImageFilter.GaussianBlur(height * 0.005))
    scene = ImageEnhance.Brightness(scene).enhance(1.05)
    scene = ImageEnhance.Color(scene).enhance(0.94)

    wash = Image.new('RGBA', (width, height), (0, 0, 0, 0))
    px = wash.load()
    for x in range(width):
        alpha = int(70 * (x / width) ** 1.6)
        for y in range(height):
            px[x, y] = (255, 255, 255, alpha)
    scene = Image.alpha_composite(scene.convert('RGBA'), wash)

    item = product.copy()
    item.thumbnail((int(width * 0.24), int(height * 0.52)), Image.LANCZOS)
    x = width - item.width - int(width * 0.11)
    y = int(height * 0.87) - item.height
    base = y + item.height

    # Two shadows: a tight dark core where the cabinet meets the floor, and a
    # wide soft one for ambient occlusion. Either alone reads as floating or
    # as a smudge.
    for inset, drop, alpha, blur in ((0.08, 0.020, 165, 0.011), (-0.18, 0.050, 85, 0.034)):
        layer = Image.new('RGBA', (width, height), (0, 0, 0, 0))
        ImageDraw.Draw(layer).ellipse(
            [x + item.width * inset, base - height * 0.004,
             x + item.width * (1 - inset), base + height * drop],
            fill=(32, 40, 50, alpha))
        scene = Image.alpha_composite(scene, layer.filter(
            ImageFilter.GaussianBlur(max(2, height * blur))))

    scene.alpha_composite(item, (x, y))
    return scene.convert('RGB')


if __name__ == '__main__':
    import sys
    scene = sys.argv[1] if len(sys.argv) > 1 else SCENE
    product = cutout(PRODUCT)
    for name, w, h in SIZES:
        path = os.path.join(APP, 'assets', 'images', f'{name}.png')
        build(w, h, product, scene).save(path, 'PNG', optimize=True)
        print(f'{name:7} {w}x{h}  {os.path.getsize(path) // 1024} KB')

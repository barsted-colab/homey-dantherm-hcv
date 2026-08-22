#!/usr/bin/env python3
"""
Builds the App Store app images.

Certification asked for lifestyle imagery rather than the device on a
decorative background, and specifically for something that carries the feel of
the app rather than a picture of the hardware. So this is Dantherm's own
residential ventilation photograph, cropped and nothing else: people enjoying
a bright, airy home is what a ventilation app is for.

An earlier version stood the unit in front of the scene. It was dropped — the
cut-out never sat on the floor convincingly, and the composition works because
of the clean space beside the subjects, which anything placed there destroys.

The source is Dantherm's asset, so it is not kept in the repository.

    python3 tools/make_app_image.py [path/to/photo.jpg]
"""

from PIL import Image, ImageEnhance
import os
import sys

APP = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PRODUCT = os.path.expanduser('~/Downloads/dantherm-hcv-460-p2-a-bp-rh.jpg')
SCENE = os.path.expanduser('~/Downloads/Dantherm-ventilation-web.jpg')

SIZES = (('small', 250, 175), ('large', 500, 350), ('xlarge', 1000, 700))

# Crop anchor across the source width. Zero keeps the subjects at the left and
# the open space at the right, which is what gives the frame its air.
ANCHOR = 0.0


def build(width, height, scene_path):
    im = Image.open(scene_path).convert('RGB')
    w, h = im.size
    cw = int(h * width / height)
    left = int((w - cw) * ANCHOR)
    out = im.crop((left, 0, left + cw, h)).resize((width, height), Image.LANCZOS)

    # A touch of contrast and warmth: the source is a web-optimised JPEG and
    # goes flat once it is scaled to 250 px wide.
    out = ImageEnhance.Contrast(out).enhance(1.04)
    out = ImageEnhance.Color(out).enhance(1.05)
    return out


if __name__ == '__main__':
    scene = sys.argv[1] if len(sys.argv) > 1 else SCENE
    for name, w, h in SIZES:
        path = os.path.join(APP, 'assets', 'images', f'{name}.png')
        build(w, h, scene).save(path, 'PNG', optimize=True)
        print(f'{name:7} {w}x{h}  {os.path.getsize(path) // 1024} KB')

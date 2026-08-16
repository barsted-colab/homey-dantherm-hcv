#!/usr/bin/env python3
"""
Draws an original illustration of a generic heat-recovery ventilation unit.

Deliberately not a trace of any manufacturer's product render: an upright
cabinet with four duct spigots and a front panel is the functional shape shared
across this whole class of unit, which is why the app covers 19 models with one
driver. Everything here is drawn from primitives.

Rendered at 4x and downsampled, because the diagonal cabinet edges alias badly
at final size otherwise.
"""

from PIL import Image, ImageDraw, ImageFilter
import math

SS = 4  # supersampling factor

# Cool galvanised steel, lit from the upper left.
TOP_LIGHT = (238, 241, 244)
TOP_DARK = (206, 212, 219)
FRONT_LIGHT = (222, 227, 233)
FRONT_DARK = (188, 195, 203)
SIDE_LIGHT = (176, 184, 193)
SIDE_DARK = (146, 154, 164)
EDGE = (120, 129, 139)
PANEL = (44, 50, 58)
DUCT_RIM = (198, 205, 212)
DUCT_BORE = (96, 104, 113)


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def shade_polygon(size, points, top_colour, bottom_colour):
    """A polygon filled with a vertical gradient, returned as an RGBA layer."""
    layer = Image.new('RGBA', size, (0, 0, 0, 0))

    ys = [p[1] for p in points]
    y0, y1 = int(min(ys)), int(max(ys))
    gradient = Image.new('RGB', (1, max(1, y1 - y0)))
    gd = ImageDraw.Draw(gradient)
    for y in range(gradient.height):
        gd.point((0, y), fill=lerp(top_colour, bottom_colour, y / max(1, gradient.height - 1)))
    gradient = gradient.resize(size, Image.NEAREST) if False else gradient.resize(
        (size[0], gradient.height), Image.NEAREST)

    field = Image.new('RGB', size, bottom_colour)
    field.paste(gradient, (0, y0))

    mask = Image.new('L', size, 0)
    ImageDraw.Draw(mask).polygon(points, fill=255)
    layer.paste(field, (0, 0), mask)
    return layer


def ellipse_points(cx, cy, rx, ry, steps=72):
    return [
        (cx + rx * math.cos(2 * math.pi * i / steps),
         cy + ry * math.sin(2 * math.pi * i / steps))
        for i in range(steps)
    ]


def draw_unit(size):
    """Returns an RGBA illustration of the unit, sized to a square canvas."""
    w = h = size * SS
    canvas = Image.new('RGBA', (w, h), (0, 0, 0, 0))

    # Cabinet geometry, in a light isometric projection. These units are
    # noticeably taller than they are wide, and the top face needs enough
    # depth to seat four spigots without them colliding.
    cab_w = w * 0.42
    cab_h = h * 0.56
    depth_x = w * 0.23
    depth_y = h * 0.145

    x0 = w * 0.17
    y0 = h * 0.31  # top of the front face

    front = [(x0, y0), (x0 + cab_w, y0), (x0 + cab_w, y0 + cab_h), (x0, y0 + cab_h)]
    top = [(x0, y0), (x0 + depth_x, y0 - depth_y),
           (x0 + cab_w + depth_x, y0 - depth_y), (x0 + cab_w, y0)]
    side = [(x0 + cab_w, y0), (x0 + cab_w + depth_x, y0 - depth_y),
            (x0 + cab_w + depth_x, y0 + cab_h - depth_y), (x0 + cab_w, y0 + cab_h)]

    for polygon, light, dark in [
        (top, TOP_LIGHT, TOP_DARK),
        (front, FRONT_LIGHT, FRONT_DARK),
        (side, SIDE_LIGHT, SIDE_DARK),
    ]:
        canvas.alpha_composite(shade_polygon((w, h), polygon, light, dark))

    draw = ImageDraw.Draw(canvas)
    stroke = max(1, int(w * 0.0035))
    for polygon in (top, front, side):
        draw.polygon(polygon, outline=EDGE, width=stroke)

    # Four duct spigots standing on the top face. The centre of each follows
    # the top parallelogram exactly, so they sit on the surface instead of
    # floating over the back edge:
    #     x = x0 + cab_w * u + depth_x * v
    #     y = y0 - depth_y * v
    # The ellipse is squashed by the same depth ratio as the face itself,
    # which is what makes a circle read as lying flat on it.
    duct_rx = cab_w * 0.115
    duct_ry = duct_rx * (depth_y / depth_x)
    riser = h * 0.026

    # Back row first: a nearer spigot has to overlap the one behind it, never
    # the other way round.
    spigots = sorted(
        ((0.24, 0.74), (0.70, 0.72), (0.26, 0.28), (0.72, 0.26)),
        key=lambda p: -p[1],
    )

    for u, v in spigots:
        cx = x0 + cab_w * u + depth_x * v
        cy = y0 - depth_y * v

        # Cylinder wall, then the top rim and bore drawn over it.
        wall = [(cx - duct_rx, cy), (cx - duct_rx, cy - riser),
                (cx + duct_rx, cy - riser), (cx + duct_rx, cy)]
        canvas.alpha_composite(shade_polygon((w, h), wall, DUCT_RIM, TOP_DARK))
        draw.ellipse([cx - duct_rx, cy - duct_ry, cx + duct_rx, cy + duct_ry],
                     fill=DUCT_RIM, outline=EDGE, width=stroke)
        draw.line([(cx - duct_rx, cy), (cx - duct_rx, cy - riser)], fill=EDGE, width=stroke)
        draw.line([(cx + duct_rx, cy), (cx + duct_rx, cy - riser)], fill=EDGE, width=stroke)
        draw.ellipse([cx - duct_rx, cy - riser - duct_ry, cx + duct_rx, cy - riser + duct_ry],
                     fill=DUCT_RIM, outline=EDGE, width=stroke)
        inner = duct_rx * 0.68
        draw.ellipse([cx - inner, cy - riser - duct_ry * 0.68,
                      cx + inner, cy - riser + duct_ry * 0.68],
                     fill=DUCT_BORE)

    # Control panel and the two filter access handles on the front face.
    panel_w, panel_h = cab_w * 0.42, cab_h * 0.075
    px = x0 + cab_w * 0.10
    py = y0 + cab_h * 0.085
    radius = max(2, int(panel_h * 0.25))
    draw.rounded_rectangle([px, py, px + panel_w, py + panel_h], radius=radius, fill=PANEL)

    dot_r = panel_h * 0.14
    for i in range(4):
        dx = px + panel_w * (0.20 + i * 0.20)
        draw.ellipse([dx - dot_r, py + panel_h / 2 - dot_r,
                      dx + dot_r, py + panel_h / 2 + dot_r], fill=(150, 210, 240))

    handle_h = cab_h * 0.045
    hy = y0 + cab_h * 0.22
    for i in range(2):
        hx = x0 + cab_w * (0.10 + i * 0.44)
        draw.rounded_rectangle([hx, hy, hx + cab_w * 0.36, hy + handle_h],
                               radius=max(2, int(handle_h * 0.2)), fill=PANEL)

    # Seam between the two filter halves.
    seam_y = y0 + cab_h * 0.44
    draw.line([(x0, seam_y), (x0 + cab_w, seam_y)], fill=EDGE, width=stroke)

    canvas = canvas.resize((size, size), Image.LANCZOS)
    return canvas.filter(ImageFilter.SMOOTH)


if __name__ == '__main__':
    draw_unit(1000).save('/tmp/unit-preview.png')
    print('skrev /tmp/unit-preview.png')

"""Builds every brand file from the two source images in ./source (the user's, 2026-11-05).

  venv/bin/python apps/site/brand/build.py      (needs: numpy opencv-python-headless fonttools)

- The G is a textured render, so it stays raster: its white ground is cut away and it is
  sized down into the favicon set in apps/site/public.
- The flag is flat geometry, so it is redrawn as a vector (vertices and gradients measured
  from source/lazaret-flag.webp) instead of cut out, which would leave a white fringe.
- "Lazaret" is set in Solitus (SIL OFL 1.1) and converted to outlines, so no font ships.
- rsvg-convert renders the PNGs. Blue #008CFF is the ground the user chose for the flag.
"""
import pathlib
import struct
import subprocess

import cv2
import numpy as np
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont

HERE = pathlib.Path(__file__).parent
PUBLIC = HERE.parent / "public"
BRAND = PUBLIC / "brand"
FONT = pathlib.Path.home() / "Library/Fonts/Solitus.ttf"
BLUE = "#008CFF"
INK = "#10202b"
NAME = "Lazaret"

font = TTFont(FONT)
glyphs, cmap, upm = font.getGlyphSet(), font.getBestCmap(), font["head"].unitsPerEm

DEFS = """<defs>
<linearGradient id="fb" gradientUnits="userSpaceOnUse" x1="830" y1="500" x2="1190" y2="1120"><stop offset="0" stop-color="#fdc808"/><stop offset=".45" stop-color="#fdd208"/><stop offset="1" stop-color="#fde405"/></linearGradient>
<linearGradient id="fd" gradientUnits="userSpaceOnUse" x1="640" y1="1110" x2="520" y2="1500"><stop offset="0" stop-color="#a87202"/><stop offset=".4" stop-color="#bc8503"/><stop offset=".7" stop-color="#d29b02"/><stop offset="1" stop-color="#e8b303"/></linearGradient>
<linearGradient id="ft" gradientUnits="userSpaceOnUse" x1="420" y1="1400" x2="190" y2="1900"><stop offset="0" stop-color="#fdbe04"/><stop offset=".5" stop-color="#fdc906"/><stop offset="1" stop-color="#fee004"/></linearGradient>
</defs>"""
FLAG = (
    '<path fill="url(#ft)" d="M246 1227 180 1977 560 1510z"/>'
    '<path fill="url(#fd)" d="M246 1227 968 1063 560 1510z"/>'
    '<path fill="url(#fb)" d="M315 365 1673 46 1218 584 1824 863 246 1228z"/>'
)
# The flag's own box in its 2000-unit drawing space.
FX, FY, FW, FH = 178, 46, 1648, 1932


def num(v):
    return f"{v:.2f}".rstrip("0").rstrip(".")


def text_path(text, size, x, baseline, tracking=0.0):
    scale, parts = size / upm, []
    for ch in text:
        name = cmap[ord(ch)]
        pen = SVGPathPen(glyphs, ntos=num)
        glyphs[name].draw(TransformPen(pen, (scale, 0, 0, -scale, x, baseline)))
        parts.append(pen.getCommands())
        x += glyphs[name].width * scale + tracking
    return " ".join(parts), x - tracking


def flag_at(x, y, height):
    s = height / FH
    return f'<g transform="translate({num(x - FX * s)} {num(y - FY * s)}) scale({s:.5f})">{FLAG}</g>'


def svg(width, height, body, title=NAME, defs=True):
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {num(width)} {num(height)}" role="img">'
        f"<title>{title}</title>{DEFS if defs else ''}{body}</svg>\n"
    )


def lockup(text_fill, flag_h=120.0):
    """Flag and name, the name's baseline on the flag's fold so the tail hangs below it."""
    flag_w = FW * flag_h / FH
    size = flag_h * 0.6
    baseline = flag_h * 0.56
    path, end = text_path(NAME, size, flag_w + flag_h * 0.1, baseline, size * 0.01)
    return end, flag_h, flag_at(0, 0, flag_h) + f'<path fill="{text_fill}" d="{path}"/>'


def png(src, dest, width, height=None):
    cmd = ["rsvg-convert", "-w", str(width), "-o", str(dest), str(src)]
    subprocess.run(cmd + (["-h", str(height)] if height else []), check=True)


def build_lazaret():
    BRAND.mkdir(parents=True, exist_ok=True)
    side = FH + 80
    mark = f'<g transform="translate({num((side - FW) / 2 - FX)} {num(40 - FY)})">{FLAG}</g>'
    (BRAND / "lazaret-mark.svg").write_text(svg(side, side, mark))
    png(BRAND / "lazaret-mark.svg", BRAND / "lazaret-mark-512.png", 512)

    # The flag on the blue ground, as in the user's reference: for square avatars.
    inner = side * 1.0
    tile = f'<rect width="{side * 1.7:.0f}" height="{side * 1.7:.0f}" fill="{BLUE}"/>'
    placed = f'<g transform="translate({num((side * 1.7 - side) / 2)} {num((side * 1.7 - inner) / 2)})">{mark}</g>'
    (BRAND / "lazaret-icon.svg").write_text(svg(side * 1.7, side * 1.7, tile + placed))
    png(BRAND / "lazaret-icon.svg", BRAND / "lazaret-icon-512.png", 512)

    for name, fill in (("lazaret-wordmark", INK), ("lazaret-wordmark-white", "#fff")):
        w, h, body = lockup(fill)
        (BRAND / f"{name}.svg").write_text(svg(w, h, body))

    # 1280x640 is GitHub's social preview size; the READMEs use the same picture.
    w, h, body = lockup("#fff")
    k = 300 / h
    banner = (
        f'<rect width="1280" height="640" fill="{BLUE}"/>'
        f'<g transform="translate({num((1280 - w * k) / 2)} {num((640 - h * k) / 2)}) scale({k:.4f})">{body}</g>'
    )
    (HERE / "lazaret-banner.svg").write_text(svg(1280, 640, banner))
    png(HERE / "lazaret-banner.svg", BRAND / "lazaret-banner.png", 1280, 640)


def cut_g():
    """The G on transparency. Only white reachable from the image's edge goes, so the pale
    bevels, which are nearly white too, stay part of the G."""
    bgr = cv2.imread(str(HERE / "source/gleator-g.webp"))
    near_white = (bgr.min(2) >= 250).astype("uint8")
    _, labels = cv2.connectedComponents(near_white, connectivity=4)
    edge = np.unique(np.r_[labels[0], labels[-1], labels[:, 0], labels[:, -1]])
    ground = np.isin(labels, edge[edge != 0])
    # Pull the edge in past the white fringe, then soften it.
    alpha = cv2.erode((~ground).astype("uint8") * 255, np.ones((5, 5), "uint8"))
    alpha = cv2.GaussianBlur(alpha, (0, 0), 1.2)
    x, y, w, h = cv2.boundingRect(alpha)
    side = max(w, h)
    canvas = np.zeros((side, side, 4), "float32")
    ox, oy = (side - w) // 2, (side - h) // 2
    a = alpha[y : y + h, x : x + w, None].astype("float32") / 255
    # Premultiplied, so shrinking doesn't drag transparent pixels' colour into the edge.
    canvas[oy : oy + h, ox : ox + w, :3] = bgr[y : y + h, x : x + w].astype("float32") * a
    canvas[oy : oy + h, ox : ox + w, 3] = a[:, :, 0] * 255
    return canvas


def sized(canvas, size, pad=0.0):
    inner = round(size * (1 - 2 * pad))
    small = cv2.resize(canvas, (inner, inner), interpolation=cv2.INTER_AREA)
    out = np.zeros((size, size, 4), "float32")
    o = (size - inner) // 2
    out[o : o + inner, o : o + inner] = small
    a = out[:, :, 3:] / 255
    rgb = np.divide(out[:, :, :3], a, out=np.zeros_like(out[:, :, :3]), where=a > 0)
    return np.clip(np.dstack([rgb, out[:, :, 3]]), 0, 255).astype("uint8")


def ico(path, images):
    """A .ico is a directory of PNGs; browsers ask for /favicon.ico whatever the HTML says."""
    blobs = [cv2.imencode(".png", im)[1].tobytes() for im in images]
    head = struct.pack("<HHH", 0, 1, len(blobs))
    offset = 6 + 16 * len(blobs)
    entries = b""
    for im, blob in zip(images, blobs):
        s = im.shape[0]
        entries += struct.pack("<BBBBHHII", s, s, 0, 0, 1, 32, len(blob), offset)
        offset += len(blob)
    path.write_bytes(head + entries + b"".join(blobs))


def build_favicons():
    g = cut_g()
    ico(PUBLIC / "favicon.ico", [sized(g, 16), sized(g, 32), sized(g, 48)])
    cv2.imwrite(str(PUBLIC / "icon-192.png"), sized(g, 192))
    # iOS fills transparency with black and rounds the corners itself: a light tile and margin.
    apple = sized(g, 180, pad=0.12)
    a = apple[:, :, 3:] / 255
    tile = apple[:, :, :3] * a + 245 * (1 - a)
    cv2.imwrite(str(PUBLIC / "apple-touch-icon.png"), tile.astype("uint8"))


build_lazaret()
build_favicons()

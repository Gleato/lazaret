"""Builds the site's icons from the double G badge in ./source/gg (the user's, 2026-11-06).

  python3 apps/site/brand/favicons.py      (needs: rsvg-convert, nothing else)

Separate from build.py because that one needs a venv and a local font for the Lazaret logo,
and these are plain SVG renders.

Which cut goes where follows source/gg/README.md: the badge's woven gaps and keyline need
96px or more, so tab sizes use the favicon cut, with solid crossings and no ring.
"""
import pathlib
import struct
import subprocess

HERE = pathlib.Path(__file__).parent
PUBLIC = HERE.parent / "public"
GG = HERE / "source" / "gg"


def png(svg, size):
    return subprocess.run(
        ["rsvg-convert", "-w", str(size), "-h", str(size), str(GG / svg)],
        check=True,
        capture_output=True,
    ).stdout


def ico(path, images):
    """A .ico is a directory of PNGs; browsers ask for /favicon.ico whatever the HTML says."""
    head = struct.pack("<HHH", 0, 1, len(images))
    offset = 6 + 16 * len(images)
    entries = b""
    for size, blob in images:
        entries += struct.pack("<BBBBHHII", size, size, 0, 0, 1, 32, len(blob), offset)
        offset += len(blob)
    path.write_bytes(head + entries + b"".join(blob for _, blob in images))


ico(PUBLIC / "favicon.ico", [(s, png("gg-favicon.svg", s)) for s in (16, 32, 48)])
(PUBLIC / "icon-192.png").write_bytes(png("gg-badge-square.svg", 192))
# Opaque, because iOS fills transparency with black and rounds the corners itself.
(PUBLIC / "apple-touch-icon.png").write_bytes(png("gg-badge-square.svg", 180))

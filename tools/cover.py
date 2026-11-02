#!/usr/bin/env python3
"""Downscale a generated cover to a 1400px-wide webp (a 2k PNG of ~9 MB becomes ~300 KB).

Usage: python3 -I tools/cover.py <source.png> <slug>.webp
Needs Pillow. Look at the image at full size BEFORE using it: image models happily draw real
manufacturer logos and garbled lettering, and a real trademark on a commercial page implies a
relationship you do not have. Regenerate anything with a brand mark, text or people.
"""
import sys

from PIL import Image

src, dst = sys.argv[1], sys.argv[2]
im = Image.open(src).convert("RGB")
im = im.resize((1400, round(1400 * im.height / im.width)), Image.LANCZOS)
im.save(dst, "WEBP", quality=82, method=6)
print(f"{dst}: {im.width}x{im.height}")

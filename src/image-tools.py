#!/usr/bin/env python3
"""Small image helpers for CyberClaw (system python3 + Pillow).
  image-tools.py orient <path>          rotate a photo upright per EXIF, in place
  image-tools.py thumb <path> [maxpx]   print a base64 PNG (keeps transparency)
"""
import base64, io, sys
from PIL import Image, ImageOps

def orient(p):
    im = Image.open(p)
    o = im.getexif().get(274, 1)
    if o in (None, 1):
        print("ok"); return
    fixed = ImageOps.exif_transpose(im)
    kw = {"quality": 92} if (im.format or "").upper() == "JPEG" else {}
    fixed.save(p, format=im.format, **kw)
    print("rotated", o)

def thumb(p, mx):
    im = ImageOps.exif_transpose(Image.open(p))
    if im.mode not in ("RGB", "RGBA"):
        im = im.convert("RGBA")
    im.thumbnail((mx, mx))
    b = io.BytesIO(); im.save(b, format="PNG", optimize=True)
    sys.stdout.write(base64.b64encode(b.getvalue()).decode())

if __name__ == "__main__":
    if sys.argv[1] == "orient": orient(sys.argv[2])
    elif sys.argv[1] == "thumb": thumb(sys.argv[2], int(sys.argv[3]) if len(sys.argv) > 3 else 900)

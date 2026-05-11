#!/usr/bin/env python3
"""Gera icon.png e splash.png para o Capacitor"""
from PIL import Image, ImageDraw, ImageFont
import os

os.makedirs("resources", exist_ok=True)

def make_image(size, font_size_connect, font_size_droid):
    W, H = size, size
    img = Image.new("RGB", (W, H), "#080616")

    for r, color, alpha in [
        (int(W*0.44), "#1A1953", 70),
        (int(W*0.33), "#162E93", 90),
        (int(W*0.22), "#2F2FE4", 50),
    ]:
        overlay = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        od = ImageDraw.Draw(overlay)
        cx, cy = W//2, H//2
        od.ellipse([cx-r, cy-r, cx+r, cy+r], fill=(*bytes.fromhex(color[1:]), alpha))
        img = Image.alpha_composite(img.convert("RGBA"), overlay).convert("RGB")

    draw = ImageDraw.Draw(img)
    try:
        fc = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", font_size_connect)
        fd = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", font_size_droid)
    except:
        fc = fd = ImageFont.load_default()

    cx, cy = W//2, H//2
    bc = draw.textbbox((0,0), "CONNECT", font=fc)
    bd = draw.textbbox((0,0), "DROID", font=fd)
    twc, thc = bc[2]-bc[0], bc[3]-bc[1]
    twd, thd = bd[2]-bd[0], bd[3]-bd[1]
    gap = int(H * 0.015)
    total = thc + gap + thd
    y = cy - total // 2

    draw.text((cx - twc//2, y), "CONNECT", font=fc, fill="#2F2FE4")
    draw.text((cx - twd//2, y + thc + gap), "DROID", font=fd, fill="#FFFFFF")
    return img

# Icon 1024x1024
make_image(1024, 200, 110).save("resources/icon.png")
print("icon.png gerado")

# Splash 2048x2048
make_image(2048, 220, 140).save("resources/splash.png")
print("splash.png gerado")

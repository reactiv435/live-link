"""make-icon.py -> build/icon.png (256), build/icon.ico (16..256), build/icon-1024.png, build/tray.png (32).

The LIVE Link mark: an atom. Three chrome orbits (brightness falls off around each ring like a real specular
highlight: no hard horizon band), a glowing crimson nucleus, one crimson electron per orbit, on a black tile.
Brand: black, chrome, crimson; neutral darks only. Drawn at 2048 and downsampled so it stays crisp at 16 px.
"""
import math, os
from PIL import Image, ImageDraw, ImageFilter, ImageChops

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', 'build')
S = 2048
C = S / 2
CRIMSON = (224, 38, 63)


def tile():
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    m = Image.new('L', (S, S), 0)
    ImageDraw.Draw(m).rounded_rectangle((64, 64, S - 64, S - 64), radius=440, fill=255)
    bg = Image.new('RGBA', (S, S), (10, 10, 10, 255))
    # faint crimson bloom behind the nucleus so the tile isn't flat black
    bloom = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(bloom).ellipse((C - 700, C - 700, C + 700, C + 700), fill=(120, 14, 30, 150))
    bg = Image.alpha_composite(bg, bloom.filter(ImageFilter.GaussianBlur(260)))
    # thin chrome bezel with falloff
    bez = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(bez).rounded_rectangle((70, 70, S - 70, S - 70), radius=436, outline=(255, 255, 255, 60), width=10)
    bg = Image.alpha_composite(bg, bez)
    img.paste(bg, (0, 0), m)
    return img


def orbit(angle_deg, rx=820, ry=300, width=80):
    """One chrome ellipse band, rotated, shaded per pixel (numpy): brightness follows the ring's normal against a
    key light from the upper left (smooth specular falloff, no hard band), and a rounded cross-section profile
    (bright centre line, darker edges) so it reads as a polished metal tube."""
    import numpy as np
    a = math.radians(angle_deg)
    ca, sa = math.cos(a), math.sin(a)
    yy, xx = np.mgrid[0:S, 0:S].astype(np.float32)
    dx, dy = xx - C, yy - C
    u = dx * ca + dy * sa            # into the ellipse's own frame
    v = -dx * sa + dy * ca
    t = np.arctan2(v / ry, u / rx)
    ex, ey = rx * np.cos(t), ry * np.sin(t)          # nearest-ish point on the ellipse (radial param)
    dist = np.hypot(u - ex, v - ey)
    half = width / 2.0
    cover = np.clip(half + 1.0 - dist, 0, 1)         # 1 px antialias at 2048
    across = np.clip(dist / half, 0, 1)
    profile = np.sqrt(np.clip(1 - across ** 2, 0, 1))   # round tube
    nx = np.cos(t) * ry
    ny = np.sin(t) * rx
    ln = np.hypot(nx, ny) + 1e-6
    wx, wy = (nx * ca - ny * sa) / ln, (nx * sa + ny * ca) / ln   # normal back in image space
    light = math.radians(-125)
    k = np.clip(0.5 + 0.5 * (wx * math.cos(light) + wy * math.sin(light)), 0, 1)
    val = 70 + 185 * (0.35 + 0.65 * profile) * (0.25 + 0.75 * k ** 1.4)
    val = np.clip(val + 40 * profile ** 8, 0, 255)   # thin specular line along the tube
    rgba = np.zeros((S, S, 4), np.uint8)
    rgba[..., 0] = rgba[..., 1] = rgba[..., 2] = val.astype(np.uint8)
    rgba[..., 3] = (cover * 255).astype(np.uint8)
    layer = Image.fromarray(rgba)
    pts = []
    for i in range(901):
        tt = 2 * math.pi * i / 900
        x, y = rx * math.cos(tt), ry * math.sin(tt)
        pts.append((C + x * ca - y * sa, C + x * sa + y * ca, tt))
    return layer, pts


def dot(img, x, y, r, color, glow=True):
    if glow:
        g = Image.new('RGBA', (S, S), (0, 0, 0, 0))
        ImageDraw.Draw(g).ellipse((x - r * 2.6, y - r * 2.6, x + r * 2.6, y + r * 2.6), fill=color + (150,))
        img = Image.alpha_composite(img, g.filter(ImageFilter.GaussianBlur(r * 1.1)))
    d = ImageDraw.Draw(img)
    d.ellipse((x - r, y - r, x + r, y + r), fill=color + (255,))
    # tiny specular so the sphere reads round
    d.ellipse((x - r * 0.45, y - r * 0.55, x - r * 0.05, y - r * 0.15), fill=(255, 210, 216, 190))
    return img


def main():
    os.makedirs(OUT, exist_ok=True)
    img = tile()
    rings = [orbit(0), orbit(60), orbit(-60)]
    for layer, _ in rings:
        img = Image.alpha_composite(img, layer)
    # electrons: one per orbit, at different phases
    for (layer, pts), phase in zip(rings, (0.10, 0.43, 0.77)):
        x, y, _ = pts[int(phase * (len(pts) - 1))]
        img = dot(img, x, y, 70, CRIMSON)
    # nucleus
    img = dot(img, C, C, 190, CRIMSON)
    core = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(core).ellipse((C - 70, C - 80, C + 10, C), fill=(255, 190, 198, 170))
    img = Image.alpha_composite(img, core.filter(ImageFilter.GaussianBlur(18)))

    img.resize((1024, 1024), Image.LANCZOS).save(os.path.join(OUT, 'icon-1024.png'))
    big = img.resize((256, 256), Image.LANCZOS)
    big.save(os.path.join(OUT, 'icon.png'))
    big.save(os.path.join(OUT, 'icon.ico'), sizes=[(16, 16), (20, 20), (24, 24), (32, 32), (40, 40), (48, 48), (64, 64), (128, 128), (256, 256)])
    img.resize((32, 32), Image.LANCZOS).save(os.path.join(OUT, 'tray.png'))
    # preview sheet at the sizes Windows actually shows
    sheet = Image.new('RGBA', (16 + 24 + 32 + 48 + 64 + 128 + 256 + 8 * 20, 276), (32, 32, 32, 255))
    x = 10
    for s in (16, 24, 32, 48, 64, 128, 256):
        sheet.alpha_composite(img.resize((s, s), Image.LANCZOS), (x, 266 - s))
        x += s + 20
    sheet.save(os.path.join(OUT, 'icon-sizes-preview.png'))
    print('icon written')


if __name__ == '__main__':
    main()

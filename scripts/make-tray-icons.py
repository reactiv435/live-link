"""make-tray-icons.py -> tray icons: green = filling the hype bar, gold = connected to the TikTok LIVE but nothing is
added yet (show not on / no song / test mode), grey = paused by the host, red = not watching.

Windows tray: build/tray-live.png / tray-off.png (32 px).
Mac menu bar: build/trayMac-live.png (18 px) + trayMac-live@2x.png (36 px), same for -off; Electron picks the @2x
file on Retina screens by itself.
Same atom as the app icon (make-icon.py), but the nucleus and electrons carry the connection colour.
"""
import importlib.util, os
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('mk', os.path.join(HERE, 'make-icon.py'))
mk = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mk)

def render(color):
    img = mk.tile()
    rings = [mk.orbit(0), mk.orbit(60), mk.orbit(-60)]
    for layer, _ in rings:
        img = Image.alpha_composite(img, layer)
    for (layer, pts), phase in zip(rings, (0.10, 0.43, 0.77)):
        x, y, _ = pts[int(phase * (len(pts) - 1))]
        img = mk.dot(img, x, y, 90, color)
    img = mk.dot(img, mk.C, mk.C, 240, color)      # bigger nucleus so the colour reads at 16 px
    return img

for kind, color in (('live', (34, 224, 122)), ('hold', (255, 201, 77)), ('paused', (150, 150, 150)), ('off', (224, 38, 63))):
    big = render(color)
    for name, size in ((f'tray-{kind}.png', 32), (f'trayMac-{kind}.png', 18), (f'trayMac-{kind}@2x.png', 36)):
        big.resize((size, size), Image.LANCZOS).save(os.path.join(mk.OUT, name))
        print('wrote', name)

"""make-tray-icons.py -> build/tray-live.png (green nucleus) and build/tray-off.png (red nucleus), 32 px.

Same atom as the app icon (make-icon.py), but the nucleus and electrons carry the connection colour so the tray
shows the status at a glance: green = connected to the TikTok LIVE, red = not.
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

for name, color in (('tray-live.png', (34, 224, 122)), ('tray-off.png', (224, 38, 63))):
    render(color).resize((32, 32), Image.LANCZOS).save(os.path.join(mk.OUT, name))
    print('wrote', name)

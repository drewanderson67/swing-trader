#!/usr/bin/env python3
"""Inline src/ into a single self-contained dist/index.html plus PWA files."""
import json, pathlib, re
from PIL import Image, ImageDraw

ROOT = pathlib.Path(__file__).parent
SRC, DIST = ROOT / "src", ROOT / "dist"
DIST.mkdir(exist_ok=True)

js = (SRC / "app.js").read_text()
version = re.search(r"const VERSION = '([^']+)'", js).group(1)
html = (SRC / "index.html").read_text()
html = html.replace('<link rel="stylesheet" href="style.css">', "<style>\n" + (SRC / "style.css").read_text() + "</style>")
html = html.replace('<script src="app.js"></script>', "<script>\n" + js + "</script>")
(DIST / "index.html").write_text(html)
(DIST / "sw.js").write_text((SRC / "sw.js").read_text().replace("__VERSION__", version))
(DIST / "manifest.json").write_text(json.dumps({
    "name": "SwingTrader", "short_name": "SwingTrader", "start_url": "./", "scope": "./",
    "display": "standalone", "background_color": "#0b1220", "theme_color": "#0b1220",
    "icons": [{"src": f"icon-{s}.png", "sizes": f"{s}x{s}", "type": "image/png", "purpose": "any maskable"} for s in (192, 512)],
}, indent=2))

for size in (192, 512):
    k = size / 512
    im = Image.new("RGB", (size, size), "#0b1220")
    d = ImageDraw.Draw(im)
    d.rounded_rectangle([40 * k, 40 * k, 472 * k, 472 * k], radius=90 * k, fill="#121b2e")
    pts = [(96, 340), (186, 230), (262, 300), (350, 170), (420, 240)]
    d.line([(x * k, y * k) for x, y in pts], fill="#22c55e", width=int(34 * k), joint="curve")
    for x, y in (pts[0], pts[-1]):
        r = 17 * k
        d.ellipse([x * k - r, y * k - r, x * k + r, y * k + r], fill="#22c55e")
    im.save(DIST / f"icon-{size}.png")
print(f"built dist/ v{version} ({len(html)//1024} KB)")

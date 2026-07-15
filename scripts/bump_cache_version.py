"""
Stamps a fresh cache-busting version onto every local asset URL in
index.html (style.css, app.js, data/*.js) so browsers and GitHub Pages'
CDN fetch the latest file after each deploy instead of a stale cached copy.

Run this before every commit that touches index.html, style.css, app.js,
or any data/*.js file:

    python3 scripts/bump_cache_version.py
"""
import re
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
INDEX = ROOT / "index.html"


def main():
    html = INDEX.read_text()
    version = str(int(time.time()))
    new_html = re.sub(r'(?<=\?v=)[^"]*', version, html)
    INDEX.write_text(new_html)
    print(f"Stamped cache version {version} into {INDEX}")


if __name__ == "__main__":
    main()

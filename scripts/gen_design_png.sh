#!/usr/bin/env bash
# Render assets/design.svg to a high-resolution PNG (3x the 920x448 viewBox).
#
# The README embeds the PNG rather than the SVG: GitHub sanitizes SVGs it
# renders, and design.svg carries the Antigravity mark as an embedded
# `data:image/png;base64` image that the sanitizer can drop.
#
# Requires librsvg (`brew install librsvg`).
#
# Alternative without librsvg (Windows): Microsoft Edge headless renders the SVG
# faithfully, e.g. in Git Bash:
#   msedge.exe --headless=new --disable-gpu --hide-scrollbars \n#     --force-device-scale-factor=3 --window-size=920,448 \n#     --default-background-color=FFFFFFFF \n#     --screenshot=<abs path>ssetsdesign.png "file:///<abs path>/assets/design.svg"
set -euo pipefail

cd "$(dirname "$0")/.."
rsvg-convert -w 2760 -h 1344 -b white assets/design.svg -o assets/design.png
echo "wrote assets/design.png ($(rsvg-convert --version))"

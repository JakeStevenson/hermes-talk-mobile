#!/usr/bin/env bash
# fetch-vendor.sh — download the Live2D proprietary runtime + sample model.
#
# WHY THIS EXISTS
# --------------
# The Live2D Cubism runtime (live2dcubismcore.min.js, live2d.min.js) and the
# Haru sample model are NOT open source. They are distributed under Live2D's
# Proprietary Software License Agreement and Free Material License Agreement,
# which restrict redistribution. This repo therefore does NOT vendor them —
# it downloads them from their official/community sources at setup time, so
# each user accepts Live2D's own terms when they fetch.
#
# The two MIT-licensed files (pixi.min.js, pixi-live2d-display.min.js) ARE
# vendored in client/public/vendor/ and need no download.
#
# SOURCES
# -------
# - live2dcubismcore.min.js  — official Live2D direct link (Cubism 4 core)
#   https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js
# - live2d.min.js             — Cubism 2.1 runtime; no longer on Live2D's site
#   (discontinued 2019-09-04). Mirrored at the location pixi-live2d-display
#   itself points to: https://github.com/dylanNew/live2d
# - Haru model                — official Live2D sample data, from the
#   Live2D/CubismWebSamples repo (Samples/Resources/Haru)
#
# USAGE
# -----
#   ./scripts/fetch-vendor.sh
#
# Idempotent: safe to re-run. Downloads into client/public/vendor/ and
# client/public/live2d/Haru/.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENDOR="$ROOT/client/public/vendor"
HARU="$ROOT/client/public/live2d/Haru"

CUBISM_CORE_URL="https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js"
CUBISM2_URL="https://raw.githubusercontent.com/dylanNew/live2d/master/webgl/Live2D/lib/live2d.min.js"
HARU_BASE="https://raw.githubusercontent.com/Live2D/CubismWebSamples/develop/Samples/Resources/Haru"

mkdir -p "$VENDOR" "$HARU"

echo "==> Live2D Cubism Core (Cubism 4)"
curl -fsSL "$CUBISM_CORE_URL" -o "$VENDOR/live2dcubismcore.min.js"
echo "    $(wc -c < "$VENDOR/live2dcubismcore.min.js") bytes"

echo "==> Live2D Cubism 2.1 runtime"
curl -fsSL "$CUBISM2_URL" -o "$VENDOR/live2d.min.js"
echo "    $(wc -c < "$VENDOR/live2d.min.js") bytes"

echo "==> Haru sample model"
# The full file list under Samples/Resources/Haru in Live2D/CubismWebSamples.
HARU_FILES=(
  "Haru.2048/texture_00.png"
  "Haru.2048/texture_01.png"
  "Haru.cdi3.json"
  "Haru.moc3"
  "Haru.model3.json"
  "Haru.physics3.json"
  "Haru.pose3.json"
  "Haru.userdata3.json"
  "expressions/F01.exp3.json"
  "expressions/F02.exp3.json"
  "expressions/F03.exp3.json"
  "expressions/F04.exp3.json"
  "expressions/F05.exp3.json"
  "expressions/F06.exp3.json"
  "expressions/F07.exp3.json"
  "expressions/F08.exp3.json"
  "motions/haru_g_idle.motion3.json"
  "motions/haru_g_m01.motion3.json"
  "motions/haru_g_m02.motion3.json"
  "motions/haru_g_m03.motion3.json"
  "motions/haru_g_m04.motion3.json"
  "motions/haru_g_m05.motion3.json"
  "motions/haru_g_m06.motion3.json"
  "motions/haru_g_m07.motion3.json"
  "motions/haru_g_m08.motion3.json"
  "motions/haru_g_m09.motion3.json"
  "motions/haru_g_m10.motion3.json"
  "motions/haru_g_m11.motion3.json"
  "motions/haru_g_m12.motion3.json"
  "motions/haru_g_m13.motion3.json"
  "motions/haru_g_m14.motion3.json"
  "motions/haru_g_m15.motion3.json"
  "motions/haru_g_m16.motion3.json"
  "motions/haru_g_m17.motion3.json"
  "motions/haru_g_m18.motion3.json"
  "motions/haru_g_m19.motion3.json"
  "motions/haru_g_m20.motion3.json"
  "motions/haru_g_m21.motion3.json"
  "motions/haru_g_m22.motion3.json"
  "motions/haru_g_m23.motion3.json"
  "motions/haru_g_m24.motion3.json"
  "motions/haru_g_m25.motion3.json"
  "motions/haru_g_m26.motion3.json"
  "sounds/haru_Info_04.wav"
  "sounds/haru_Info_14.wav"
  "sounds/haru_normal_6.wav"
  "sounds/haru_talk_13.wav"
)
for f in "${HARU_FILES[@]}"; do
  mkdir -p "$HARU/$(dirname "$f")"
  curl -fsSL "$HARU_BASE/$f" -o "$HARU/$f"
done
echo "    $(find "$HARU" -type f | wc -l) files"

echo ""
echo "Done. Live2D proprietary files are in place."
echo "Remember: these are Live2D's proprietary assets — see their license terms"
echo "at https://www.live2d.com/eula/ before distributing your app."

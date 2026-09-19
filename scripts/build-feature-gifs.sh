#!/usr/bin/env bash
# Render the README feature animations (HyperFrames project in
# videos/arc-feature-loops) and slice them into docs/features/*.gif.
# Each feature is a loop-safe 3s segment of the 24s composition.
set -euo pipefail
cd "$(dirname "$0")/.."

PROJECT=videos/arc-feature-loops
(cd "$PROJECT" && npx hyperframes render . -q high -o ./renders/video.mp4)

mkdir -p docs/features
i=0
for id in favorites spaces folders command-bar address-bar hide-sidebar split-view extensions-row; do
  ffmpeg -v error -y -ss $((i * 3)) -t 3 -i "$PROJECT/renders/video.mp4" \
    -filter_complex "fps=20,scale=480:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff:max_colors=160[p];[b][p]paletteuse=dither=sierra2_4a:diff_mode=rectangle" \
    -loop 0 "docs/features/$id.gif"
  i=$((i + 1))
done
echo "Wrote docs/features/*.gif"

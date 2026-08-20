#!/usr/bin/env bash
#
# IRONBOX 1.0 — generate the packaged placeholder animations.
#
#   ./tools/make-placeholder-videos.sh [output-dir]     (default: www/videos)
#
# Requires ffmpeg. The clips are generated procedurally: an original abstract
# holographic core, one per animation category. They exist so a freshly built
# APK has working default assets and so the video pipeline can be verified
# end to end. They depict no character and contain no third-party material —
# replace them with your own legally obtained videos whenever you like.
#
# Output: H.264 / yuv420p / no audio track, 480x854 (portrait), 24 fps —
# the profile documented in the README as broadly Android-compatible.
set -euo pipefail

OUT_DIR="${1:-www/videos}"
FONT="${IRONBOX_FONT:-/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf}"
WIDTH=480
HEIGHT=854
FPS=24

command -v ffmpeg >/dev/null || { echo "ffmpeg is required"; exit 1; }
mkdir -p "$OUT_DIR"

# file | seconds | ring speed | ring density | green base | blue base | label
CLIPS=(
  "idle.mp4|5|1.1|11|120|190|IDLE"
  "listening.mp4|4|2.6|8|200|170|LISTENING"
  "thinking.mp4|4|3.4|6|190|110|THINKING"
  "speaking.mp4|4|4.2|7|150|205|SPEAKING"
  "happy_01.mp4|3|3.0|9|220|180|HAPPY 01"
  "happy_02.mp4|3|3.6|12|230|150|HAPPY 02"
  "sad_01.mp4|3|0.8|14|110|200|SAD"
  "angry_01.mp4|3|5.2|5|70|90|ANGRY"
  "surprised_01.mp4|2|6.0|4|210|140|SURPRISED"
  "confused_01.mp4|3|2.2|16|170|150|CONFUSED"
  "error.mp4|2|7.0|3|60|80|ERROR"
  "sleeping.mp4|5|0.5|18|90|140|SLEEPING"
  "fallback.mp4|4|1.6|10|140|180|FALLBACK"
)

echo "Generating ${#CLIPS[@]} placeholder animations into $OUT_DIR"

for spec in "${CLIPS[@]}"; do
  IFS='|' read -r file seconds speed density green blue label <<< "$spec"

  # Ring pattern is rendered at half resolution (cheap per-pixel maths) and
  # scaled up, then labelled so it is obvious which asset is on screen.
  filter="geq=\
r='30+40*sin(hypot(X-W/2,Y-H/2)/${density}-${speed}*T)*exp(-hypot(X-W/2,Y-H/2)/220)':\
g='${green}*exp(-hypot(X-W/2,Y-H/2)/150)+40*sin(hypot(X-W/2,Y-H/2)/${density}-${speed}*T)':\
b='${blue}*exp(-hypot(X-W/2,Y-H/2)/190)+50*sin(hypot(X-W/2,Y-H/2)/${density}-${speed}*T)',\
scale=${WIDTH}:${HEIGHT}:flags=bicubic,\
vignette=PI/4"

  if [ -f "$FONT" ]; then
    filter="${filter},\
drawtext=fontfile=${FONT}:text='IRONBOX':fontcolor=white@0.85:fontsize=34:x=(w-text_w)/2:y=h*0.10,\
drawtext=fontfile=${FONT}:text='${label}':fontcolor=white@0.6:fontsize=22:x=(w-text_w)/2:y=h*0.16,\
drawtext=fontfile=${FONT}:text='placeholder asset':fontcolor=white@0.35:fontsize=16:x=(w-text_w)/2:y=h*0.88"
  fi

  ffmpeg -y -hide_banner -loglevel error \
    -f lavfi -i "color=c=black:s=$((WIDTH/2))x$((HEIGHT/2)):r=${FPS}:d=${seconds}" \
    -vf "${filter},format=yuv420p" \
    -an \
    -c:v libx264 -profile:v baseline -level 3.1 -pix_fmt yuv420p \
    -preset veryfast -crf 30 -movflags +faststart \
    "$OUT_DIR/$file"

  printf '  %-20s %s\n' "$file" "$(du -h "$OUT_DIR/$file" | cut -f1)"
done

echo "done — now run: npm run prepare:assets"

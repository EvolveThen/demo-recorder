#!/bin/sh
# Pull one frame from the rendered video just after every cursor move the
# recorder logged (out/render.log), and tile them 12 to a sheet for review.
#   sh frames.sh <name>          → out/<name>-frames/NNN-<seconds>.png + out/<name>-sheetNN.png
# Review every sheet before sending a video. A frame that shows the wrong
# page, a low scroll, a loading state or a stray toast means the scene needs
# another pass.
set -e
name="${1:?scene name, e.g. companies-and-contacts}"
here="$(cd "$(dirname "$0")" && pwd)"
FF="$here/node_modules/ffmpeg-static/ffmpeg"
video="$here/out/$name.mp4"
log="$here/out/render.log"
dir="$here/out/$name-frames"
rm -rf "$dir"; mkdir -p "$dir"
trim=$(grep -oE "trim [0-9.]+s" "$log" | head -1 | grep -oE "[0-9.]+" || true)
if [ -z "$trim" ]; then
  # Older logs: the video starts 0.4s before the first paragraph's voice.
  first=$(grep -oE "¶ 1/[0-9]+ @[0-9.]+s" "$log" | grep -oE "@[0-9.]+" | tr -d '@')
  trim=$(awk -v f="${first:-0.4}" 'BEGIN { t = f - 0.4; if (t < 0) t = 0; printf "%.3f", t }')
fi
grep -E "^      (@|♪ @)" "$log" | grep -oE "@[0-9]+\.[0-9]+s" | tr -d '@s' | sort -n | uniq | awk -v trim="$trim" '{ t = $1 + 1.2 - trim; if (t > 0) printf "%.1f\n", t }' > "$dir/times.txt"
n=0
while read -r t; do
  n=$((n+1))
  "$FF" -nostdin -v error -ss "$t" -i "$video" -frames:v 1 -y "$dir/$(printf %03d "$n")-${t}s.png" </dev/null
done < "$dir/times.txt"
ls "$dir"/*.png | sort -V | sed "s|.*|file '&'|" > "$dir/list.txt"
rm -f "$here/out/$name-sheet"*.png
"$FF" -nostdin -v error -f concat -safe 0 -r 1 -i "$dir/list.txt" -vf "scale=480:-1,tile=4x3" -start_number 1 -y "$here/out/$name-sheet%02d.png"
echo "$n frames → $(ls "$here/out/$name-sheet"*.png | wc -l | tr -d ' ') sheets in $here/out"

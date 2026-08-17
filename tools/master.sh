#!/usr/bin/env bash
#
# master.sh — take + rendered master → an upload-ready file.
#
#   tools/master.sh <take.webm> <master.wav> [lead-in-seconds] [out.webm]
#
# Does three things, in the order that matters:
#
#   1. MEASURES the master with loudnorm, then applies it in a SECOND pass
#      using those measurements. One-pass loudnorm is a dynamic filter and it
#      pumps audibly on material this quiet and this slow — which a sound bath
#      is, by construction.
#
#   2. MUXES the mastered audio over the video with `-c:v copy`, so the picture
#      is passed through untouched. No generation loss, and no re-encode of a
#      file that may be tens of gigabytes.
#
#   3. VERIFIES the result with ebur128 and prints what YouTube will see.
#
# The take's own audio is discarded. It was only ever a sync guide; the wav is
# the master.

set -euo pipefail

TAKE="${1:?usage: master.sh <take.webm> <master.wav> [lead-in] [out.webm]}"
WAV="${2:?missing master.wav}"
LEAD="${3:-0}"
OUT="${4:-${TAKE%.*}-final.webm}"

# YouTube normalises toward roughly -14 LUFS. It attenuates loud uploads but
# never lifts quiet ones, so undershooting here simply plays quiet forever.
I=-14
TP=-1
LRA=11

for f in "$TAKE" "$WAV"; do
  [ -f "$f" ] || { echo "no such file: $f" >&2; exit 1; }
done

echo "── measuring ─────────────────────────────────────────────"
MEASURE=$(ffmpeg -hide_banner -nostats -i "$WAV" \
  -af "loudnorm=I=$I:TP=$TP:LRA=$LRA:print_format=json" \
  -f null - 2>&1 | python3 -c '
import sys, json, re
text = sys.stdin.read()
# loudnorm prints its JSON block last, on stderr, after everything else.
blocks = re.findall(r"\{[^{}]*\}", text, re.S)
if not blocks:
    sys.stderr.write("loudnorm printed no JSON — is the input audio valid?\n")
    sys.exit(1)
d = json.loads(blocks[-1])
print(":".join([
    "measured_I="      + d["input_i"],
    "measured_TP="     + d["input_tp"],
    "measured_LRA="    + d["input_lra"],
    "measured_thresh=" + d["input_thresh"],
    "offset="          + d["target_offset"],
]))
print(d["input_i"], d["input_tp"], d["input_lra"], file=sys.stderr)
')

echo "   in: $(echo "$MEASURE" | tr ':' '\n' | sed 's/^/     /')"

echo "── normalising ───────────────────────────────────────────"
TMP="${OUT%.*}-mastered.wav"
ffmpeg -hide_banner -loglevel error -y -i "$WAV" \
  -af "loudnorm=I=$I:TP=$TP:LRA=$LRA:$MEASURE:linear=true" \
  -ar 48000 -c:a pcm_s24le "$TMP"

echo "── muxing ────────────────────────────────────────────────"
# -itsoffset applies to the NEXT input, delaying the master by the measured
# gap between the recorder opening and the film starting.
ffmpeg -hide_banner -loglevel error -y \
  -i "$TAKE" -itsoffset "$LEAD" -i "$TMP" \
  -map 0:v -map 1:a \
  -c:v copy -c:a libopus -b:a 320k \
  -shortest "$OUT"

echo "── verifying ─────────────────────────────────────────────"
ffmpeg -hide_banner -nostats -i "$OUT" -af ebur128=framelog=quiet -f null - 2>&1 \
  | sed -n '/Integrated loudness/,/LRA high/p' | sed 's/^/   /'

# MediaRecorder writes WebM incrementally and never finalises a duration in the
# header, so the take probes as N/A. That is expected, not damage — the muxed
# output below carries a real duration, and that is the one worth checking.
dur() {
  local d
  d=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$1" 2>/dev/null)
  if [ -z "$d" ] || [ "$d" = "N/A" ]; then
    echo "n/a (live container)"
  else
    echo "${d}s"
  fi
}
printf "\n   take   %s\n   master %s  (film + tail; trimmed to the video)\n   out    %s\n" \
  "$(dur "$TAKE")" "$(dur "$WAV")" "$(dur "$OUT")"

SIZE=$(du -h "$OUT" | cut -f1)
echo "
   → $OUT  ($SIZE)
     mastered wav kept at $TMP
"

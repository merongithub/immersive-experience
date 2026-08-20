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

I=-14
TP=-1
LRA=11

# Shared: measure a file's loudness, print the loudnorm measured_* string.
measure_loudness() {
  ffmpeg -hide_banner -nostats -i "$1" \
    -af "loudnorm=I=$I:TP=$TP:LRA=$LRA:print_format=json" \
    -f null - 2>&1 | python3 -c '
import sys, json, re
text = sys.stdin.read()
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
'
}

# ---------------------------------------------------------------- live mode
#
#   tools/master.sh --live <take.webm> [out.webm]
#
# For a take whose OWN audio is the master: anything recorded with the
# microphone in it. The offline-render path cannot carry a voice — renderFilm()
# builds its own Engine in an OfflineAudioContext and the mic lives in the live
# one — so a film with you in it is necessarily a live take, and there is no
# pristine wav to mux over the top. The take's audio is all there is, which is
# exactly what the default mode below throws away.
#
# So: normalise in place and keep the picture untouched. Same two-pass
# loudnorm, same -c:v copy, no sync offset to apply because there is only one
# clock and both streams were always on it.
if [ "${1:-}" = "--live" ]; then
  TAKE="${2:?usage: master.sh --live <take.webm> [out.webm]}"
  OUT="${3:-${TAKE%.*}-final.webm}"
  [ -f "$TAKE" ] || { echo "no such file: $TAKE" >&2; exit 1; }

  echo "── measuring (take audio) ────────────────────────────────"
  MEASURE=$(measure_loudness "$TAKE")
  echo "   in: $(echo "$MEASURE" | tr ':' '\n' | sed 's/^/     /')"

  # 256k is libopus's ceiling — it refuses anything above 256000 outright, which
# is worth knowing because this script asked for 320k for its whole life and
# that fails the encoder rather than being quietly clamped. Far beyond
# transparent for this material either way, and YouTube re-encodes regardless.
echo "── normalising + muxing ──────────────────────────────────"
  ffmpeg -hide_banner -loglevel error -y -i "$TAKE" \
    -af "loudnorm=I=$I:TP=$TP:LRA=$LRA:$MEASURE:linear=true" \
    -map 0:v -map 0:a \
    -c:v copy -c:a libopus -b:a 256k \
    "$OUT"

  echo "── verifying ─────────────────────────────────────────────"
  ffmpeg -hide_banner -nostats -i "$OUT" -af ebur128=framelog=quiet -f null - 2>&1 \
    | sed -n '/Integrated loudness/,/LRA high/p' | sed 's/^/   /'

  SIZE=$(du -h "$OUT" | cut -f1)
  echo "
   → $OUT  ($SIZE)
     picture copied through untouched; audio is the take's own, normalised
"
  exit 0
fi

TAKE="${1:?usage: master.sh <take.webm> <master.wav> [lead-in] [out.webm]
       or: master.sh --live <take.webm> [out.webm]}"
WAV="${2:?missing master.wav}"
LEAD="${3:-0}"
OUT="${4:-${TAKE%.*}-final.webm}"

# YouTube normalises toward roughly -14 LUFS. It attenuates loud uploads but
# never lifts quiet ones, so undershooting here simply plays quiet forever.
# (I/TP/LRA are set at the top, so both modes share them.)

for f in "$TAKE" "$WAV"; do
  [ -f "$f" ] || { echo "no such file: $f" >&2; exit 1; }
done

echo "── measuring ─────────────────────────────────────────────"
MEASURE=$(measure_loudness "$WAV")

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
  -c:v copy -c:a libopus -b:a 256k \
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

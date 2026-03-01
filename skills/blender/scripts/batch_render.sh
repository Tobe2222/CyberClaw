#!/bin/bash
# Batch render all Cybermons — v3 roster with expanded animals
# Usage: bash batch_render.sh /path/to/output_dir

OUT="${1:-/tmp/cybermons}"
SCRIPT="$(dirname "$0")/render_cybermon.py"
BLENDER="/snap/bin/blender"

mkdir -p "$OUT"

# Format: name animal elements mood
ROSTER=(
  "voltfox       fox       electric cyber    cute"
  "shadowcat     cat       shadow electric   fierce"
  "magmadog      dog       fire steel        playful"
  "stormbird     bird      electric fire      fierce"
  "infernofin    fish      fire shadow        angry"
  "venomsnake    snake     toxic shadow       fierce"
  "shellshock    turtle    electric steel      chill"
  "sparkhare     rabbit    electric nature     cute"
  "icedragon     dragon    ice shadow          fierce"
  "shadowolf     wolf      shadow fire         angry"
  "toxifrog      frog      toxic nature        playful"
  "nightowl      owl       shadow ice          chill"
  "duskbat       bat       shadow toxic        fierce"
  "frostbear     bear      ice steel           chill"
  "cybershark    shark     cyber steel         fierce"
  "blazehorse    horse     fire electric       fierce"
  "mosscapy      capybara  nature water        chill"
  "ironbadger    badger    steel shadow        angry"
  "frostdeer     deer      ice nature          cute"
  "glacipenguin  penguin   ice water           cute"
  "trickraccoon  raccoon   shadow electric     playful"
)

TOTAL=${#ROSTER[@]}
COUNT=0

for entry in "${ROSTER[@]}"; do
  read -r name animal el1 el2 mood <<< "$entry"
  COUNT=$((COUNT + 1))
  echo ""
  echo "[$COUNT/$TOTAL] Rendering $name ($animal + $el1/$el2, $mood)..."
  $BLENDER --background --python "$SCRIPT" -- \
    --animal "$animal" --elements "$el1" "$el2" --mood "$mood" \
    --output "$OUT/$name.png" --res 512 2>&1 | tail -3
done

echo ""
echo "=== All $TOTAL Cybermons rendered to $OUT ==="

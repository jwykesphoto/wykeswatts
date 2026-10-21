#!/bin/bash
# One-time setup script for auto-moving .zwo files to Zwift
# + auto-cleanup of stale Claude workouts from the Zwift folder
# Run this once in Terminal, then never think about it again

# Find your Zwift workouts folder (the numbered subfolder like 16435)
ZWIFT_DIR=$(find ~/Documents/Zwift/Workouts -maxdepth 2 -mindepth 1 -type d 2>/dev/null | head -1)

if [ -z "$ZWIFT_DIR" ]; then
  ZWIFT_DIR=~/Documents/Zwift/Workouts
  mkdir -p "$ZWIFT_DIR"
  echo "Created Zwift workouts folder at: $ZWIFT_DIR"
else
  echo "Found Zwift workouts folder at: $ZWIFT_DIR"
fi

PLIST_PATH=~/Library/LaunchAgents/com.cycling.zwomover.plist
SCRIPT_PATH=~/Documents/zwo_mover.sh

# Write the mover + cleanup script
cat > "$SCRIPT_PATH" << 'MOVER'
#!/bin/bash

# Find the numbered athlete subfolder (e.g. Workouts/16435/)
ZWIFT_DIR=$(find ~/Documents/Zwift/Workouts -maxdepth 2 -mindepth 1 -type d 2>/dev/null | head -1)
if [ -z "$ZWIFT_DIR" ]; then
  ZWIFT_DIR=~/Documents/Zwift/Workouts
fi

# ── 1. Move any new Claude .zwo files from Downloads into Zwift ───────────────
for f in ~/Downloads/Claude_*.zwo; do
  [ -f "$f" ] || continue
  mv "$f" "$ZWIFT_DIR/"
  echo "Moved $(basename $f) → Zwift"
done

# ── 2. Clean up stale Claude workouts ─────────────────────────────────────────
# Keep today's and tomorrow's day token. Delete everything else Claude_ prefixed.
TODAY=$(date +%a)
TOMORROW=$(date -v+1d +%a 2>/dev/null || date -d "+1 day" +%a 2>/dev/null)

for f in "$ZWIFT_DIR"/Claude_*.zwo; do
  [ -f "$f" ] || continue
  fname=$(basename "$f")
  # Filename: Claude_W07_Thu_Workout_Name.zwo — day is field 3
  day_token=$(echo "$fname" | cut -d'_' -f3)

  if [ "$day_token" = "$TODAY" ] || [ "$day_token" = "$TOMORROW" ]; then
    echo "Keeping $fname"
  else
    rm "$f"
    echo "Removed: $fname"
  fi
done
MOVER

chmod +x "$SCRIPT_PATH"
echo "Created mover+cleanup script at: $SCRIPT_PATH"

# Write the launchd plist
cat > "$PLIST_PATH" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.cycling.zwomover</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$SCRIPT_PATH</string>
  </array>
  <key>WatchPaths</key>
  <array>
    <string>$(eval echo ~/Downloads)</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
PLIST

# Reload the agent
launchctl unload "$PLIST_PATH" 2>/dev/null
launchctl load "$PLIST_PATH"

echo ""
echo "✅ Done! Run 'bash ~/Documents/zwo_mover.sh' any time to trigger manually."
echo ""
echo "To uninstall later, run:"
echo "   launchctl unload $PLIST_PATH && rm $PLIST_PATH $SCRIPT_PATH"

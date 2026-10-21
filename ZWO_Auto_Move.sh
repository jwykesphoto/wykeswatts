#!/bin/bash
# One-time setup script for auto-moving .zwo files to Zwift
# + auto-cleanup of stale Claude workouts from the Zwift folder
# Run this once in Terminal, then never think about it again

# Find your Zwift workouts folder (works even if ID varies)
ZWIFT_DIR=$(find ~/Documents/Zwift/Workouts -maxdepth 1 -mindepth 1 -type d 2>/dev/null | head -1)

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

# Find Zwift folder
ZWIFT_DIR=$(find ~/Documents/Zwift/Workouts -maxdepth 1 -mindepth 1 -type d 2>/dev/null | head -1)
if [ -z "$ZWIFT_DIR" ]; then
  ZWIFT_DIR=~/Documents/Zwift/Workouts
fi

# ── 1. Move any new .zwo files from Downloads into Zwift ─────────────────────
for f in ~/Downloads/Claude_*.zwo; do
  [ -f "$f" ] || continue
  mv "$f" "$ZWIFT_DIR/"
  echo "Moved $(basename $f) → Zwift"
done

# ── 2. Clean up stale Claude workouts from Zwift ─────────────────────────────
# Files are named: Claude_W07_Thu_Strength_Progressive_Overload.zwo
# We keep today's and tomorrow's day (in case you downloaded ahead).
# Everything else with the Claude_ prefix gets removed.

TODAY=$(date +%a)      # e.g. "Wed"
TOMORROW=$(date -v+1d +%a 2>/dev/null || date -d "+1 day" +%a 2>/dev/null)  # macOS / Linux

for f in "$ZWIFT_DIR"/Claude_*.zwo; do
  [ -f "$f" ] || continue
  fname=$(basename "$f")

  # Extract the day token from position 3 (Claude_W07_Thu_...)
  day_token=$(echo "$fname" | cut -d'_' -f3)

  if [ "$day_token" = "$TODAY" ] || [ "$day_token" = "$TOMORROW" ]; then
    echo "Keeping $fname ($day_token)"
  else
    rm "$f"
    echo "Removed stale workout: $fname"
  fi
done
MOVER

chmod +x "$SCRIPT_PATH"
echo "Created mover+cleanup script at: $SCRIPT_PATH"

# Write the launchd plist — triggers on Downloads changes AND once at login
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

# Load it (reload if already running)
launchctl unload "$PLIST_PATH" 2>/dev/null
launchctl load "$PLIST_PATH"

echo ""
echo "✅ Done! The script now:"
echo "   • Moves any Claude_*.zwo from Downloads → Zwift automatically"
echo "   • Removes Claude workouts from Zwift that aren't today's or tomorrow's"
echo "   • Runs at login and whenever your Downloads folder changes"
echo ""
echo "To uninstall later, run:"
echo "   launchctl unload $PLIST_PATH && rm $PLIST_PATH $SCRIPT_PATH"

#!/bin/bash
# Remove the WebFinder LaunchAgent (stops it starting on login).
LABEL="org.webfinder.app"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
launchctl unload "$PLIST" 2>/dev/null || true
rm -f "$PLIST"
echo "Removed $LABEL"

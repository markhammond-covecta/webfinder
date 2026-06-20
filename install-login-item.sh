#!/bin/bash
# Install WebFinder as a per-user macOS LaunchAgent so it starts on login
# (and restarts if it crashes). Re-run any time to update the configuration.
set -e

REPO="$(cd "$(dirname "$0")" && pwd)"
LABEL="org.webfinder.app"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
PORT="${PORT:-4567}"
LOG="$HOME/Library/Logs/webfinder.log"

NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then
  echo "node not found on PATH. Install Node (or 'nvm use') and re-run." >&2
  exit 1
fi
NODE_DIR="$(dirname "$NODE")"

mkdir -p "$HOME/Library/LaunchAgents"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$REPO/server.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$REPO</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PORT</key>
    <string>$PORT</string>
    <key>PATH</key>
    <string>$NODE_DIR:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$LOG</string>
  <key>StandardErrorPath</key>
  <string>$LOG</string>
</dict>
</plist>
EOF

# Stop any manually-started instance so the agent can bind the port.
pkill -f "node $REPO/server.js" 2>/dev/null || true
pkill -f "node server.js" 2>/dev/null || true

# Reload the agent.
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load -w "$PLIST"

echo "Installed $LABEL"
echo "  -> http://localhost:$PORT"
echo "  logs:  $LOG"
echo "  plist: $PLIST"
echo "It will now start automatically on login. Uninstall: ./uninstall-login-item.sh"

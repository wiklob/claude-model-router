#!/usr/bin/env bash
# install-launchd.sh — run the router as a macOS LaunchAgent (KeepAlive).
#
# Usage:  bash install-launchd.sh            # install / reinstall
#         bash install-launchd.sh --uninstall
#
# Seeds ~/.config/claude-model-router/config.json from config.example.json if
# absent (never overwrites), writes the plist, (re)bootstraps the agent, and
# probes /healthz. Logs: ~/Library/Logs/claude-model-router.log
set -euo pipefail

LABEL="com.claude-model-router"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG="${MODEL_ROUTER_CONFIG:-$HOME/.config/claude-model-router/config.json}"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/claude-model-router.log"

if [ "${1:-}" = "--uninstall" ]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "uninstalled: $LABEL (config and logs left in place)"
  exit 0
fi

NODE_BIN="$(command -v node || true)"
[ -n "$NODE_BIN" ] || { echo "install-launchd.sh: node not found in PATH"; exit 1; }

if [ ! -f "$CONFIG" ]; then
  mkdir -p "$(dirname "$CONFIG")"
  cp "$REPO/config.example.json" "$CONFIG"
  echo "seeded  $CONFIG (edit your routes there)"
fi

node "$REPO/bin/model-router.mjs" --config "$CONFIG" --check

mkdir -p "$(dirname "$PLIST")" "$(dirname "$LOG")"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$REPO/bin/model-router.mjs</string>
    <string>--config</string>
    <string>$CONFIG</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"

PORT="$(node -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String(c.listen?.port ?? 8399))' "$CONFIG")"
sleep 1
if curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
  echo "installed: $LABEL — healthy on http://127.0.0.1:$PORT (log: $LOG)"
else
  echo "installed: $LABEL — but /healthz not answering yet; check $LOG"
  exit 1
fi

#!/usr/bin/env bash
set -euo pipefail
ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [ -x "build/lumen-collect" ] && ! command -v pkg-config >/dev/null 2>&1; then
  echo "Using prebuilt build/lumen-collect…"
  touch build/lumen-collect
else
  echo "Building lumen-collect…"
  make -j"$(nproc)" collect
fi

echo "Installing into ~/.local …"
make install

mkdir -p "$HOME/.local/bin"

# Older installs used default.target + GNOME autostart (two launchers).
# Keep a single user-session unit so login/boot never double-starts it.
systemctl --user disable --now lumen-collect.service 2>/dev/null || true
rm -f "$HOME/.config/systemd/user/default.target.wants/lumen-collect.service"
rm -f "$HOME/.config/autostart/lumen-collect.desktop"

systemctl --user daemon-reload
if grep -q '^paused=1' "${XDG_CONFIG_HOME:-$HOME/.config}/lumen/collector.conf" 2>/dev/null; then
  systemctl --user disable lumen-collect.service 2>/dev/null || true
  echo
  echo "Tracking is paused. Resume from the Lumen menu to start the collector."
else
  systemctl --user enable --now lumen-collect.service
fi

echo
echo "Lumen is installed."
echo "  App:        lumen   (or search 'Lumen' in the Activities overlay)"
echo "  Collector:  systemctl --user status lumen-collect.service"
echo "  Snapshot:   lumen status"
echo
echo "Collector starts with the desktop session only (not system boot)."
echo "The UI does not run until you open Lumen."

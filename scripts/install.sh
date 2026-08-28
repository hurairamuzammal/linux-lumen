#!/usr/bin/env bash
set -euo pipefail
ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "Building lumen-collect…"
make -j"$(nproc)" collect

echo "Installing into ~/.local …"
make install

mkdir -p "$HOME/.local/bin"

# Older installs used default.target + GNOME autostart (two launchers).
# Keep a single user-session unit so login/boot never double-starts it.
systemctl --user disable --now lumen-collect.service 2>/dev/null || true
rm -f "$HOME/.config/systemd/user/default.target.wants/lumen-collect.service"
rm -f "$HOME/.config/autostart/lumen-collect.desktop"

systemctl --user daemon-reload
systemctl --user enable --now lumen-collect.service

echo
echo "Lumen is installed."
echo "  App:        lumen   (or search 'Lumen' in the Activities overlay)"
echo "  Collector:  systemctl --user status lumen-collect.service"
echo "  Snapshot:   lumen status"
echo
echo "Collector starts with the desktop session only (not system boot)."
echo "The UI does not run until you open Lumen."

# Lumen

Digital wellbeing for Zorin OS and other GNOME desktops.

A tiny C collector starts with your user session (not system boot). The GTK app opens only when you want to look. Window titles are never stored.

## Install

Needs GTK 4, libadwaita, WebKitGTK 6, GLib, AT-SPI, and a C compiler.

```bash
chmod +x scripts/install.sh scripts/lumen
./scripts/install.sh
```

Then search **Lumen** in Activities, or run `lumen`.

```bash
systemctl --user status lumen-collect.service
lumen status
```

Uninstall: `make uninstall`

## What it records

| Kept | Not kept |
|------|----------|
| Focused app name | Window titles |
| Active / idle / lock / sleep | Keystrokes |
| Battery percent | Screenshots |
| Focused-process RSS | |

Packed day files live in `~/.local/share/lumen/days/`. After about a week they roll up into monthly JSON under `months/`.

## App

- **Today / Week / Apps / Battery** — large graphs, Zorin accent colour
- **Month** — compact calendar. Tap a day to open it.
- Last **7 days** (plus today) keep full app lists and hourly lines. Older days keep totals only.
- **☰** — pause, light/dark/system, settings, data folder
- Title bar — minimize, maximize, close

Accent follows `org.gnome.desktop.interface gtk-theme` (Zorin Blue, Yellow, Green, …). Change it in Zorin Appearance; Lumen picks it up.

## Develop

```bash
make              # build collector
make test         # calendar + 7-day store tests
make install      # ~/.local
```

Run the UI from the tree with `./scripts/lumen` after install, or set `LUMEN_WEB` to `ui/web`.

## License

MIT. Bundled fonts keep their own OFL notices under `ui/web/fonts/`.

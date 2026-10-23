# Security Policy

## Security & Privacy Architecture

Lumen is designed to keep all digital wellbeing and battery telemetry strictly local and isolated to your user account:

1. **Zero Network Connectivity:** Neither `lumen-collect` nor the `lumen` GTK UI makes any outbound or inbound network connections. All fonts and assets are bundled locally.
2. **No Window Titles or Keystrokes:** `lumen-collect` queries only the top-level application name and PID via AT-SPI2, idle duration via `org.gnome.Mutter.IdleMonitor`, lock state via `org.freedesktop.login1` / `org.gnome.ScreenSaver`, and battery metrics via `/sys/class/power_supply`. Window titles, URLs, document names, clipboard contents, and keystrokes are never inspected or stored.
3. **Owner-Only Storage (`0700` / `0600`):**
   - `lumen-collect` sets `umask(0077)` at startup and creates `~/.local/share/lumen` and `~/.config/lumen` with mode `0700`.
   - Configuration and state files (`collector.conf`, `ui.json`, `current.json`, `lumen.lock`) are written with mode `0600`.
4. **Hardened Native Collector:**
   - Compiled with `-fstack-protector-strong`, `-D_FORTIFY_SOURCE=2`, `-fPIE`, and linked with `-Wl,-z,relro,-z,now -pie`.
   - Capped at `MAX_DAY_BYTES` (`3 MiB`) per day file and `MemoryMax=32M` in `systemd` with `NoNewPrivileges=yes`, `PrivateTmp=yes`, and `LockPersonality=yes`.
5. **Hardened WebKitGTK UI:**
   - `allow_universal_access_from_file_urls` and `enable_developer_extras` are disabled.
   - Navigation is locked to the local `index.html` resource via WebKit's `decide-policy` signal.
   - All dynamic strings and GTK CSS theme color tokens are sanitized before rendering.
6. **PID Verification:** Process signaling verifies `/proc/<pid>/comm` starts with `lumen-collect` before sending `SIGTERM`.

## Supported Versions

| Version | Supported |
| :--- | :--- |
| `1.0.x` | ✅ Yes |

## Reporting a Vulnerability

If you discover a security or privacy issue in Lumen, please open a private security advisory on GitHub at:
`https://github.com/hurairamuzammal/linux-lumen/security/advisories/new`

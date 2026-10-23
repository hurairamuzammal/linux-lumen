#!/usr/bin/env python3
"""Read Lumen packed day files and fold them into the dashboard payload."""

from __future__ import annotations

import json
import os
import pwd
import re
import signal
import struct
import subprocess
import time
import calendar
import base64
from collections import defaultdict
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any

ST_ACTIVE, ST_IDLE, ST_LOCK, ST_SLEEP = 0, 1, 2, 3
ST_NAMES = ("active", "idle", "lock", "sleep")
BAT_NAMES = ("discharging", "charging", "full", "ac-idle", "unknown")
HDR_SIZE = 128
KEEP_DETAILED = 8
COLLECTOR_UNIT = "lumen-collect.service"
META_APPS = {"Idle", "Lock screen", "Sleep", "Desktop"}

PRETTY = {
    "org.gnome.Nautilus": "Files",
    "org.gnome.TextEditor": "Text Editor",
    "gnome-text-editor": "Text Editor",
    "Google Chrome": "Chrome",
    "code": "VS Code",
    "cursor": "Cursor",
    "slack": "Slack",
    "ZapZap": "WhatsApp",
    "geary": "Geary",
    "firefox": "Firefox",
    "lumen_app.py": "Lumen",
    "Lumen": "Lumen",
    "gnome-terminal": "Terminal",
    "org.gnome.Terminal": "Terminal",
}


def data_dir() -> Path:
    xd = os.environ.get("XDG_DATA_HOME")
    if xd:
        return Path(xd) / "lumen"
    return Path.home() / ".local" / "share" / "lumen"


def config_dir() -> Path:
    xc = os.environ.get("XDG_CONFIG_HOME")
    if xc:
        return Path(xc) / "lumen"
    return Path.home() / ".config" / "lumen"


def collector_conf_path() -> Path:
    return config_dir() / "collector.conf"


def ui_conf_path() -> Path:
    return config_dir() / "ui.json"


def local_day(ts: int | None = None) -> str:
    return datetime.fromtimestamp(ts if ts is not None else time.time()).strftime("%Y-%m-%d")


def day_date(ymd: str) -> date:
    return datetime.strptime(ymd, "%Y-%m-%d").date()


def pretty_app(name: str) -> str:
    if not name:
        return "Unknown"
    if name in PRETTY:
        return PRETTY[name]
    if name.startswith("org.gnome."):
        return name.split(".")[-1]
    if name.islower() and "-" not in name:
        return name[:1].upper() + name[1:]
    return name


def _u32(buf: bytes, i: int) -> tuple[int, int]:
    return struct.unpack_from("<I", buf, i)[0], i + 4


def _u16(buf: bytes, i: int) -> tuple[int, int]:
    return struct.unpack_from("<H", buf, i)[0], i + 2


def parse_day_file(path: Path) -> dict[str, Any]:
    empty = {
        "first_boot": 0,
        "sleep_sec": 0,
        "intervals": [],
        "battery": [],
        "sleeps": [],
    }
    try:
        raw = path.read_bytes()
    except OSError:
        return empty
    if len(raw) < HDR_SIZE or raw[:4] != b"LMN1":
        return empty
    first_boot = struct.unpack_from("<I", raw, 8)[0]
    sleep_sec = struct.unpack_from("<I", raw, 16)[0]
    intervals: list[dict[str, Any]] = []
    battery: list[dict[str, Any]] = []
    sleeps: list[tuple[int, int]] = []
    i = HDR_SIZE
    n = len(raw)
    while i < n:
        kind = raw[i]
        i += 1
        try:
            if kind == 1:
                start, i = _u32(raw, i)
                dur, i = _u16(raw, i)
                state = raw[i]
                i += 1
                ram, i = _u32(raw, i)
                nlen = raw[i]
                i += 1
                name = raw[i : i + nlen].decode("utf-8", "replace")
                i += nlen
                intervals.append(
                    {
                        "start": start,
                        "dur": dur,
                        "end": start + dur,
                        "state": int(state),
                        "ram_kb": ram,
                        "app": name,
                    }
                )
            elif kind == 2:
                ts, i = _u32(raw, i)
                pct = raw[i]
                i += 1
                status = raw[i]
                i += 1
                mw, i = _u16(raw, i)
                battery.append(
                    {
                        "ts": ts,
                        "pct": int(pct),
                        "status": int(status),
                        "status_name": BAT_NAMES[status] if status < 5 else "unknown",
                        "power_mw": mw,
                    }
                )
            elif kind == 3:
                a, i = _u32(raw, i)
                b, i = _u32(raw, i)
                sleeps.append((a, b))
                if b > a:
                    sleep_sec += b - a
            else:
                break
        except (struct.error, IndexError):
            break
    return {
        "first_boot": first_boot,
        "sleep_sec": sleep_sec,
        "intervals": intervals,
        "battery": battery,
        "sleeps": sleeps,
    }


def summarize(parsed: dict[str, Any]) -> dict[str, Any]:
    totals = {"active": 0, "idle": 0, "lock": 0, "sleep": parsed.get("sleep_sec") or 0}
    by_app: dict[str, dict[str, Any]] = {}
    hourly = [0] * 24
    for iv in parsed.get("intervals") or []:
        st = iv["state"]
        dur = int(iv["dur"])
        if st == ST_ACTIVE:
            totals["active"] += dur
            app = iv["app"] or "Unknown"
            if app not in META_APPS:
                slot = by_app.setdefault(
                    app, {"app": app, "label": pretty_app(app), "sec": 0, "ram_peak": 0, "ram_last": 0}
                )
                slot["sec"] += dur
                ram = int(iv.get("ram_kb") or 0)
                if ram > slot["ram_peak"]:
                    slot["ram_peak"] = ram
                slot["ram_last"] = ram
            hour = datetime.fromtimestamp(iv["start"]).hour
            hourly[hour] += dur
        elif st == ST_IDLE:
            totals["idle"] += dur
        elif st == ST_LOCK:
            totals["lock"] += dur
        elif st == ST_SLEEP:
            totals["sleep"] += dur
    apps = sorted(by_app.values(), key=lambda a: a["sec"], reverse=True)
    return {"totals": totals, "apps": apps, "hourly": hourly}


def apply_live(summ: dict[str, Any], parsed: dict[str, Any], current: dict[str, Any]) -> None:
    """Add the still-open slice so totals move while you stay in one app."""
    if current.get("paused"):
        return
    start = int(current.get("slice_start") or 0)
    if start <= 0:
        return
    now = int(time.time())
    ts = int(current.get("ts") or 0)
    if ts and now - ts > 30:
        return
    live = max(0, now - start)
    names = {"active": ST_ACTIVE, "idle": ST_IDLE, "lock": ST_LOCK, "sleep": ST_SLEEP}
    st = names.get(str(current.get("state") or "active"), ST_ACTIVE)
    app = str(current.get("app") or "")
    already = 0
    for iv in reversed(parsed.get("intervals") or []):
        iv_start = iv.get("start")
        iv_state = iv.get("state")
        if iv_start is None or iv_state is None:
            continue
        if int(iv_start) == start and int(iv_state) == st:
            already = int(iv.get("dur") or 0)
            break
    extra = live - already
    if extra < 0:
        extra = 0
    if extra:
        if st == ST_ACTIVE:
            summ["totals"]["active"] += extra
            summ["hourly"][datetime.fromtimestamp(now).hour] += extra
        elif st == ST_IDLE:
            summ["totals"]["idle"] += extra
        elif st == ST_LOCK:
            summ["totals"]["lock"] += extra
        elif st == ST_SLEEP:
            summ["totals"]["sleep"] += extra
    ram = int(current.get("ram_kb") or 0)
    if st != ST_ACTIVE or not app or app in META_APPS:
        return
    slot = next((a for a in summ["apps"] if a["app"] == app), None)
    if slot is None:
        slot = {"app": app, "label": pretty_app(app), "sec": 0, "ram_peak": 0, "ram_last": 0}
        summ["apps"].append(slot)
    if extra:
        slot["sec"] += extra
    if ram:
        slot["ram_last"] = ram
        slot["ram_peak"] = max(int(slot.get("ram_peak") or 0), ram)
    summ["apps"].sort(key=lambda a: a["sec"], reverse=True)


def load_current() -> dict[str, Any]:
    path = data_dir() / "current.json"
    try:
        return json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return {}


def load_ui_conf() -> dict[str, Any]:
    path = ui_conf_path()
    try:
        data = json.loads(path.read_text())
        if isinstance(data, dict):
            return data
    except (OSError, json.JSONDecodeError):
        pass
    return {}


def _private_mkdir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        path.chmod(0o700)
    except OSError:
        pass


def _private_write_text(path: Path, content: str) -> None:
    _private_mkdir(path.parent)
    tmp = path.with_suffix(path.suffix + ".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(content)
        tmp.replace(path)
    except OSError:
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass
        raise


def save_ui_conf(data: dict[str, Any]) -> None:
    path = ui_conf_path()
    _private_write_text(path, json.dumps(data, indent=2) + "\n")


def load_collector_conf() -> dict[str, Any]:
    out = {"idle_sec": 180, "poll_sec": 8, "paused": 0}
    path = collector_conf_path()
    try:
        text = path.read_text()
    except OSError:
        return out
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        k, v = k.strip(), v.strip()
        if k in out:
            try:
                out[k] = int(v)
            except ValueError:
                pass
    out["idle_sec"] = max(30, min(3600, int(out.get("idle_sec", 180))))
    out["poll_sec"] = max(3, min(60, int(out.get("poll_sec", 8))))
    out["paused"] = 1 if out.get("paused") else 0
    return out


def save_collector_conf(data: dict[str, Any]) -> None:
    cur = load_collector_conf()
    cur.update(data)
    idle_sec = max(30, min(3600, int(cur.get("idle_sec", 180))))
    poll_sec = max(3, min(60, int(cur.get("poll_sec", 8))))
    paused = 1 if cur.get("paused") else 0
    path = collector_conf_path()
    _private_write_text(
        path,
        "# lumen collector\n"
        f"idle_sec={idle_sec}\n"
        f"poll_sec={poll_sec}\n"
        f"paused={paused}\n",
    )


def _user_systemctl(*args: str) -> bool:
    try:
        r = subprocess.run(
            ["systemctl", "--user", *args],
            capture_output=True,
            timeout=8,
            check=False,
        )
        return r.returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


def _patch_current_paused(paused: bool) -> None:
    path = data_dir() / "current.json"
    cur = load_current()
    cur["paused"] = bool(paused)
    cur["ts"] = int(time.time())
    if paused:
        cur["slice_start"] = 0
        cur["slice_sec"] = 0
    try:
        _private_write_text(path, json.dumps(cur) + "\n")
    except OSError:
        pass


def _is_collector_pid(pid: int) -> bool:
    if pid <= 0:
        return False
    proc = Path(f"/proc/{pid}")
    if not proc.exists():
        return False
    comm_file = proc / "comm"
    try:
        if comm_file.exists():
            comm = comm_file.read_text(encoding="utf-8", errors="ignore").strip()
            return comm.startswith("lumen-collect")
    except OSError:
        return False
    return True


def _stop_collector_pid() -> None:
    info = collector_alive()
    pid = int(info.get("pid") or 0)
    if not _is_collector_pid(pid):
        return
    try:
        os.kill(pid, signal.SIGTERM)
    except OSError:
        pass


def set_tracking_paused(paused: bool) -> None:
    """Stop the collector until Resume. Login must not bring it back."""
    save_collector_conf({"paused": 1 if paused else 0})
    _patch_current_paused(paused)
    if paused:
        _user_systemctl("disable", "--now", COLLECTOR_UNIT)
        if collector_alive().get("alive"):
            _stop_collector_pid()
        return
    _user_systemctl("enable", "--now", COLLECTOR_UNIT)


def default_display_name() -> str:
    gecos = pwd.getpwuid(os.getuid()).pw_gecos.split(",")[0].strip()
    if gecos:
        return gecos.split()[0]
    return os.environ.get("USER") or "there"


def collector_rss_kb(pid: int) -> int:
    try:
        with open(f"/proc/{pid}/statm", "r", encoding="utf-8") as fh:
            parts = fh.read().split()
        rss = int(parts[1])
        return rss * (os.sysconf("SC_PAGESIZE") // 1024)
    except (OSError, ValueError, IndexError):
        return 0


def collector_alive() -> dict[str, Any]:
    lock = data_dir() / "lumen.lock"
    pid = 0
    try:
        pid = int(lock.read_text().strip() or "0")
    except (OSError, ValueError):
        pid = 0
    alive = _is_collector_pid(pid)
    cur = load_current()
    if not alive:
        pid = int(cur.get("pid") or 0)
        alive = _is_collector_pid(pid)
    paused = bool(load_collector_conf().get("paused") or cur.get("paused"))
    return {
        "alive": alive,
        "pid": pid if alive else 0,
        "rss_kb": collector_rss_kb(pid) if alive else 0,
        "paused": paused,
    }


def _sysfs_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="replace").strip()
    except OSError:
        return ""


def _sysfs_int(path: Path) -> int | None:
    raw = _sysfs_text(path)
    if not raw:
        return None
    try:
        return int(raw.split()[0])
    except ValueError:
        return None


def _bat_dir() -> Path | None:
    root = Path("/sys/class/power_supply")
    if not root.is_dir():
        return None
    bats = sorted(p for p in root.iterdir() if p.name.startswith("BAT") and p.is_dir())
    return bats[0] if bats else None


def _ac_online() -> bool:
    root = Path("/sys/class/power_supply")
    if not root.is_dir():
        return False
    for p in root.iterdir():
        if not p.is_dir():
            continue
        name = p.name.upper()
        if name.startswith("BAT"):
            continue
        kind = _sysfs_text(p / "type").lower()
        if name.startswith(("AC", "ADP")) or kind == "mains":
            v = _sysfs_text(p / "online")
            if v == "1":
                return True
    return False


def _status_label(status: str, ac: bool) -> str:
    if status == "charging":
        return "Charging"
    if status == "full":
        return "Full"
    if status == "discharging":
        return "On battery"
    if status in ("ac-idle", "not charging"):
        return "Plugged in, not charging"
    if ac:
        return "Plugged in"
    return "Unknown"


def battery_snapshot(samples: list[dict[str, Any]] | None = None, current: dict[str, Any] | None = None) -> dict[str, Any]:
    """Live sysfs reading plus today's recorded samples."""
    current = current or {}
    samples = list(samples or [])
    bat = _bat_dir()
    ac = _ac_online()
    pct = _sysfs_int(bat / "capacity") if bat else None
    if pct is None:
        raw = current.get("batt")
        pct = int(raw) if raw is not None else None
    st_raw = (_sysfs_text(bat / "status") if bat else "").lower()
    if st_raw.startswith("charg"):
        status = "charging"
    elif st_raw.startswith("full"):
        status = "full"
    elif st_raw.startswith("discharg"):
        status = "discharging"
    elif st_raw.startswith("not charg"):
        status = "ac-idle"
    else:
        status = str(current.get("batt_status") or "unknown")
    energy_now = _sysfs_int(bat / "energy_now") if bat else None
    energy_full = _sysfs_int(bat / "energy_full") if bat else None
    energy_design = _sysfs_int(bat / "energy_full_design") if bat else None
    charge_now = _sysfs_int(bat / "charge_now") if bat else None
    charge_full = _sysfs_int(bat / "charge_full") if bat else None
    charge_design = _sysfs_int(bat / "charge_full_design") if bat else None
    voltage = _sysfs_int(bat / "voltage_now") if bat else None
    power = _sysfs_int(bat / "power_now") if bat else None
    current_now = _sysfs_int(bat / "current_now") if bat else None
    if power is None and current_now is not None and voltage is not None:
        power = abs(current_now) * abs(voltage) // 1_000_000
    if energy_now is None and charge_now is not None and voltage is not None:
        energy_now = charge_now * voltage // 1_000_000
    if energy_full is None and charge_full is not None and voltage is not None:
        energy_full = charge_full * voltage // 1_000_000
    if energy_design is None and charge_design is not None and voltage is not None:
        energy_design = charge_design * voltage // 1_000_000
    watts = None
    if power is not None:
        watts = round(abs(power) / 1_000_000, 1)
    elif current.get("power_mw"):
        watts = round(int(current["power_mw"]) / 1000, 1)
    voltage_v = round(voltage / 1_000_000, 2) if voltage else None
    energy_wh = round(energy_now / 1_000_000, 1) if energy_now else None
    full_wh = round(energy_full / 1_000_000, 1) if energy_full else None
    design_wh = round(energy_design / 1_000_000, 1) if energy_design else None
    health = None
    if energy_full and energy_design:
        health = max(0, min(100, round(100 * energy_full / energy_design)))
    cycles = _sysfs_int(bat / "cycle_count") if bat else None
    eta_sec = None
    eta_kind = None
    if watts and watts > 0.2:
        if status == "discharging" and energy_now:
            eta_sec = int(energy_now / abs(power) * 3600)
            eta_kind = "empty"
        elif status == "charging" and energy_now is not None and energy_full and energy_full > energy_now:
            eta_sec = int((energy_full - energy_now) / abs(power) * 3600)
            eta_kind = "full"
    pcts = [int(s.get("pct") or 0) for s in samples if s.get("pct") is not None]
    if pct is not None:
        pcts.append(int(pct))
    today_high = max(pcts) if pcts else None
    today_low = min(pcts) if pcts else None
    today_start = int(samples[0]["pct"]) if samples and samples[0].get("pct") is not None else None
    today_delta = None
    if pct is not None and today_start is not None:
        today_delta = int(pct) - today_start
    return {
        "present": bool(bat) or pct is not None,
        "name": bat.name if bat else "",
        "pct": pct,
        "status": status,
        "status_label": _status_label(status, ac),
        "ac": ac,
        "watts": watts,
        "voltage_v": voltage_v,
        "energy_wh": energy_wh,
        "full_wh": full_wh,
        "design_wh": design_wh,
        "health_pct": health,
        "cycles": cycles if cycles and cycles > 0 else None,
        "tech": _sysfs_text(bat / "technology") if bat else "",
        "model": _sysfs_text(bat / "model_name") if bat else "",
        "maker": _sysfs_text(bat / "manufacturer") if bat else "",
        "level": _sysfs_text(bat / "capacity_level") if bat else "",
        "eta_sec": eta_sec,
        "eta_kind": eta_kind,
        "today_high": today_high,
        "today_low": today_low,
        "today_start": today_start,
        "today_delta": today_delta,
        "samples_n": len(samples),
        "power_mw": int(current.get("power_mw") or (round(watts * 1000) if watts else 0)),
    }


def load_month_file(path: Path) -> dict[str, Any]:
    try:
        raw = path.read_text()
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            data, _ = json.JSONDecoder().raw_decode(raw)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def timeline_from(parsed: dict[str, Any], current: dict[str, Any]) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    boot = parsed.get("first_boot") or 0
    if boot:
        items.append({"kind": "boot", "ts": boot, "title": "First wake", "meta": "Session began"})
    for a, b in parsed.get("sleeps") or []:
        items.append(
            {
                "kind": "sleep",
                "ts": a,
                "title": "Machine sleep",
                "meta": fmt_dur(b - a) + " suspended",
            }
        )
    # Peak active hour
    hours = [0] * 24
    for iv in parsed.get("intervals") or []:
        if iv["state"] == ST_ACTIVE:
            hours[datetime.fromtimestamp(iv["start"]).hour] += iv["dur"]
    if any(hours):
        peak = max(range(24), key=lambda h: hours[h])
        items.append(
            {
                "kind": "peak",
                "ts": int(datetime.combine(date.today(), datetime.min.time()).timestamp())
                + peak * 3600,
                "title": f"Most active · {peak:02d}:00",
                "meta": fmt_dur(hours[peak]) + " this hour",
            }
        )
    st = current.get("state")
    if st:
        items.append(
            {
                "kind": "now",
                "ts": int(current.get("ts") or time.time()),
                "title": pretty_app(current.get("app") or "Desktop"),
                "meta": "On screen now" if st == "active" else st.replace("-", " ").title(),
                "live": True,
            }
        )
    items.sort(key=lambda x: x["ts"])
    return items[-8:]


def fmt_dur(sec: int) -> str:
    sec = max(0, int(round(sec)))
    h, r = divmod(sec, 3600)
    m, s = divmod(r, 60)
    if h and m:
        return f"{h}h {m}m"
    if h:
        return f"{h}h"
    if m:
        return f"{m}m"
    return f"{s}s" if s else "0m"


def spark_from_hourly(hourly: list[int]) -> list[int]:
    return list(hourly)


def build_week() -> list[dict[str, Any]]:
    days_dir = data_dir() / "days"
    out = []
    today = date.today()
    for i in range(KEEP_DETAILED - 1, -1, -1):
        d = today - timedelta(days=i)
        ymd = d.isoformat()
        parsed = parse_day_file(days_dir / f"{ymd}.lmn")
        summ = summarize(parsed)
        if ymd == today.isoformat():
            apply_live(summ, parsed, load_current())
        out.append(
            {
                "day": ymd,
                "label": d.strftime("%a"),
                "date_label": d.strftime("%-d %b"),
                "totals": summ["totals"],
                "apps": decorate_apps(summ["apps"][:12]),
                "hourly": summ["hourly"],
                "first_boot": parsed.get("first_boot") or 0,
                "battery": parsed.get("battery") or [],
                "sleeps": parsed.get("sleeps") or [],
            }
        )
    return out


def _day_stamp(summ: dict[str, Any], parsed: dict[str, Any]) -> dict[str, Any]:
    t = summ.get("totals") or {}
    return {
        "a": int(t.get("active") or 0),
        "i": int(t.get("idle") or 0),
        "l": int(t.get("lock") or 0),
        "s": int(t.get("sleep") or 0),
        "boot": int(parsed.get("first_boot") or 0),
        "apps": {a["app"]: int(a["sec"]) for a in summ.get("apps") or [] if a.get("app")},
    }


def _overlay_lmn_days(by_month: dict[str, dict[str, Any]]) -> None:
    days_dir = data_dir() / "days"
    if not days_dir.is_dir():
        return
    today = date.today().isoformat()
    live = load_current()
    for path in days_dir.glob("????-??-??.lmn"):
        ymd = path.stem
        try:
            datetime.strptime(ymd, "%Y-%m-%d")
        except ValueError:
            continue
        parsed = parse_day_file(path)
        summ = summarize(parsed)
        if ymd == today:
            apply_live(summ, parsed, live)
        key = ymd[:7]
        slot = by_month.setdefault(key, {"month": key, "days": {}})
        slot.setdefault("days", {})[ymd[8:10]] = _day_stamp(summ, parsed)


def _persist_month_files(by_month: dict[str, dict[str, Any]]) -> None:
    months_dir = data_dir() / "months"
    try:
        months_dir.mkdir(parents=True, exist_ok=True)
    except OSError:
        return
    for key, blob in by_month.items():
        incoming = blob.get("days") or {}
        if not incoming:
            continue
        path = months_dir / f"{key}.json"
        existing = load_month_file(path)
        days = dict(existing.get("days") or {})
        days.update(incoming)
        try:
            tmp = path.with_suffix(".json.tmp")
            tmp.write_text(json.dumps({"month": key, "days": days}, separators=(",", ":")))
            tmp.replace(path)
        except OSError:
            continue


def _summarize_month(key: str, days: dict[str, Any], *, icons: bool) -> dict[str, Any]:
    active = idle = lock = sleep = 0
    app_tot: dict[str, int] = defaultdict(int)
    n = 0
    day_active: dict[str, int] = {}
    day_idle: dict[str, int] = {}
    day_lock: dict[str, int] = {}
    for dd in sorted(days):
        rec = days.get(dd) or {}
        if not isinstance(rec, dict):
            continue
        a = int(rec.get("a") or 0)
        i = int(rec.get("i") or 0)
        l = int(rec.get("l") or 0)
        s = int(rec.get("s") or 0)
        day_active[dd] = a
        day_idle[dd] = i
        day_lock[dd] = l
        active += a
        idle += i
        lock += l
        sleep += s
        if a or i or l or s or rec.get("boot"):
            n += 1
        for name, sec in (rec.get("apps") or {}).items():
            app_tot[name] += int(sec)
    top = sorted(app_tot.items(), key=lambda x: x[1], reverse=True)[:8]
    return {
        "month": key,
        "label": datetime.strptime(key + "-01", "%Y-%m-%d").strftime("%B %Y"),
        "days_n": n,
        "active": active,
        "idle": idle,
        "lock": lock,
        "sleep": sleep,
        "avg_active": int(active / n) if n else 0,
        "top_apps": [
            {
                "app": a,
                "label": pretty_app(a),
                "sec": s,
                **({"icon": icon_data_uri(a)} if icons else {}),
            }
            for a, s in top
        ],
        "day_active": day_active,
        "day_idle": day_idle,
        "day_lock": day_lock,
    }


def build_months() -> list[dict[str, Any]]:
    months_dir = data_dir() / "months"
    by_month: dict[str, dict[str, Any]] = {}
    if months_dir.is_dir():
        for path in sorted(months_dir.glob("????-??.json")):
            data = load_month_file(path)
            month = data.get("month") or path.stem
            days = data.get("days") or {}
            by_month[month] = {"month": month, "days": days}

    _overlay_lmn_days(by_month)
    today_key = date.today().strftime("%Y-%m")
    by_month.setdefault(today_key, {"month": today_key, "days": {}})
    _persist_month_files(by_month)

    months = []
    for key in sorted(by_month.keys())[-12:]:
        months.append(_summarize_month(key, by_month[key].get("days") or {}, icons=True))
    return months


def desktop_icon_map() -> dict[str, str]:
    """Best-effort app id -> icon name from .desktop files (cached)."""
    cache = data_dir() / "icon-cache.json"
    now = time.time()
    cache_ver = 2
    try:
        blob = json.loads(cache.read_text())
        if blob.get("v") == cache_ver and now - float(blob.get("ts") or 0) < 3600:
            return blob.get("map") or {}
    except (OSError, json.JSONDecodeError, TypeError):
        pass
    mapping: dict[str, str] = {}
    roots = [
        Path("/usr/share/applications"),
        Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local/share") / "applications",
        Path("/var/lib/snapd/desktop/applications"),
        Path("/var/lib/flatpak/exports/share/applications"),
        Path.home() / ".local/share/flatpak/exports/share/applications",
    ]
    for root in roots:
        if not root.is_dir():
            continue
        for desk in root.glob("*.desktop"):
            try:
                text = desk.read_text(errors="ignore")
            except OSError:
                continue
            name = icon = wm = exec_ = ""
            for line in text.splitlines():
                if line.startswith("Name=") and not name:
                    name = line.split("=", 1)[1].strip()
                elif line.startswith("Icon="):
                    icon = line.split("=", 1)[1].strip()
                elif line.startswith("StartupWMClass="):
                    wm = line.split("=", 1)[1].strip()
                elif line.startswith("Exec=") and not exec_:
                    exec_ = line.split("=", 1)[1].split()[0]
            if not icon:
                continue
            keys = [desk.stem, name, wm, Path(exec_).name if exec_ else ""]
            for k in keys:
                if k:
                    mapping[k] = icon
                    mapping[k.lower()] = icon
    try:
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_text(json.dumps({"ts": now, "v": cache_ver, "map": mapping}))
    except OSError:
        pass
    return mapping


def build_state() -> dict[str, Any]:
    today = local_day()
    parsed = parse_day_file(data_dir() / "days" / f"{today}.lmn")
    summ = summarize(parsed)
    current = load_current()
    ui = load_ui_conf()
    col = load_collector_conf()
    if col.get("paused"):
        current["paused"] = True
        current["slice_start"] = 0
    apply_live(summ, parsed, current)
    batt = battery_snapshot(parsed.get("battery"), current)
    week = build_week()
    display = ui.get("display_name") or default_display_name()
    hour = datetime.now().hour
    if hour < 12:
        greet = "Good morning"
    elif hour < 18:
        greet = "Good afternoon"
    else:
        greet = "Good evening"

    most = summ["apps"][0] if summ["apps"] else None
    today_d = date.today()
    return {
        "ok": True,
        "now": int(time.time()),
        "today": today,
        "greet": greet,
        "display_name": display,
        "theme": ui.get("theme") or "system",
        "system_dark": system_prefers_dark(),
        "accent": system_colors(
            (ui.get("theme") or "system") == "dark"
            or ((ui.get("theme") or "system") != "light" and system_prefers_dark())
        ),
        "current": current,
        "collector": collector_alive(),
        "config": {
            "idle_sec": col.get("idle_sec", 180),
            "poll_sec": col.get("poll_sec", 8),
            "paused": bool(col.get("paused")),
        },
        "stats": {
            "active": summ["totals"]["active"],
            "idle": summ["totals"]["idle"],
            "lock": summ["totals"]["lock"],
            "sleep": summ["totals"]["sleep"],
            "first_boot": parsed.get("first_boot") or current.get("first_boot") or 0,
            "battery": batt.get("pct") if batt.get("pct") is not None else current.get("batt"),
            "battery_status": batt.get("status") or current.get("batt_status") or "unknown",
            "most_app": most["label"] if most else "—",
            "most_sec": most["sec"] if most else 0,
        },
        "hourly": summ["hourly"],
        "apps": decorate_apps(summ["apps"]),
        "battery": batt,
        "timeline": timeline_from(parsed, current),
        "week": week,
        "report": weekly_report(),
        "calendar": month_grid(today_d.year, today_d.month),
        "months": build_months(),
        "profile": {
            "full_name": pwd.getpwuid(os.getuid()).pw_gecos.split(",")[0].strip()
            or os.environ.get("USER"),
            "user": os.environ.get("USER") or "",
            "host": os.uname().nodename,
            "avatar": _avatar_path(),
        },
    }


def _avatar_path() -> str:
    user = os.environ.get("USER") or ""
    for p in (
        Path.home() / ".face",
        Path(f"/var/lib/AccountsService/icons/{user}"),
    ):
        if p.is_file():
            return str(p)
    return ""


def app_detail(app: str) -> dict[str, Any]:
    week = build_week()
    daily = []
    ram_peak = 0
    total = 0
    for block in week:
        sec = 0
        ram = 0
        for a in block["apps"]:
            if a["app"] == app:
                sec = a["sec"]
                ram = a.get("ram_peak") or 0
                break
        daily.append({"day": block["day"], "label": block["label"], "sec": sec})
        total += sec
        ram_peak = max(ram_peak, ram)
    days_used = sum(1 for d in daily if d["sec"])
    return {
        "ok": True,
        "app": app,
        "label": pretty_app(app),
        "week_sec": total,
        "avg_sec": int(total / 7),
        "days_used": days_used,
        "ram_peak": ram_peak,
        "daily": daily,
        "icon": icon_data_uri(app),
    }


def _gsettings_get(schema: str, key: str) -> str:
    try:
        out = subprocess.check_output(
            ["gsettings", "get", schema, key],
            text=True,
            timeout=1,
        ).strip()
        if len(out) >= 2 and out[0] in "'\"" and out[-1] == out[0]:
            out = out[1:-1]
        return out
    except Exception:
        return ""


def system_prefers_dark() -> bool:
    low = _gsettings_get("org.gnome.desktop.interface", "color-scheme").lower()
    if "prefer-dark" in low or low == "dark":
        return True
    if "prefer-light" in low or low == "light":
        return False
    return "dark" in _gsettings_get("org.gnome.desktop.interface", "gtk-theme").lower()


def _hex_rgb(value: str) -> tuple[int, int, int]:
    h = (value or "").strip()
    if h.startswith("#"):
        h = h[1:]
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    if len(h) >= 6 and re.fullmatch(r"[0-9a-fA-F]{6}", h[:6]):
        return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
    return 246, 190, 26


def _parse_gtk_named_colors(path: Path) -> dict[str, str]:
    raw: dict[str, str] = {}
    try:
        text = path.read_text(errors="ignore")[:8000]
    except OSError:
        return raw
    for name, val in re.findall(r"@define-color\s+(\w+)\s+([^;]+);", text):
        raw[name] = val.strip()
    resolved: dict[str, str] = {}

    def resolve(key: str, depth: int = 0) -> str:
        if key in resolved:
            return resolved[key]
        val = raw.get(key) or ""
        if val.startswith("@") and depth < 4:
            val = resolve(val[1:], depth + 1)
        if val.startswith("#"):
            resolved[key] = val.split()[0]
        return resolved.get(key) or val

    for key in raw:
        resolve(key)
    return resolved


def _safe_hex_color(value: str, fallback: str) -> str:
    h = (value or "").strip()
    if re.fullmatch(r"#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})", h):
        return h
    return fallback


def system_colors(want_dark: bool | None = None) -> dict[str, Any]:
    """Accent and window colors from the active Zorin/GTK theme."""
    if want_dark is None:
        want_dark = system_prefers_dark()
    theme = _gsettings_get("org.gnome.desktop.interface", "gtk-theme") or "Adwaita"
    family = theme
    for suf in ("-Light", "-Dark", "-light", "-dark"):
        if family.endswith(suf):
            family = family[: -len(suf)]
            break
    names = (
        [f"{family}-Dark", f"{family}-dark", theme]
        if want_dark
        else [f"{family}-Light", f"{family}-light", theme]
    )
    parsed: dict[str, str] = {}
    roots = (Path("/usr/share/themes"), Path.home() / ".themes")
    for name in names:
        for root in roots:
            css = root / name / "gtk-4.0" / "gtk.css"
            if not css.is_file():
                continue
            parsed = _parse_gtk_named_colors(css)
            if parsed.get("accent_bg_color") or parsed.get("accent_color"):
                break
        if parsed.get("accent_bg_color") or parsed.get("accent_color"):
            break
    accent = _safe_hex_color(parsed.get("accent_bg_color") or parsed.get("accent_color") or "", "#f6be1a")
    line = _safe_hex_color(parsed.get("accent_color") or "", accent)
    window = _safe_hex_color(parsed.get("window_bg_color") or "", "#2c281d" if want_dark else "#f6f5ea")
    fg = _safe_hex_color(parsed.get("window_fg_color") or "", "#fce8ad" if want_dark else "#565014")
    on_accent = _safe_hex_color(parsed.get("accent_fg_color") or "", "#ffffff")
    r, g, b = _hex_rgb(accent)
    return {
        "theme": theme,
        "accent": accent,
        "accent_line": line,
        "window": window,
        "fg": fg,
        "ink": fg,
        "on_accent": on_accent,
        "rgb": [r, g, b],
        "dark": want_dark,
    }


_ICON_PATH_CACHE: dict[str, str] = {}
_ICON_DATA_CACHE: dict[str, str] = {}


def _lookup_icon_gtk(name: str) -> str:
    """Use the live GTK icon theme when the UI already has a display."""
    try:
        import gi

        gi.require_version("Gtk", "4.0")
        gi.require_version("Gdk", "4.0")
        from gi.repository import Gdk, Gtk
    except Exception:
        return ""
    display = Gdk.Display.get_default()
    if not display or not name:
        return ""
    try:
        theme = Gtk.IconTheme.get_for_display(display)
        info = theme.lookup_icon(name, None, 48, 1, Gtk.TextDirection.NONE, 0)
        if not info:
            return ""
        f = info.get_file()
        path = f.get_path() if f else ""
        if path and Path(path).is_file():
            return path
    except Exception:
        return ""
    return ""


def _lookup_icon_file(name: str) -> str:
    if not name:
        return ""
    if name.startswith("/") and Path(name).is_file():
        return name
    stem = name
    for ext in (".png", ".svg", ".xpm"):
        if stem.endswith(ext):
            stem = stem[: -len(ext)]
            break
    cached = _ICON_PATH_CACHE.get(stem)
    if cached is not None:
        return cached
    found = _lookup_icon_gtk(stem) or _lookup_icon_gtk(name)
    if found:
        _ICON_PATH_CACHE[stem] = found
        return found
    found = ""
    sizes = ("48x48", "32x32", "64x64", "24x24", "128x128", "scalable", "16x16")
    subs = ("apps", "places", "devices", "categories")
    icon_roots = [
        Path("/usr/share/icons"),
        Path("/var/lib/flatpak/exports/share/icons"),
        Path.home() / ".local/share/icons",
        Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local/share") / "icons",
    ]
    preferred = ["hicolor", "Zorin", "Yaru", "Adwaita", "Papirus", "Tela-circle", "Tela-circle-light", "Humanity", "breeze"]
    themes: list[str] = []
    for root in icon_roots:
        if not root.is_dir():
            continue
        names = preferred + [p.name for p in sorted(root.iterdir()) if p.is_dir()]
        for theme in names:
            if theme in themes:
                continue
            tdir = root / theme
            if not tdir.is_dir():
                continue
            themes.append(theme)
            for sz in sizes:
                for sub in subs:
                    for ext in (".png", ".svg"):
                        p = tdir / sz / sub / f"{stem}{ext}"
                        if p.is_file():
                            found = str(p)
                            break
                    if found:
                        break
                if found:
                    break
            if found:
                break
        if found:
            break
    if not found:
        pix_dirs = (Path("/usr/share/pixmaps"), Path("/var/lib/flatpak/exports/share/icons"))
        for pix in pix_dirs:
            if not pix.is_dir():
                continue
            for ext in (".png", ".svg"):
                p = pix / f"{stem}{ext}"
                if p.is_file():
                    found = str(p)
                    break
            if found:
                break
    _ICON_PATH_CACHE[stem] = found
    return found


def icon_data_uri(app_id: str) -> str:
    if not app_id or app_id in META_APPS:
        return ""
    if app_id in _ICON_DATA_CACHE:
        return _ICON_DATA_CACHE[app_id]
    names = desktop_icon_map()
    candidates = [
        names.get(app_id) or "",
        names.get(app_id.lower()) or "",
        names.get(pretty_app(app_id)) or "",
        app_id,
        app_id.lower(),
        pretty_app(app_id).lower(),
    ]
    icon_name = next((c for c in candidates if c), app_id.lower())
    path = _lookup_icon_file(icon_name)
    if not path and "." in icon_name:
        path = _lookup_icon_file(icon_name.split(".")[-1])
    if not path:
        path = _lookup_icon_file(pretty_app(app_id).lower())
    uri = ""
    if path:
        p = Path(path)
        try:
            raw = p.read_bytes()
            if 0 < len(raw) < 250_000:
                mime = "image/svg+xml" if p.suffix.lower() == ".svg" else "image/png"
                uri = f"data:{mime};base64,{base64.b64encode(raw).decode('ascii')}"
        except OSError:
            uri = ""
    _ICON_DATA_CACHE[app_id] = uri
    return uri


def decorate_apps(apps: list[dict[str, Any]]) -> list[dict[str, Any]]:
    for a in apps:
        a["icon"] = icon_data_uri(a.get("app") or "")
    return apps


def _range_summary(start: date, end: date) -> dict[str, Any]:
    days_dir = data_dir() / "days"
    active = idle = lock = sleep = 0
    app_tot: dict[str, int] = defaultdict(int)
    peak_day = ""
    peak_sec = -1
    n = 0
    cur = start
    while cur <= end:
        ymd = cur.isoformat()
        parsed = parse_day_file(days_dir / f"{ymd}.lmn")
        summ = summarize(parsed)
        a = summ["totals"]["active"]
        if a or summ["totals"]["idle"] or parsed.get("first_boot"):
            n += 1
        active += a
        idle += summ["totals"]["idle"]
        lock += summ["totals"]["lock"]
        sleep += summ["totals"]["sleep"]
        for app in summ["apps"]:
            app_tot[app["app"]] += app["sec"]
        if a > peak_sec:
            peak_sec = a
            peak_day = ymd
        cur += timedelta(days=1)
    top = sorted(app_tot.items(), key=lambda x: x[1], reverse=True)
    top_app = ""
    top_sec = 0
    if top:
        top_app, top_sec = top[0]
    return {
        "active": active,
        "idle": idle,
        "lock": lock,
        "sleep": sleep,
        "days": n,
        "peak_day": peak_day,
        "peak_sec": max(0, peak_sec),
        "top_app": top_app,
        "top_label": pretty_app(top_app) if top_app else "—",
        "top_sec": top_sec,
        "top_icon": icon_data_uri(top_app) if top_app else "",
        "apps": [
            {"app": k, "label": pretty_app(k), "sec": v, "icon": icon_data_uri(k)}
            for k, v in top[:6]
        ],
    }


def weekly_report() -> dict[str, Any]:
    today = date.today()
    # Weeks run Monday–Sunday. The report is for the week that ends on Sunday.
    days_since_sun = (today.weekday() + 1) % 7  # 0 on Sunday
    this_sunday = today if days_since_sun == 0 else today - timedelta(days=days_since_sun)
    this_monday = this_sunday - timedelta(days=6)
    prev_sunday = this_sunday - timedelta(days=7)
    prev_monday = this_monday - timedelta(days=7)
    cur = _range_summary(this_monday, this_sunday)
    prev = _range_summary(prev_monday, prev_sunday)
    delta = 0
    if prev["active"]:
        delta = round((cur["active"] - prev["active"]) * 100 / prev["active"])
    if cur["active"] == 0:
        msg = "Still a quiet week — Lumen will write the Sunday letter once there is a full week of use."
    elif delta < -8:
        msg = (
            f"Softer week: {fmt_dur(cur['active'])} on screen, {abs(delta)}% less than last week. "
            f"{cur['top_label']} led."
        )
    elif delta > 8:
        msg = (
            f"Heavier week: {fmt_dur(cur['active'])} on screen, up {delta}% vs last week. "
            f"{cur['top_label']} took {fmt_dur(cur['top_sec'])}."
        )
    else:
        msg = (
            f"Steady week: {fmt_dur(cur['active'])} on screen, close to last week. "
            f"{cur['top_label']} stayed in front."
        )
    return {
        "is_sunday": today.weekday() == 6,
        "week_id": this_sunday.isoformat(),
        "range_label": f"{this_monday.strftime('%-d %b')} – {this_sunday.strftime('%-d %b')}",
        "message": msg,
        "delta_pct": delta,
        "current": cur,
        "previous": prev,
    }


def month_grid(year: int, month: int) -> dict[str, Any]:
    month_rows = build_months()
    months = {m["month"]: m for m in month_rows}
    key = f"{year:04d}-{month:02d}"
    rec = months.get(key) or _summarize_month(key, {}, icons=False)
    day_active = dict(rec.get("day_active") or {})
    day_idle = dict(rec.get("day_idle") or {})
    day_lock = dict(rec.get("day_lock") or {})
    for block in build_week():
        ymd = block["day"]
        if ymd.startswith(key):
            dd = ymd[8:10]
            tot = block["totals"]
            day_active[dd] = tot["active"]
            day_idle[dd] = tot["idle"]
            day_lock[dd] = tot["lock"]
    blob_days: dict[str, Any] = {}
    rec_days = (load_month_file(data_dir() / "months" / f"{key}.json").get("days") or {})
    if isinstance(rec_days, dict):
        blob_days.update(rec_days)
    for dd, active in day_active.items():
        prev = dict(blob_days.get(dd) or {})
        prev["a"] = int(active or 0)
        prev["i"] = int(day_idle.get(dd) or 0)
        prev["l"] = int(day_lock.get(dd) or 0)
        blob_days[dd] = prev
    totals = _summarize_month(key, blob_days, icons=True)
    cal = calendar.Calendar(firstweekday=0)  # Monday
    weeks = []
    today = date.today()
    cutoff = today - timedelta(days=KEEP_DETAILED - 1)
    for week in cal.monthdayscalendar(year, month):
        row = []
        for d in week:
            if not d:
                row.append(None)
                continue
            dd = f"{d:02d}"
            ymd = f"{key}-{dd}"
            cell_date = date(year, month, d)
            active = int(day_active.get(dd) or 0)
            idle = int(day_idle.get(dd) or 0)
            lock = int(day_lock.get(dd) or 0)
            day_apps = []
            rec_apps = (blob_days.get(dd) or {}).get("apps") or {}
            if rec_apps:
                for app_name, sec in sorted(rec_apps.items(), key=lambda x: x[1], reverse=True)[:6]:
                    day_apps.append(
                        {
                            "app": app_name,
                            "label": pretty_app(app_name),
                            "sec": int(sec),
                            "icon": icon_data_uri(app_name),
                        }
                    )
            row.append(
                {
                    "d": d,
                    "ymd": ymd,
                    "active": active,
                    "idle": idle,
                    "lock": lock,
                    "is_today": cell_date == today,
                    "future": cell_date > today,
                    "recent": cutoff <= cell_date <= today,
                    "has_data": bool(active or idle or lock),
                    "apps": day_apps,
                }
            )
        weeks.append(row)
    known = sorted(m["month"] for m in month_rows if m.get("days_n") or m.get("active"))
    if today.strftime("%Y-%m") not in known:
        known.append(today.strftime("%Y-%m"))
        known.sort()
    return {
        "month": key,
        "label": date(year, month, 1).strftime("%B %Y"),
        "year": year,
        "month_n": month,
        "weeks": weeks,
        "totals": totals,
        "max_active": max([int(v) for v in day_active.values()] or [1]),
        "keep_days": KEEP_DETAILED,
        "has_prev": bool(known) and key > known[0],
        "has_next": (year, month) < (today.year, today.month),
    }


def _month_day_record(ymd: str) -> dict[str, Any]:
    rec = (load_month_file(data_dir() / "months" / f"{ymd[:7]}.json").get("days") or {}).get(
        ymd[8:10]
    )
    return rec if isinstance(rec, dict) else {}


def _day_bundle(day: date) -> dict[str, Any]:
    ymd = day.isoformat()
    parsed = parse_day_file(data_dir() / "days" / f"{ymd}.lmn")
    summ = summarize(parsed)
    if ymd == date.today().isoformat():
        apply_live(summ, parsed, load_current())
    detailed = bool(parsed.get("intervals"))
    if not detailed:
        coarse = _month_day_record(ymd)
        if coarse:
            summ["totals"] = {
                "active": int(coarse.get("a") or 0),
                "idle": int(coarse.get("i") or 0),
                "lock": int(coarse.get("l") or 0),
                "sleep": int(coarse.get("s") or 0),
            }
            apps = []
            for name, sec in (coarse.get("apps") or {}).items():
                apps.append(
                    {
                        "app": name,
                        "label": pretty_app(name),
                        "sec": int(sec),
                        "ram_peak": 0,
                        "ram_last": 0,
                    }
                )
            apps.sort(key=lambda a: a["sec"], reverse=True)
            summ["apps"] = apps
            parsed["first_boot"] = int(coarse.get("boot") or 0)
    return {"ymd": ymd, "parsed": parsed, "summ": summ, "detailed": detailed}


def week_usage_around(day: date) -> dict[str, Any]:
    monday = day - timedelta(days=day.weekday())
    sunday = monday + timedelta(days=6)
    today = date.today()
    active = idle = lock = 0
    days: list[dict[str, Any]] = []
    cur = monday
    while cur <= sunday:
        future = cur > today
        tot = {"active": 0, "idle": 0, "lock": 0}
        if not future:
            tot = _day_bundle(cur)["summ"]["totals"]
            active += int(tot.get("active") or 0)
            idle += int(tot.get("idle") or 0)
            lock += int(tot.get("lock") or 0)
        days.append(
            {
                "ymd": cur.isoformat(),
                "label": cur.strftime("%a"),
                "d": cur.day,
                "active": int(tot.get("active") or 0),
                "idle": int(tot.get("idle") or 0),
                "lock": int(tot.get("lock") or 0),
                "future": future,
                "is_sel": cur == day,
            }
        )
        cur += timedelta(days=1)
    return {
        "active": active,
        "idle": idle,
        "lock": lock,
        "range_label": f"{monday.strftime('%-d %b')} – {sunday.strftime('%-d %b')}",
        "days": days,
    }


def _public_apps(apps: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out = []
    for a in apps or []:
        out.append(
            {
                "app": a.get("app") or "",
                "label": a.get("label") or pretty_app(a.get("app") or ""),
                "sec": int(a.get("sec") or 0),
                "ram_peak": int(a.get("ram_peak") or 0),
                "ram_last": int(a.get("ram_last") or 0),
            }
        )
    return out


def day_detail(ymd: str) -> dict[str, Any]:
    try:
        day = datetime.strptime(ymd, "%Y-%m-%d").date()
    except ValueError:
        return {"ok": False, "reason": "invalid"}
    if day > date.today():
        return {"ok": False, "reason": "future"}
    age = (date.today() - day).days
    bundle = _day_bundle(day)
    parsed = bundle["parsed"]
    summ = bundle["summ"]
    week = week_usage_around(day)
    return {
        "ok": True,
        "day": ymd,
        "label": day.strftime("%A %-d %B"),
        "age_days": age,
        "recent": age < KEEP_DETAILED,
        "detailed": bundle["detailed"],
        "totals": summ["totals"],
        "week_active": week["active"],
        "week_idle": week["idle"],
        "week_lock": week["lock"],
        "week_label": week["range_label"],
        "week_days": week["days"],
        "prev_day": (day - timedelta(days=1)).isoformat(),
        "next_day": (day + timedelta(days=1)).isoformat() if day < date.today() else "",
        "apps": _public_apps(summ["apps"]),
        "hourly": summ["hourly"],
        "first_boot": parsed.get("first_boot") or 0,
        "empty": not (
            summ["totals"]["active"]
            or summ["totals"]["idle"]
            or summ["totals"]["lock"]
            or summ["totals"]["sleep"]
        ),
    }

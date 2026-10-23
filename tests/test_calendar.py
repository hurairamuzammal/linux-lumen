#!/usr/bin/env python3
"""Calendar and 7-day detail tests. No live GTK required."""

from __future__ import annotations

import json
import os
import struct
import sys
import tempfile
import unittest
from datetime import date, datetime, timedelta, time as dtime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "ui"))

import lumen_store as store  # noqa: E402

HDR = 128
ST_ACTIVE, ST_IDLE, ST_LOCK = 0, 1, 2


def write_lmn(path: Path, first_boot: int, intervals: list[tuple[int, int, int, int, str]]) -> None:
    buf = bytearray(HDR)
    buf[0:4] = b"LMN1"
    struct.pack_into("<I", buf, 8, first_boot)
    body = bytearray()
    for start, dur, state, ram, name in intervals:
        raw = name.encode("utf-8")[:47]
        body.append(1)
        body += struct.pack("<I", start)
        body += struct.pack("<H", dur)
        body.append(state)
        body += struct.pack("<I", ram)
        body.append(len(raw))
        body += raw
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(bytes(buf) + bytes(body))


class CalendarTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        os.environ["XDG_DATA_HOME"] = self.tmp.name
        store._ICON_DATA_CACHE.clear()
        store._ICON_PATH_CACHE.clear()
        self.days = store.data_dir() / "days"
        self.days.mkdir(parents=True)
        self.today = date.today()

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _ts(self, day: date, hour: int = 10) -> int:
        return int(datetime.combine(day, dtime(hour=hour)).timestamp())

    def test_fmt_dur_promotes_minutes_to_hours(self) -> None:
        self.assertEqual(store.fmt_dur(66 * 60), "1h 6m")
        self.assertEqual(store.fmt_dur(90 * 60), "1h 30m")
        self.assertEqual(store.fmt_dur(45 * 60), "45m")
        self.assertEqual(store.fmt_dur(3600), "1h")

    def test_invalid_and_future_days_rejected(self) -> None:
        self.assertFalse(store.day_detail("not-a-date")["ok"])
        future = (self.today + timedelta(days=2)).isoformat()
        self.assertFalse(store.day_detail(future)["ok"])
        self.assertEqual(store.day_detail(future).get("reason"), "future")

    def test_seven_days_of_lmn_files_open_with_apps_and_hours(self) -> None:
        for age in range(8):
            day = self.today - timedelta(days=age)
            start = self._ts(day, 9)
            write_lmn(
                self.days / f"{day.isoformat()}.lmn",
                start,
                [
                    (start, 66 * 60, ST_ACTIVE, 12000, "cursor"),
                    (start + 66 * 60, 600, ST_IDLE, 0, ""),
                    (start + 66 * 60 + 600, 120, ST_LOCK, 0, ""),
                ],
            )
        grid = store.month_grid(self.today.year, self.today.month)
        recent = [c for row in grid["weeks"] for c in row if c and c.get("recent")]
        expected = sum(
            1
            for age in range(store.KEEP_DETAILED)
            if (self.today - timedelta(days=age)).month == self.today.month
            and (self.today - timedelta(days=age)).year == self.today.year
        )
        self.assertEqual(len(recent), expected)
        oldest = self.today - timedelta(days=7)
        detail = store.day_detail(oldest.isoformat())
        self.assertTrue(detail["ok"])
        self.assertTrue(detail["detailed"])
        self.assertTrue(detail["recent"])
        self.assertEqual(detail["age_days"], 7)
        self.assertEqual(detail["totals"]["active"], 66 * 60)
        self.assertEqual(detail["apps"][0]["app"], "cursor")
        self.assertNotIn("icon", detail["apps"][0])
        self.assertLess(len(json.dumps(detail)), 80_000)
        self.assertEqual(sum(detail["hourly"]), 66 * 60)
        today_cell = next(c for c in recent if c["is_today"])
        self.assertGreater(today_cell["active"], 0)
        self.assertEqual(today_cell["idle"], 600)
        self.assertEqual(today_cell["lock"], 120)
        self.assertTrue(today_cell["has_data"])
        today_open = store.day_detail(self.today.isoformat())
        self.assertGreaterEqual(today_open["week_active"], 66 * 60)
        self.assertGreaterEqual(today_open["week_idle"], 600)

    def test_calendar_click_payload_matches_day_detail(self) -> None:
        day = self.today - timedelta(days=3)
        start = self._ts(day, 14)
        write_lmn(
            self.days / f"{day.isoformat()}.lmn",
            start,
            [(start, 1800, ST_ACTIVE, 8000, "firefox")],
        )
        grid = store.month_grid(self.today.year, self.today.month)
        cell = None
        for row in grid["weeks"]:
            for c in row:
                if c and c["ymd"] == day.isoformat():
                    cell = c
        self.assertIsNotNone(cell)
        self.assertFalse(cell["future"])
        self.assertTrue(cell["recent"])
        opened = store.day_detail(cell["ymd"])
        self.assertTrue(opened["ok"])
        self.assertEqual(opened["apps"][0]["label"], "Firefox")
        self.assertEqual(opened["totals"]["active"], 1800)
        self.assertGreaterEqual(opened["week_active"], 1800)
        self.assertTrue(opened["week_label"])
        self.assertEqual(len(opened["week_days"]), 7)
        self.assertTrue(opened["prev_day"])

    def test_coarse_month_rollup_for_older_days(self) -> None:
        old = self.today - timedelta(days=20)
        months = store.data_dir() / "months"
        months.mkdir(parents=True)
        key = old.strftime("%Y-%m")
        (months / f"{key}.json").write_text(
            json.dumps(
                {
                    "month": key,
                    "days": {
                        f"{old.day:02d}": {
                            "a": 5400,
                            "i": 120,
                            "l": 0,
                            "s": 0,
                            "boot": 1,
                            "apps": {"slack": 5400},
                        }
                    },
                }
            )
        )
        detail = store.day_detail(old.isoformat())
        self.assertTrue(detail["ok"])
        self.assertFalse(detail["detailed"])
        self.assertFalse(detail["recent"])
        self.assertEqual(detail["totals"]["active"], 5400)
        self.assertEqual(detail["apps"][0]["app"], "slack")
        self.assertGreaterEqual(detail["week_active"], 5400)

    def test_empty_recent_day_still_opens(self) -> None:
        empty = (self.today - timedelta(days=1)).isoformat()
        detail = store.day_detail(empty)
        self.assertTrue(detail["ok"])
        self.assertTrue(detail["empty"])
        self.assertTrue(detail["recent"])

    def test_previous_month_keeps_totals_avg_and_days(self) -> None:
        prev = date(self.today.year, self.today.month, 1) - timedelta(days=1)
        older = prev - timedelta(days=1)
        for day, active, idle in ((older, 3600, 600), (prev, 7200, 1200)):
            start = self._ts(day, 11)
            write_lmn(
                self.days / f"{day.isoformat()}.lmn",
                start,
                [(start, active, ST_ACTIVE, 4000, "firefox"), (start + active, idle, ST_IDLE, 0, "")],
            )
        grid = store.month_grid(prev.year, prev.month)
        self.assertEqual(grid["totals"]["active"], 10800)
        self.assertEqual(grid["totals"]["idle"], 1800)
        self.assertEqual(grid["totals"]["days_n"], 2)
        self.assertEqual(grid["totals"]["avg_active"], 5400)
        cell = next(
            c
            for row in grid["weeks"]
            for c in row
            if c and c["ymd"] == prev.isoformat()
        )
        self.assertEqual(cell["active"], 7200)
        self.assertTrue(cell["has_data"])
        saved = store.load_month_file(store.data_dir() / "months" / f"{prev.strftime('%Y-%m')}.json")
        self.assertEqual(int(saved["days"][f"{prev.day:02d}"]["a"]), 7200)
        cur = store.month_grid(self.today.year, self.today.month)
        self.assertTrue(cur["has_prev"])
        self.assertFalse(cur["has_next"])
        self.assertTrue(grid["has_next"])
        self.assertFalse(grid["has_prev"])


        grid = store.month_grid(self.today.year, self.today.month)
        for row in grid["weeks"]:
            self.assertEqual(len(row), 7)
        future = [c for row in grid["weeks"] for c in row if c and c["future"]]
        for c in future:
            self.assertGreater(date.fromisoformat(c["ymd"]), self.today)


if __name__ == "__main__":
    unittest.main()

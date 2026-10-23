#!/usr/bin/env python3
"""Live slice fold: open interval seconds must appear without double-counting."""

from __future__ import annotations

import os
import struct
import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "ui"))

import lumen_store as store  # noqa: E402

HDR = 128
ST_ACTIVE = 0


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


class ApplyLiveTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        os.environ["XDG_DATA_HOME"] = self.tmp.name
        self.days = store.data_dir() / "days"
        self.days.mkdir(parents=True)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _summ(self, start: int, dur: int, app: str) -> tuple[dict, dict]:
        path = self.days / "live.lmn"
        write_lmn(path, start, [(start, dur, ST_ACTIVE, 4000, app)])
        parsed = store.parse_day_file(path)
        return parsed, store.summarize(parsed)

    def test_adds_seconds_not_yet_flushed(self) -> None:
        start = int(time.time()) - 20
        parsed, summ = self._summ(start, 8, "cursor")
        self.assertEqual(summ["totals"]["active"], 8)
        store.apply_live(
            summ,
            parsed,
            {
                "ts": int(time.time()),
                "slice_start": start,
                "state": "active",
                "app": "cursor",
            },
        )
        extra_active = summ["totals"]["active"]
        self.assertGreaterEqual(extra_active, 19)
        self.assertLessEqual(extra_active, 22)
        self.assertEqual(summ["apps"][0]["app"], "cursor")
        self.assertGreaterEqual(summ["apps"][0]["sec"], 19)

    def test_does_not_double_count_file_interval(self) -> None:
        start = int(time.time()) - 10
        parsed, summ = self._summ(start, 10, "firefox")
        store.apply_live(
            summ,
            parsed,
            {
                "ts": int(time.time()),
                "slice_start": start,
                "state": "active",
                "app": "firefox",
            },
        )
        self.assertGreaterEqual(summ["totals"]["active"], 10)
        self.assertLessEqual(summ["totals"]["active"], 12)

    def test_skips_desktop_meta_from_app_list(self) -> None:
        start = int(time.time()) - 15
        parsed, summ = self._summ(start, 4, "cursor")
        store.apply_live(
            summ,
            parsed,
            {
                "ts": int(time.time()),
                "slice_start": start,
                "state": "active",
                "app": "Desktop",
            },
        )
        names = [a["app"] for a in summ["apps"]]
        self.assertNotIn("Desktop", names)
        self.assertGreater(summ["totals"]["active"], 4)

    def test_paused_or_stale_current_is_ignored(self) -> None:
        start = int(time.time()) - 40
        parsed, summ = self._summ(start, 5, "slack")
        store.apply_live(
            summ,
            parsed,
            {
                "ts": int(time.time()),
                "slice_start": start,
                "state": "active",
                "app": "slack",
                "paused": True,
            },
        )
        self.assertEqual(summ["totals"]["active"], 5)
        store.apply_live(
            summ,
            parsed,
            {
                "ts": int(time.time()) - 60,
                "slice_start": start,
                "state": "active",
                "app": "slack",
            },
        )
        self.assertEqual(summ["totals"]["active"], 5)


if __name__ == "__main__":
    unittest.main()

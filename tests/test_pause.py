#!/usr/bin/env python3
"""Pause must stop the collector unit until resume."""

from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "ui"))

import lumen_store as store  # noqa: E402


class PauseTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        os.environ["XDG_DATA_HOME"] = self.tmp.name
        os.environ["XDG_CONFIG_HOME"] = str(Path(self.tmp.name) / "cfg")

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_pause_stops_and_disables_unit(self) -> None:
        calls: list[tuple[str, ...]] = []

        def fake_ctl(*args: str) -> bool:
            calls.append(args)
            return True

        with mock.patch.object(store, "_user_systemctl", side_effect=fake_ctl):
            with mock.patch.object(store, "collector_alive", return_value={"alive": False, "pid": 0}):
                store.set_tracking_paused(True)
        self.assertEqual(store.load_collector_conf()["paused"], 1)
        self.assertIn(("disable", "--now", store.COLLECTOR_UNIT), calls)
        self.assertNotIn(("enable", "--now", store.COLLECTOR_UNIT), calls)
        self.assertTrue(store.load_current().get("paused"))
        self.assertEqual(store.load_current().get("slice_start"), 0)

    def test_resume_enables_and_starts_unit(self) -> None:
        store.save_collector_conf({"paused": 1})
        calls: list[tuple[str, ...]] = []

        def fake_ctl(*args: str) -> bool:
            calls.append(args)
            return True

        with mock.patch.object(store, "_user_systemctl", side_effect=fake_ctl):
            store.set_tracking_paused(False)
        self.assertEqual(store.load_collector_conf()["paused"], 0)
        self.assertIn(("enable", "--now", store.COLLECTOR_UNIT), calls)
        self.assertFalse(store.load_current().get("paused"))

    def test_private_file_permissions_and_clamping(self) -> None:
        store.save_collector_conf({"idle_sec": 5, "poll_sec": 999, "paused": 0})
        conf = store.load_collector_conf()
        self.assertEqual(conf["idle_sec"], 30)
        self.assertEqual(conf["poll_sec"], 60)
        mode = store.collector_conf_path().stat().st_mode & 0o777
        self.assertEqual(mode, 0o600)

    def test_recycled_pid_is_not_killed(self) -> None:
        # Current Python test runner PID is alive in /proc/<pid>, but comm != 'lumen-collect'
        my_pid = os.getpid()
        self.assertFalse(store._is_collector_pid(my_pid))
        with mock.patch("os.kill") as kill_mock:
            with mock.patch.object(store, "collector_alive", return_value={"alive": True, "pid": my_pid}):
                store._stop_collector_pid()
            kill_mock.assert_not_called()

    def test_safe_hex_color_rejects_css_injection(self) -> None:
        self.assertEqual(store._safe_hex_color("#1a2b3c", "#000000"), "#1a2b3c")
        self.assertEqual(store._safe_hex_color("#fff", "#000000"), "#fff")
        self.assertEqual(store._safe_hex_color("red; } * { display: none;", "#f6be1a"), "#f6be1a")


if __name__ == "__main__":
    unittest.main()

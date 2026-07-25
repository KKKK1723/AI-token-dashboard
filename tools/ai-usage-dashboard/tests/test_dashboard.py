from __future__ import annotations

import sqlite3
import sys
import tempfile
import unittest
import xml.etree.ElementTree as element_tree
from contextlib import closing
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path


PROJECT_DIRECTORY = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_DIRECTORY / "src"))

from ai_usage_dashboard.data import ModelUsage, UsageSnapshot, load_usage_snapshot
from ai_usage_dashboard.render import format_cost, format_tokens, render_svg, write_dashboard_assets


CST = timezone(timedelta(hours=8), name="CST")


class UsageDataTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.database = Path(self.temporary_directory.name) / "usage.db"
        with closing(sqlite3.connect(self.database)) as connection:
            connection.execute(
                """
                CREATE TABLE proxy_request_logs (
                    model TEXT,
                    input_tokens INTEGER NOT NULL,
                    output_tokens INTEGER NOT NULL,
                    cache_read_tokens INTEGER NOT NULL,
                    cache_creation_tokens INTEGER NOT NULL,
                    total_cost_usd TEXT NOT NULL,
                    created_at INTEGER NOT NULL
                )
                """
            )
            connection.commit()

    def tearDown(self) -> None:
        self.temporary_directory.cleanup()

    def insert_usage(
        self,
        model: str,
        tokens: tuple[int, int, int, int],
        cost: str,
        created_at: datetime,
    ) -> None:
        with closing(sqlite3.connect(self.database)) as connection:
            connection.execute(
                "INSERT INTO proxy_request_logs VALUES (?, ?, ?, ?, ?, ?, ?)",
                (model, *tokens, cost, int(created_at.timestamp())),
            )
            connection.commit()

    def test_uses_today_and_previous_29_calendar_days(self) -> None:
        now = datetime(2026, 7, 25, 15, 10, tzinfo=CST)
        start = datetime(2026, 6, 26, 0, 0, tzinfo=CST)
        self.insert_usage("alpha", (100, 20, 30, 0), "0.10", start)
        self.insert_usage("beta", (100, 20, 400, 10), "1.25", now - timedelta(days=2))
        self.insert_usage("alpha", (50, 5, 0, 0), "0.20", now - timedelta(minutes=1))
        self.insert_usage("excluded-old", (9999, 0, 0, 0), "9", start - timedelta(seconds=1))
        self.insert_usage("excluded-future", (9999, 0, 0, 0), "9", now + timedelta(seconds=1))

        snapshot = load_usage_snapshot(
            self.database,
            now=now,
            days=30,
            timezone_name="Asia/Shanghai",
            retries=1,
        )

        self.assertEqual(snapshot.window_start, start)
        self.assertEqual(snapshot.window_end, now)
        self.assertEqual(snapshot.requests, 3)
        self.assertEqual(snapshot.total_tokens, 735)
        self.assertEqual(snapshot.cost_usd, Decimal("1.55"))
        self.assertEqual([model.name for model in snapshot.models], ["beta", "alpha"])
        self.assertEqual(snapshot.data_through, now - timedelta(minutes=1))


class SvgRenderingTests(unittest.TestCase):
    def make_snapshot(self) -> UsageSnapshot:
        now = datetime(2026, 7, 25, 15, 10, tzinfo=CST)
        return UsageSnapshot(
            window_start=datetime(2026, 6, 26, 0, 0, tzinfo=CST),
            window_end=now,
            generated_at=now,
            data_through=now,
            requests=12,
            input_tokens=1_000_000_000,
            output_tokens=50_000_000,
            cache_read_tokens=500_000_000,
            cache_creation_tokens=10_000_000,
            cost_usd=Decimal("12.345"),
            models=(
                ModelUsage("model<&one", 8, 800_000_000, 0, 300_000_000, 0, Decimal("10")),
                ModelUsage("model-two", 4, 200_000_000, 50_000_000, 200_000_000, 10_000_000, Decimal("2.345")),
            ),
        )

    def test_svg_is_valid_fixed_size_and_escaped(self) -> None:
        svg = render_svg(self.make_snapshot(), "light")
        root = element_tree.fromstring(svg)
        self.assertEqual(root.attrib["width"], "500")
        self.assertEqual(root.attrib["height"], "300")
        self.assertIn("model&lt;&amp;one", svg)
        self.assertIn("LAST 30 DAYS", svg)

    def test_writes_both_themes(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            light, dark = write_dashboard_assets(self.make_snapshot(), Path(directory))
            self.assertTrue(light.is_file())
            self.assertTrue(dark.is_file())
            self.assertIn("#ffffff", light.read_text(encoding="utf-8"))
            self.assertIn("#0d1117", dark.read_text(encoding="utf-8"))

    def test_number_formatting(self) -> None:
        self.assertEqual(format_tokens(1_672_905_975), "1.673B")
        self.assertEqual(format_cost(Decimal("971.527")), "$971.53")


if __name__ == "__main__":
    unittest.main()

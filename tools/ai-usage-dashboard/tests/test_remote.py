from __future__ import annotations

import json
import sys
import tempfile
import unittest
from decimal import Decimal
from pathlib import Path


PROJECT_DIRECTORY = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_DIRECTORY / "src"))

from ai_usage_dashboard.data import UsageDataError
from ai_usage_dashboard.remote import load_remote_snapshot


class RemoteSnapshotTests(unittest.TestCase):
    def make_value(self) -> dict[str, object]:
        return {
            "schemaVersion": 1,
            "windowStartDate": "2026-06-29",
            "windowEndDate": "2026-07-28",
            "generatedAt": "2026-07-28T03:10:00+08:00",
            "dataThrough": "2026-07-28T02:00:00+08:00",
            "requests": 3,
            "inputTokens": 15,
            "outputTokens": 30,
            "cacheReadTokens": 45,
            "cacheCreationTokens": 0,
            "costUsd": "0.1875",
            "totalTokens": 90,
            "models": [
                {
                    "name": "gpt-5.6-sol",
                    "requests": 3,
                    "inputTokens": 15,
                    "outputTokens": 30,
                    "cacheReadTokens": 45,
                    "cacheCreationTokens": 0,
                    "costUsd": "0.1875",
                    "totalTokens": 90,
                }
            ],
        }

    def test_loads_canonical_remote_summary(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "summary.json"
            path.write_text(json.dumps(self.make_value()), encoding="utf-8")
            snapshot = load_remote_snapshot(path)
        self.assertEqual(snapshot.requests, 3)
        self.assertEqual(snapshot.total_tokens, 90)
        self.assertEqual(snapshot.cost_usd, Decimal("0.1875"))
        self.assertEqual(snapshot.models[0].name, "gpt-5.6-sol")

    def test_rejects_inconsistent_totals(self) -> None:
        value = self.make_value()
        value["requests"] = 4
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "summary.json"
            path.write_text(json.dumps(value), encoding="utf-8")
            with self.assertRaises(UsageDataError):
                load_remote_snapshot(path)


if __name__ == "__main__":
    unittest.main()

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
import tempfile
from collections import defaultdict
from contextlib import closing
from datetime import datetime, time, timedelta, timezone
from decimal import Decimal
from pathlib import Path


PROJECT_DIRECTORY = Path(__file__).resolve().parent
sys.path.insert(0, str(PROJECT_DIRECTORY / "src"))

from ai_usage_dashboard.data import (  # noqa: E402
    UsageDataError,
    _decimal_cost,
    _fresh_input_tokens,
    _nonnegative_int,
    resolve_timezone,
)


PICOS_PER_USD = Decimal("1000000000000")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Export a one-time CCSwitch migration seed for the sync CLI."
    )
    parser.add_argument(
        "--database",
        type=Path,
        default=Path.home() / ".cc-switch" / "cc-switch.db",
    )
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--days", type=int, default=45)
    parser.add_argument("--timezone", default="Asia/Shanghai")
    parser.add_argument("--now", help="Override the ISO-8601 cutoff time")
    parser.add_argument(
        "--settle-seconds",
        type=int,
        default=120,
        help="Lag the automatic cutoff so CCSwitch can finish its last import (default: 120)",
    )
    return parser


def _atomic_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            json.dump(value, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
        os.replace(temporary, path)
    except Exception:
        temporary.unlink(missing_ok=True)
        raise


def main(argv: list[str] | None = None) -> int:
    arguments = build_parser().parse_args(argv)
    if arguments.days < 1:
        print("error: days must be at least 1", file=sys.stderr)
        return 1
    if arguments.settle_seconds < 0:
        print("error: settle-seconds cannot be negative", file=sys.stderr)
        return 1
    target_timezone = resolve_timezone(arguments.timezone)
    if arguments.now:
        cutoff = datetime.fromisoformat(arguments.now.replace("Z", "+00:00"))
        cutoff = (
            cutoff.replace(tzinfo=target_timezone)
            if cutoff.tzinfo is None
            else cutoff.astimezone(target_timezone)
        )
    else:
        cutoff = datetime.now(target_timezone) - timedelta(
            seconds=arguments.settle_seconds
        )
    start = datetime.combine(
        cutoff.date() - timedelta(days=arguments.days - 1),
        time.min,
        tzinfo=target_timezone,
    )
    database = arguments.database.expanduser()
    if not database.is_file():
        print(f"error: CCSwitch database does not exist: {database}", file=sys.stderr)
        return 1

    query = """
        SELECT app_type, input_token_semantics, model, input_tokens,
               output_tokens, cache_read_tokens, cache_creation_tokens,
               total_cost_usd, created_at
        FROM proxy_request_logs
        WHERE created_at >= ? AND created_at <= ?
        ORDER BY created_at
    """
    buckets: dict[tuple[str, str, str], dict[str, object]] = defaultdict(dict)
    try:
        uri = database.resolve().as_uri() + "?mode=ro"
        with closing(sqlite3.connect(uri, uri=True, timeout=3)) as connection:
            connection.execute("PRAGMA query_only = ON")
            rows = connection.execute(
                query, (int(start.timestamp()), int(cutoff.timestamp()))
            ).fetchall()
        for row in rows:
            (
                raw_app,
                raw_semantics,
                raw_model,
                raw_input,
                raw_output,
                raw_cache_read,
                raw_cache_creation,
                raw_cost,
                raw_created,
            ) = row
            app = str(raw_app or "").strip().lower()
            model = str(raw_model or "unknown").strip() or "unknown"
            cache_read = _nonnegative_int(raw_cache_read, "cache_read_tokens")
            cache_creation = _nonnegative_int(
                raw_cache_creation, "cache_creation_tokens"
            )
            fresh_input = _fresh_input_tokens(
                app,
                int(raw_semantics or 0),
                _nonnegative_int(raw_input, "input_tokens"),
                cache_read,
                cache_creation,
            )
            output = _nonnegative_int(raw_output, "output_tokens")
            cost_picos = int(_decimal_cost(raw_cost) * PICOS_PER_USD)
            occurred_at = datetime.fromtimestamp(int(raw_created), target_timezone)
            key = (occurred_at.date().isoformat(), app, model)
            if not buckets[key]:
                buckets[key] = {
                    "date": key[0],
                    "source": app,
                    "model": model,
                    "requests": 0,
                    "inputTokens": 0,
                    "outputTokens": 0,
                    "cacheReadTokens": 0,
                    "cacheCreationTokens": 0,
                    "costPicos": "0",
                    "dataThrough": None,
                }
            bucket = buckets[key]
            bucket["requests"] = int(bucket["requests"]) + 1
            bucket["inputTokens"] = int(bucket["inputTokens"]) + fresh_input
            bucket["outputTokens"] = int(bucket["outputTokens"]) + output
            bucket["cacheReadTokens"] = int(bucket["cacheReadTokens"]) + cache_read
            bucket["cacheCreationTokens"] = (
                int(bucket["cacheCreationTokens"]) + cache_creation
            )
            bucket["costPicos"] = str(int(bucket["costPicos"]) + cost_picos)
            iso_timestamp = occurred_at.astimezone(timezone.utc).isoformat().replace(
                "+00:00", "Z"
            )
            if bucket["dataThrough"] is None or iso_timestamp > bucket["dataThrough"]:
                bucket["dataThrough"] = iso_timestamp
    except (sqlite3.Error, ValueError, UsageDataError) as exc:
        print(f"error: unable to export CCSwitch data: {exc}", file=sys.stderr)
        return 1

    value = {
        "schemaVersion": 1,
        "cutoffAt": cutoff.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
        "timezone": arguments.timezone,
        "buckets": [buckets[key] for key in sorted(buckets)],
    }
    _atomic_json(arguments.output, value)
    print(f"Exported {len(value['buckets'])} daily model buckets to {arguments.output}")
    print(f"Cutoff: {value['cutoffAt']}")
    return 0


raise SystemExit(main())

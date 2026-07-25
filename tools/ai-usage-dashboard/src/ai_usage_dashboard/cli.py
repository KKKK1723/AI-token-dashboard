from __future__ import annotations

import argparse
import sys
from datetime import datetime
from pathlib import Path

from .data import UsageDataError, load_usage_snapshot, resolve_timezone
from .render import format_cost, write_dashboard_assets


def _parse_now(value: str | None, timezone_name: str) -> datetime | None:
    if value is None:
        return None
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    target_timezone = resolve_timezone(timezone_name)
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=target_timezone)
    return parsed.astimezone(target_timezone)


def build_parser(default_output_directory: Path) -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Generate GitHub Native usage cards from CC Switch statistics."
    )
    parser.add_argument(
        "--database",
        type=Path,
        default=Path.home() / ".cc-switch" / "cc-switch.db",
        help="Path to the CC Switch SQLite database.",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=default_output_directory,
        help="Directory for generated light and dark SVG files.",
    )
    parser.add_argument("--days", type=int, default=30)
    parser.add_argument("--timezone", default="Asia/Shanghai")
    parser.add_argument("--retries", type=int, default=5)
    parser.add_argument("--retry-delay", type=float, default=2)
    parser.add_argument(
        "--now",
        help="Override current ISO-8601 time for verification and tests.",
    )
    parser.add_argument(
        "--allow-empty",
        action="store_true",
        help="Generate an empty dashboard when the window has no records.",
    )
    return parser


def main(
    argv: list[str] | None = None,
    *,
    default_output_directory: Path | None = None,
) -> int:
    output_default = default_output_directory or Path.cwd() / "assets" / "ai-usage"
    arguments = build_parser(output_default).parse_args(argv)

    try:
        snapshot = load_usage_snapshot(
            arguments.database,
            now=_parse_now(arguments.now, arguments.timezone),
            days=arguments.days,
            timezone_name=arguments.timezone,
            retries=arguments.retries,
            retry_delay=arguments.retry_delay,
        )
        if snapshot.requests == 0 and not arguments.allow_empty:
            raise UsageDataError(
                "No CC Switch usage records were found in the selected window. "
                "Existing dashboard assets were left unchanged."
            )
        light_path, dark_path = write_dashboard_assets(
            snapshot, arguments.output_dir
        )
    except (OSError, ValueError, UsageDataError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    data_through = snapshot.data_through or snapshot.generated_at
    print(f"Generated: {light_path}")
    print(f"Generated: {dark_path}")
    print(
        "Window: "
        f"{snapshot.window_start:%Y-%m-%d} through {snapshot.window_end:%Y-%m-%d}"
    )
    print(
        f"Usage: {snapshot.total_tokens:,} tokens / "
        f"{format_cost(snapshot.cost_usd)} / {snapshot.requests:,} requests"
    )
    print(f"Data through: {data_through.isoformat(timespec='minutes')}")
    return 0

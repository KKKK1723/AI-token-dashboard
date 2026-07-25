from __future__ import annotations

import sqlite3
import time as time_module
from contextlib import closing
from dataclasses import dataclass
from datetime import datetime, time, timedelta, timezone, tzinfo
from decimal import Decimal, InvalidOperation
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


_CACHE_INCLUSIVE_APP_TYPES = frozenset({"codex", "gemini", "grokbuild"})
_INPUT_TOKEN_SEMANTICS_LEGACY = 0
_INPUT_TOKEN_SEMANTICS_TOTAL = 1
_INPUT_TOKEN_SEMANTICS_FRESH = 2


class UsageDataError(RuntimeError):
    """Raised when a consistent usage snapshot cannot be produced."""


@dataclass(frozen=True, slots=True)
class ModelUsage:
    name: str
    requests: int
    input_tokens: int
    output_tokens: int
    cache_read_tokens: int
    cache_creation_tokens: int
    cost_usd: Decimal

    @property
    def total_tokens(self) -> int:
        return (
            self.input_tokens
            + self.output_tokens
            + self.cache_read_tokens
            + self.cache_creation_tokens
        )


@dataclass(frozen=True, slots=True)
class UsageSnapshot:
    window_start: datetime
    window_end: datetime
    generated_at: datetime
    data_through: datetime | None
    requests: int
    input_tokens: int
    output_tokens: int
    cache_read_tokens: int
    cache_creation_tokens: int
    cost_usd: Decimal
    models: tuple[ModelUsage, ...]

    @property
    def total_tokens(self) -> int:
        return (
            self.input_tokens
            + self.output_tokens
            + self.cache_read_tokens
            + self.cache_creation_tokens
        )


@dataclass(slots=True)
class _Accumulator:
    requests: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_creation_tokens: int = 0
    cost_usd: Decimal = Decimal("0")

    def add(
        self,
        input_tokens: int,
        output_tokens: int,
        cache_read_tokens: int,
        cache_creation_tokens: int,
        cost_usd: Decimal,
    ) -> None:
        self.requests += 1
        self.input_tokens += input_tokens
        self.output_tokens += output_tokens
        self.cache_read_tokens += cache_read_tokens
        self.cache_creation_tokens += cache_creation_tokens
        self.cost_usd += cost_usd


def resolve_timezone(name: str) -> tzinfo:
    try:
        return ZoneInfo(name)
    except ZoneInfoNotFoundError:
        if name == "Asia/Shanghai":
            return timezone(timedelta(hours=8), name="CST")
        if name == "Asia/Tokyo":
            return timezone(timedelta(hours=9), name="JST")
        raise UsageDataError(
            f"Timezone '{name}' is unavailable. Install the Python tzdata package "
            "or use Asia/Shanghai."
        )


def rolling_window(now: datetime, days: int) -> tuple[datetime, datetime]:
    if days < 1:
        raise ValueError("days must be at least 1")
    if now.tzinfo is None:
        raise ValueError("now must be timezone-aware")
    first_date = now.date() - timedelta(days=days - 1)
    return datetime.combine(first_date, time.min, tzinfo=now.tzinfo), now


def _nonnegative_int(value: object, field: str) -> int:
    result = int(value or 0)
    if result < 0:
        raise UsageDataError(f"CC Switch returned a negative value for {field}")
    return result


def _fresh_input_tokens(
    app_type: str,
    input_token_semantics: int,
    input_tokens: int,
    cache_read_tokens: int,
    cache_creation_tokens: int,
) -> int:
    if input_token_semantics == _INPUT_TOKEN_SEMANTICS_FRESH:
        return input_tokens

    if app_type in _CACHE_INCLUSIVE_APP_TYPES:
        if (
            input_token_semantics == _INPUT_TOKEN_SEMANTICS_TOTAL
            and input_tokens >= cache_read_tokens + cache_creation_tokens
        ):
            return input_tokens - cache_read_tokens - cache_creation_tokens
        if (
            input_token_semantics == _INPUT_TOKEN_SEMANTICS_LEGACY
            and input_tokens >= cache_read_tokens
        ):
            return input_tokens - cache_read_tokens

    return input_tokens


def _decimal_cost(value: object) -> Decimal:
    try:
        result = Decimal(str(value or "0"))
    except InvalidOperation as exc:
        raise UsageDataError("CC Switch returned an invalid cost value") from exc
    if not result.is_finite() or result < 0:
        raise UsageDataError("CC Switch returned an invalid cost value")
    return result


def _query_rows(
    database: Path,
    start_epoch: int,
    end_epoch: int,
    retries: int,
    retry_delay: float,
) -> list[tuple[object, ...]]:
    uri = database.resolve().as_uri() + "?mode=ro"
    query = """
        SELECT app_type, input_token_semantics, model, input_tokens,
               output_tokens, cache_read_tokens, cache_creation_tokens,
               total_cost_usd, created_at
        FROM proxy_request_logs
        WHERE created_at >= ? AND created_at <= ?
        ORDER BY created_at
    """
    last_error: sqlite3.Error | None = None

    for attempt in range(max(1, retries)):
        try:
            with closing(sqlite3.connect(uri, uri=True, timeout=3)) as connection:
                connection.execute("PRAGMA query_only = ON")
                return connection.execute(query, (start_epoch, end_epoch)).fetchall()
        except sqlite3.Error as exc:
            last_error = exc
            if attempt + 1 < max(1, retries):
                time_module.sleep(max(0, retry_delay))

    raise UsageDataError(
        f"Unable to read CC Switch usage database after {max(1, retries)} attempt(s): "
        f"{database}"
    ) from last_error


def load_usage_snapshot(
    database: Path,
    *,
    now: datetime | None = None,
    days: int = 30,
    timezone_name: str = "Asia/Shanghai",
    retries: int = 5,
    retry_delay: float = 2,
) -> UsageSnapshot:
    database = Path(database).expanduser()
    if not database.is_file():
        raise UsageDataError(f"CC Switch database does not exist: {database}")

    target_timezone = resolve_timezone(timezone_name)
    if now is None:
        local_now = datetime.now(target_timezone)
    elif now.tzinfo is None:
        local_now = now.replace(tzinfo=target_timezone)
    else:
        local_now = now.astimezone(target_timezone)

    window_start, window_end = rolling_window(local_now, days)
    rows = _query_rows(
        database,
        int(window_start.timestamp()),
        int(window_end.timestamp()),
        retries,
        retry_delay,
    )

    totals = _Accumulator()
    by_model: dict[str, _Accumulator] = {}
    newest_timestamp: int | None = None

    for row in rows:
        (
            raw_app_type,
            raw_input_token_semantics,
            raw_name,
            raw_input,
            raw_output,
            raw_cache_read,
            raw_cache_creation,
            raw_cost,
            raw_created,
        ) = row
        app_type = str(raw_app_type or "").strip().lower()
        model_name = str(raw_name or "unknown").strip() or "unknown"
        raw_input_tokens = _nonnegative_int(raw_input, "input_tokens")
        output_tokens = _nonnegative_int(raw_output, "output_tokens")
        cache_read_tokens = _nonnegative_int(raw_cache_read, "cache_read_tokens")
        cache_creation_tokens = _nonnegative_int(
            raw_cache_creation, "cache_creation_tokens"
        )
        try:
            input_token_semantics = int(raw_input_token_semantics or 0)
        except (TypeError, ValueError) as exc:
            raise UsageDataError(
                "CC Switch returned an invalid input_token_semantics value"
            ) from exc
        input_tokens = _fresh_input_tokens(
            app_type,
            input_token_semantics,
            raw_input_tokens,
            cache_read_tokens,
            cache_creation_tokens,
        )
        cost_usd = _decimal_cost(raw_cost)
        created_at = int(raw_created)

        accumulator = by_model.setdefault(model_name, _Accumulator())
        accumulator.add(
            input_tokens,
            output_tokens,
            cache_read_tokens,
            cache_creation_tokens,
            cost_usd,
        )
        totals.add(
            input_tokens,
            output_tokens,
            cache_read_tokens,
            cache_creation_tokens,
            cost_usd,
        )
        newest_timestamp = (
            created_at
            if newest_timestamp is None
            else max(newest_timestamp, created_at)
        )

    models = tuple(
        sorted(
            (
                ModelUsage(
                    name=name,
                    requests=value.requests,
                    input_tokens=value.input_tokens,
                    output_tokens=value.output_tokens,
                    cache_read_tokens=value.cache_read_tokens,
                    cache_creation_tokens=value.cache_creation_tokens,
                    cost_usd=value.cost_usd,
                )
                for name, value in by_model.items()
            ),
            key=lambda item: (-item.total_tokens, -item.requests, item.name.lower()),
        )
    )
    data_through = (
        datetime.fromtimestamp(newest_timestamp, target_timezone)
        if newest_timestamp is not None
        else None
    )

    return UsageSnapshot(
        window_start=window_start,
        window_end=window_end,
        generated_at=local_now,
        data_through=data_through,
        requests=totals.requests,
        input_tokens=totals.input_tokens,
        output_tokens=totals.output_tokens,
        cache_read_tokens=totals.cache_read_tokens,
        cache_creation_tokens=totals.cache_creation_tokens,
        cost_usd=totals.cost_usd,
        models=models,
    )

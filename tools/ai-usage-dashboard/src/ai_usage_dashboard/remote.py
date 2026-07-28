from __future__ import annotations

import json
from datetime import datetime, time
from decimal import Decimal, InvalidOperation
from pathlib import Path

from .data import ModelUsage, UsageDataError, UsageSnapshot, resolve_timezone


def _nonnegative_int(value: object, field: str) -> int:
    try:
        result = int(value)
    except (TypeError, ValueError) as exc:
        raise UsageDataError(f"Remote snapshot has an invalid {field}") from exc
    if result < 0:
        raise UsageDataError(f"Remote snapshot has a negative {field}")
    return result


def _cost(value: object, field: str) -> Decimal:
    try:
        result = Decimal(str(value))
    except InvalidOperation as exc:
        raise UsageDataError(f"Remote snapshot has an invalid {field}") from exc
    if not result.is_finite() or result < 0:
        raise UsageDataError(f"Remote snapshot has an invalid {field}")
    return result


def _timestamp(value: object, field: str, timezone_name: str) -> datetime:
    if not isinstance(value, str):
        raise UsageDataError(f"Remote snapshot is missing {field}")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise UsageDataError(f"Remote snapshot has an invalid {field}") from exc
    target_timezone = resolve_timezone(timezone_name)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=target_timezone)
    return parsed.astimezone(target_timezone)


def load_remote_snapshot(path: Path, *, timezone_name: str = "Asia/Shanghai") -> UsageSnapshot:
    try:
        value = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise UsageDataError(f"Unable to read remote usage snapshot: {path}") from exc
    if not isinstance(value, dict) or value.get("schemaVersion") != 1:
        raise UsageDataError("Unsupported remote usage snapshot schema")

    target_timezone = resolve_timezone(timezone_name)
    generated_at = _timestamp(value.get("generatedAt"), "generatedAt", timezone_name)
    data_through_value = value.get("dataThrough")
    data_through = (
        _timestamp(data_through_value, "dataThrough", timezone_name)
        if data_through_value is not None
        else None
    )
    try:
        start_date = datetime.strptime(str(value["windowStartDate"]), "%Y-%m-%d").date()
        end_date = datetime.strptime(str(value["windowEndDate"]), "%Y-%m-%d").date()
    except (KeyError, ValueError) as exc:
        raise UsageDataError("Remote snapshot has an invalid date window") from exc
    if generated_at.date() != end_date or start_date > end_date:
        raise UsageDataError("Remote snapshot date window is inconsistent")

    raw_models = value.get("models")
    if not isinstance(raw_models, list):
        raise UsageDataError("Remote snapshot models must be an array")
    models = tuple(
        ModelUsage(
            name=str(model.get("name") or "unknown"),
            requests=_nonnegative_int(model.get("requests"), "model requests"),
            input_tokens=_nonnegative_int(model.get("inputTokens"), "model inputTokens"),
            output_tokens=_nonnegative_int(model.get("outputTokens"), "model outputTokens"),
            cache_read_tokens=_nonnegative_int(
                model.get("cacheReadTokens"), "model cacheReadTokens"
            ),
            cache_creation_tokens=_nonnegative_int(
                model.get("cacheCreationTokens"), "model cacheCreationTokens"
            ),
            cost_usd=_cost(model.get("costUsd"), "model costUsd"),
        )
        for model in raw_models
        if isinstance(model, dict)
    )
    if len(models) != len(raw_models):
        raise UsageDataError("Remote snapshot contains an invalid model entry")

    snapshot = UsageSnapshot(
        window_start=datetime.combine(start_date, time.min, tzinfo=target_timezone),
        window_end=generated_at,
        generated_at=generated_at,
        data_through=data_through,
        requests=_nonnegative_int(value.get("requests"), "requests"),
        input_tokens=_nonnegative_int(value.get("inputTokens"), "inputTokens"),
        output_tokens=_nonnegative_int(value.get("outputTokens"), "outputTokens"),
        cache_read_tokens=_nonnegative_int(value.get("cacheReadTokens"), "cacheReadTokens"),
        cache_creation_tokens=_nonnegative_int(
            value.get("cacheCreationTokens"), "cacheCreationTokens"
        ),
        cost_usd=_cost(value.get("costUsd"), "costUsd"),
        models=models,
    )
    if snapshot.requests != sum(model.requests for model in models):
        raise UsageDataError("Remote snapshot request totals do not match its models")
    if snapshot.total_tokens != sum(model.total_tokens for model in models):
        raise UsageDataError("Remote snapshot token totals do not match its models")
    if snapshot.cost_usd != sum((model.cost_usd for model in models), Decimal("0")):
        raise UsageDataError("Remote snapshot cost total does not match its models")
    return snapshot

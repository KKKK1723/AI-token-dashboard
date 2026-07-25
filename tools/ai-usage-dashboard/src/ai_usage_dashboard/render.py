from __future__ import annotations

import html
import os
import tempfile
import xml.etree.ElementTree as element_tree
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path

from .data import UsageSnapshot


@dataclass(frozen=True, slots=True)
class Theme:
    background: str
    panel: str
    border: str
    separator: str
    text: str
    muted: str
    track: str
    green: str
    blue: str
    orange: str
    dot_halo: str


THEMES = {
    "light": Theme(
        background="#ffffff",
        panel="#f6f8fa",
        border="#d0d7de",
        separator="#d8dee4",
        text="#1f2328",
        muted="#656d76",
        track="#eaeef2",
        green="#1f883d",
        blue="#0969da",
        orange="#bc4c00",
        dot_halo="#dafbe1",
    ),
    "dark": Theme(
        background="#0d1117",
        panel="#161b22",
        border="#30363d",
        separator="#30363d",
        text="#f0f6fc",
        muted="#8b949e",
        track="#21262d",
        green="#3fb950",
        blue="#58a6ff",
        orange="#d29922",
        dot_halo="#17351f",
    ),
}

MONTHS = (
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
)


def format_tokens(value: int) -> str:
    return f"{value:,}"


def format_cost(value: Decimal) -> str:
    rounded = value.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    return "$" + f"{rounded:,.2f}"


def format_date(value: datetime) -> str:
    return f"{MONTHS[value.month - 1]} {value.day}"


def shorten_model(name: str, maximum: int = 22) -> str:
    if len(name) <= maximum:
        return name
    return name[: maximum - 3] + "..."


def _text(value: object) -> str:
    return html.escape(str(value), quote=True)


def _percentage_tenths(token_counts: list[int]) -> list[int]:
    total_tokens = sum(token_counts)
    if total_tokens == 0:
        return [0] * len(token_counts)

    shares = [divmod(tokens * 1_000, total_tokens) for tokens in token_counts]
    percentage_tenths = [quotient for quotient, _ in shares]
    missing_tenths = 1_000 - sum(percentage_tenths)

    # Largest-remainder allocation keeps one-decimal labels at exactly 100.0%.
    remainder_order = sorted(
        range(len(shares)), key=lambda index: (-shares[index][1], index)
    )
    for index in remainder_order[:missing_tenths]:
        percentage_tenths[index] += 1
    return percentage_tenths


def render_svg(snapshot: UsageSnapshot, theme_name: str) -> str:
    if theme_name not in THEMES:
        raise ValueError(f"Unknown theme: {theme_name}")
    theme = THEMES[theme_name]
    top_models = snapshot.models[:3]
    top_colors = (theme.green, theme.blue, theme.orange)
    other_tokens = sum(model.total_tokens for model in snapshot.models[3:])
    usage_rows = [
        (model.name, model.total_tokens, top_colors[index], theme.text)
        for index, model in enumerate(top_models)
    ]
    usage_rows.extend([None] * (3 - len(usage_rows)))
    usage_rows.append(("Others", other_tokens, theme.muted, theme.text))
    row_positions = (169, 193, 217, 241)
    percentage_tenths = _percentage_tenths(
        [row[1] if row is not None else 0 for row in usage_rows]
    )

    model_rows: list[str] = []
    for index, y_position in enumerate(row_positions):
        row = usage_rows[index]
        if row is not None:
            name, row_tokens, bar_color, text_color = row
            percentage = percentage_tenths[index] / 10
            bar_width = max(0.0, min(255.0, 255.0 * percentage / 100))
            model_rows.append(
                f"""
  <text class="mono model" x="20" y="{y_position}" fill="{text_color}">{_text(shorten_model(name))}</text>
  <rect x="172" y="{y_position - 6}" width="255" height="6" rx="3" fill="{theme.track}"/>
  <rect x="172" y="{y_position - 6}" width="{bar_width:.1f}" height="6" rx="3" fill="{bar_color}"/>
  <text class="ui percentage" x="482" y="{y_position}" fill="{theme.text}" text-anchor="end">{percentage:.1f}%</text>"""
            )
        else:
            model_rows.append(
                f"""
  <text class="mono model" x="20" y="{y_position}" fill="{theme.muted}">No model data</text>
  <rect x="172" y="{y_position - 6}" width="255" height="6" rx="3" fill="{theme.track}"/>
  <text class="ui percentage" x="482" y="{y_position}" fill="{theme.muted}" text-anchor="end">0.0%</text>"""
            )

    updated_at = snapshot.data_through or snapshot.generated_at
    range_label = (
        f"{format_date(snapshot.window_start)} - {format_date(snapshot.window_end)}"
    )
    updated_label = (
        f"Updated {format_date(updated_at)} / {updated_at:%H:%M} "
        f"{updated_at.tzname() or 'local'}"
    )
    description = (
        f"{snapshot.requests:,} requests, {snapshot.total_tokens:,} tokens, "
        f"{format_cost(snapshot.cost_usd)} total cost."
    )

    return f"""<svg xmlns="http://www.w3.org/2000/svg" width="500" height="300" viewBox="0 0 500 300" role="img" aria-labelledby="title desc">
  <title id="title">AI usage over the last 30 days</title>
  <desc id="desc">{_text(description)}</desc>
  <style>
    .ui {{ font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif; }}
    .mono {{ font-family: "Cascadia Mono", Consolas, monospace; }}
    .brand {{ font-size: 14px; font-weight: 700; }}
    .badge {{ font-size: 10px; font-weight: 600; }}
    .label {{ font-size: 10px; }}
    .value {{ font-size: 23px; font-weight: 700; }}
    .token-value {{ font-size: 19px; font-weight: 700; }}
    .section {{ font-size: 10px; font-weight: 700; text-transform: uppercase; }}
    .section-muted {{ font-size: 9px; text-transform: uppercase; }}
    .model {{ font-size: 10px; }}
    .percentage {{ font-size: 10px; font-weight: 700; }}
    .footer {{ font-size: 9px; }}
  </style>

  <rect x="0.5" y="0.5" width="499" height="299" rx="6" fill="{theme.background}" stroke="{theme.border}"/>
  <circle cx="20" cy="22" r="8" fill="{theme.dot_halo}"/>
  <circle cx="20" cy="22" r="4" fill="{theme.green}"/>
  <text class="ui brand" x="34" y="27" fill="{theme.text}">AI usage</text>
  <rect x="400" y="10" width="82" height="24" rx="5" fill="{theme.panel}" stroke="{theme.border}"/>
  <text class="ui badge" x="441" y="26" fill="{theme.muted}" text-anchor="middle">LAST 30 DAYS</text>
  <line x1="0" y1="44" x2="500" y2="44" stroke="{theme.separator}"/>

  <text class="ui label" x="19" y="72" fill="{theme.muted}">Total tokens</text>
  <text class="ui token-value" x="19" y="102" fill="{theme.text}">{format_tokens(snapshot.total_tokens)}</text>
  <line x1="167" y1="44" x2="167" y2="120" stroke="{theme.separator}"/>

  <text class="ui label" x="185" y="72" fill="{theme.muted}">Total cost</text>
  <text class="ui value" x="185" y="102" fill="{theme.text}">{_text(format_cost(snapshot.cost_usd))}</text>
  <line x1="334" y1="44" x2="334" y2="120" stroke="{theme.separator}"/>

  <text class="ui label" x="352" y="72" fill="{theme.muted}">Requests</text>
  <text class="ui value" x="352" y="102" fill="{theme.text}">{snapshot.requests:,}</text>
  <line x1="0" y1="120" x2="500" y2="120" stroke="{theme.separator}"/>

  <text class="ui section" x="20" y="145" fill="{theme.text}">TOP MODELS</text>
  <text class="ui section-muted" x="482" y="145" fill="{theme.muted}" text-anchor="end">TOKEN SHARE</text>
{''.join(model_rows)}

  <rect x="0.5" y="270" width="499" height="29.5" fill="{theme.panel}"/>
  <line x1="0" y1="270" x2="500" y2="270" stroke="{theme.separator}"/>
  <text class="ui footer" x="18" y="289" fill="{theme.muted}">{_text(range_label)}</text>
  <text class="ui footer" x="482" y="289" fill="{theme.muted}" text-anchor="end">{_text(updated_label)}</text>
  <rect x="0.5" y="0.5" width="499" height="299" rx="6" fill="none" stroke="{theme.border}"/>
</svg>
"""


def _write_atomic(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(content)
        os.replace(temporary, path)
    except Exception:
        temporary.unlink(missing_ok=True)
        raise


def write_dashboard_assets(
    snapshot: UsageSnapshot, output_directory: Path
) -> tuple[Path, Path]:
    output_directory = Path(output_directory)
    light = render_svg(snapshot, "light")
    dark = render_svg(snapshot, "dark")
    element_tree.fromstring(light)
    element_tree.fromstring(dark)

    light_path = output_directory / "ai-usage-light.svg"
    dark_path = output_directory / "ai-usage-dark.svg"
    _write_atomic(light_path, light)
    _write_atomic(dark_path, dark)
    return light_path, dark_path

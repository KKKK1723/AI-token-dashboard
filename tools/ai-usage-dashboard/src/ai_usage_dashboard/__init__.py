"""Generate privacy-safe AI-token dashboard cards from CCSwitch usage data."""

from .data import ModelUsage, UsageSnapshot, UsageDataError, load_usage_snapshot
from .render import render_svg, write_dashboard_assets

__all__ = [
    "ModelUsage",
    "UsageSnapshot",
    "UsageDataError",
    "load_usage_snapshot",
    "render_svg",
    "write_dashboard_assets",
]

__version__ = "1.0.1"

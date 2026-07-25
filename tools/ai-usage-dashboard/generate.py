from pathlib import Path
import sys


PROJECT_DIRECTORY = Path(__file__).resolve().parent
REPOSITORY_ROOT = PROJECT_DIRECTORY.parents[1]
sys.path.insert(0, str(PROJECT_DIRECTORY / "src"))

from ai_usage_dashboard.cli import main  # noqa: E402


raise SystemExit(
    main(default_output_directory=REPOSITORY_ROOT / "assets" / "ai-usage")
)

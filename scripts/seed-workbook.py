#!/usr/bin/env python3
"""Create the UPM project through the shared, idempotent project-folder command."""
from pathlib import Path
import subprocess

root = Path(__file__).resolve().parent.parent
result = subprocess.run([str(root / "scripts/create-project.sh"), "upm"], cwd=root)
raise SystemExit(result.returncode)

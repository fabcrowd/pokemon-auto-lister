#!/usr/bin/env python3
"""Weekly catalog refresh: rebuild meta and re-embed new images."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent


def main() -> int:
    build = HERE / "build_catalog.py"
    embed = HERE / "embed_all.py"
    print("Refreshing catalog metadata + images…")
    r1 = subprocess.run([sys.executable, str(build), "--download-images"], check=False)
    if r1.returncode != 0:
        return r1.returncode
    print("Re-embedding…")
    r2 = subprocess.run([sys.executable, str(embed)], check=False)
    return r2.returncode


if __name__ == "__main__":
    raise SystemExit(main())

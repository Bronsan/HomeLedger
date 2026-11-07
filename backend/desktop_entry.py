"""PyInstaller entry point for the desktop sidecar.

`python -m app.desktop` is what developers run; a frozen bundle cannot use `-m`
because there is no package to import from, so this thin wrapper gives the
bundler a plain script to start from. It contains no logic of its own.
"""

from __future__ import annotations

import multiprocessing
import sys

from app.desktop import main

if __name__ == "__main__":
    # PyInstaller + anything that forks (uvicorn's process manager, sqlalchemy
    # pooling helpers) will recursively re-execute the bundle without this.
    multiprocessing.freeze_support()
    sys.exit(main())

# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec for the desktop sidecar.

Two decisions worth explaining:

* **onedir, not onefile.** A one-file bundle unpacks ~70MB into a temp directory
  on *every* launch, which adds 2–3 seconds to a desktop app's startup for no
  benefit. A directory starts instantly and the installer copies it once.
* **explicit excludes.** PyInstaller pulls in anything importable it can see. In
  a developer's virtualenv that can mean numpy, pandas and matplotlib riding
  along and tripling the size. None of them are used at runtime.
"""

import os

# A spec file is exec'd, not imported, so `__file__` does not exist here.
# PyInstaller injects SPECPATH for exactly this purpose.
ROOT = SPECPATH

datas = []
static_dir = os.path.join(ROOT, "app", "static")
if os.path.isdir(static_dir):
    datas.append((static_dir, os.path.join("app", "static")))

hiddenimports = [
    # uvicorn resolves its loop/protocol implementations dynamically.
    "uvicorn.logging",
    "uvicorn.loops.auto",
    "uvicorn.loops.asyncio",
    "uvicorn.protocols.http.auto",
    "uvicorn.protocols.http.h11_impl",
    "uvicorn.protocols.websockets.auto",
    "uvicorn.lifespan.on",
    # SQLAlchemy loads dialects by name.
    "sqlalchemy.dialects.sqlite",
    "sqlalchemy.dialects.postgresql",
    "sqlalchemy.sql.default_comparator",
    # Routers are imported explicitly, but the desktop bridge is only mounted
    # conditionally and would otherwise be tree-shaken out of the bundle.
    "app.routers.desktop",
    # pydantic v2 settings sources
    "pydantic_settings",
    "email_validator",
]

a = Analysis(
    ["desktop_entry.py"],
    pathex=[ROOT],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        "tkinter",
        "matplotlib",
        "numpy",
        "pandas",
        "scipy",
        "pytest",
        "IPython",
        "notebook",
        "PIL.ImageTk",
    ],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="homeledger-server",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
    disable_windowed_traceback=False,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="homeledger-server",
)

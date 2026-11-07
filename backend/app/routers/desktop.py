"""Desktop-shell bridge.

Mounted only when the process was launched by the Tauri shell
(``HOMELEDGER_DESKTOP_SHELL=1``). It exists so the tray menu can offer
"back up now" without a browser session — a convenience that must not become a
hole:

* the route is not registered at all outside desktop mode,
* every call must carry a per-install token stored in a ``0600`` file inside the
  data directory, which only the local user can read,
* it can only *create* a backup. Restoring, deleting and reading stay behind the
  normal session-based permission checks.
"""

from __future__ import annotations

import os
import secrets
from pathlib import Path

from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..audit import record
from ..config import settings
from ..db import get_db
from ..models import BackupRecord, Family, Membership
from ..providers.backup import get_backup_provider
from ..serializers import backup_out

router = APIRouter(prefix="/desktop", tags=["desktop"])


def _token_path() -> Path:
    return settings.resolved_data_dir / ".desktop_token"


def desktop_token() -> str:
    """Per-install secret shared with the shell. Created on first use."""
    path = _token_path()
    try:
        existing = path.read_text(encoding="utf-8").strip()
        if existing:
            return existing
    except OSError:
        pass

    token = secrets.token_urlsafe(32)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(token, encoding="utf-8")
    try:
        os.chmod(path, 0o600)
    except OSError:  # pragma: no cover - exotic filesystems
        pass
    return token


def require_desktop_token(x_desktop_token: str = Header(default="")) -> None:
    expected = desktop_token()
    if not x_desktop_token or not secrets.compare_digest(x_desktop_token, expected):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "桌面令牌无效")


@router.post("/backup")
def quick_backup(
    request: Request,
    _: None = Depends(require_desktop_token),
    db: Session = Depends(get_db),
) -> dict:
    """Create a full backup from the tray menu.

    A desktop install is a single-household install, so "the" family is
    unambiguous. If somebody did manage to create several, the oldest one wins —
    the same one the window opens by default.
    """
    family = db.execute(select(Family).order_by(Family.created_at)).scalars().first()
    if family is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "还没有家庭，无法备份")

    member = db.execute(
        select(Membership)
        .where(Membership.family_id == family.id)
        .order_by(Membership.joined_at)
    ).scalars().first()

    info = get_backup_provider().create(
        include_files=True,
        note="桌面快捷备份",
        created_by="桌面壳",
    )
    row = BackupRecord(
        family_id=family.id,
        filename=info["filename"],
        relative_path=info["relative_path"],
        size_bytes=info["size_bytes"],
        sha256=info["sha256"],
        kind="manual",
        note=info["note"],
        includes_files=info["includes_files"],
        created_by=member.user_id if member else "",
    )
    db.add(row)
    record(
        db,
        None,
        "system.backup",
        entity_type="backup",
        entity_id=row.id,
        summary=f"创建备份：{info['filename']}（桌面托盘）",
        request=request,
        family_id=family.id,
        actor_name="桌面壳",
    )
    db.commit()
    return {"backup": backup_out(row), "filename": info["filename"]}

"""Desktop shell bridge.

The tray's "back up now" is the only thing the shell can do on behalf of the
user, and it must not become a way in. These tests pin down the three
properties that make it safe:

1. the routes do not exist outside a desktop build,
2. every call needs the per-install token,
3. the token file is not readable by other users.

Route registration is decided at import time from the environment, so the
"absent" case is asserted against the normal test app (a gateway deployment),
and the token mechanics are exercised directly.
"""

from __future__ import annotations

import os
import stat
import sys

import pytest

API = "/api/v1"


def test_desktop_bridge_is_absent_in_a_gateway_deployment(client):
    """A gateway must not expose a bridge nobody can authenticate against."""
    assert client.post(f"{API}/desktop/backup", json={}).status_code in (404, 405)
    assert client.get(f"{API}/desktop/backup").status_code in (404, 405)


def test_token_file_is_private_and_stable():
    from app.config import settings
    from app.routers.desktop import desktop_token

    first = desktop_token()
    assert len(first) >= 32
    # Regenerating must not invalidate a shell that already read the file.
    assert desktop_token() == first

    path = settings.resolved_data_dir / ".desktop_token"
    # `os.chmod` only toggles the read-only bit on Windows; it cannot express
    # 0600. There the boundary is the ACL on %APPDATA%, which the installer
    # creates per-user — so this assertion is about POSIX and is skipped rather
    # than faked with a weaker one.
    if sys.platform == "win32":
        pytest.skip("Windows 用 ACL 控制权限，os.chmod 无法表达 0600")
    mode = stat.S_IMODE(os.stat(path).st_mode)
    assert mode == 0o600, f"期望 0600，实际 {oct(mode)}"


def test_wrong_token_is_rejected():
    import pytest
    from fastapi import HTTPException

    from app.routers.desktop import require_desktop_token

    with pytest.raises(HTTPException) as exc:
        require_desktop_token("not-the-token")
    assert exc.value.status_code == 401

    with pytest.raises(HTTPException):
        require_desktop_token("")

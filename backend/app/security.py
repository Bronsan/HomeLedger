"""Password hashing and JWT issuing.

Deliberately dependency-light: stdlib `hashlib.scrypt` for passwords, `PyJWT`
for tokens. No passlib, no bcrypt build headaches in Alpine containers.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
from datetime import datetime, timedelta, timezone

import jwt

from .config import settings

_ALGO = "HS256"
_SCRYPT_N = 2**14
_SCRYPT_R = 8
_SCRYPT_P = 1


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    dk = hashlib.scrypt(
        password.encode("utf-8"), salt=salt, n=_SCRYPT_N, r=_SCRYPT_R, p=_SCRYPT_P, dklen=32
    )
    return "scrypt${}${}${}${}".format(
        _SCRYPT_N,
        _SCRYPT_R,
        _SCRYPT_P,
        base64.b64encode(salt + dk).decode("ascii"),
    )


def verify_password(password: str, encoded: str) -> bool:
    try:
        scheme, n, r, p, blob = encoded.split("$")
        if scheme != "scrypt":
            return False
        raw = base64.b64decode(blob)
        salt, expected = raw[:16], raw[16:]
        dk = hashlib.scrypt(
            password.encode("utf-8"),
            salt=salt,
            n=int(n),
            r=int(r),
            p=int(p),
            dklen=len(expected),
        )
        return hmac.compare_digest(dk, expected)
    except Exception:
        return False


def create_access_token(user_id: str, token_version: int = 1) -> tuple[str, int]:
    now = datetime.now(timezone.utc)
    expires = now + timedelta(minutes=settings.access_token_ttl_minutes)
    payload = {
        "sub": user_id,
        "ver": token_version,
        "iat": int(now.timestamp()),
        "exp": int(expires.timestamp()),
        "iss": "homeledger",
        "jti": secrets.token_hex(8),
    }
    token = jwt.encode(payload, settings.resolve_secret(), algorithm=_ALGO)
    return token, settings.access_token_ttl_minutes * 60


def decode_token(token: str) -> dict | None:
    try:
        payload = jwt.decode(
            token,
            settings.resolve_secret(),
            algorithms=[_ALGO],
            issuer="homeledger",
            options={"require": ["sub", "ver", "iat", "exp", "iss", "jti"]},
        )
        if not isinstance(payload["sub"], str) or not payload["sub"]:
            return None
        if type(payload["ver"]) is not int or payload["ver"] < 1:
            return None
        if type(payload["iat"]) is not int or type(payload["exp"]) is not int:
            return None
        if payload["exp"] <= payload["iat"] or not isinstance(payload["jti"], str):
            return None
        return payload
    except jwt.PyJWTError:
        return None


def make_invite_code(length: int = 8) -> str:
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    return "".join(secrets.choice(alphabet) for _ in range(length))


def make_asset_code(seq: int) -> str:
    """Human readable asset code printed on the QR label."""
    return f"HL-{seq:06d}"

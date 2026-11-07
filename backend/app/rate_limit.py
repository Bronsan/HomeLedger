"""Bounded, short-lived authentication throttling for a single API process.

Only keyed digests live in memory; no address/email/user-agent history is saved.
Use a gateway/shared limiter for multiple workers or replicas.
"""

from __future__ import annotations

import hashlib
import secrets
import threading
import time

from fastapi import HTTPException, Request

from .config import settings


class AuthLimiter:
    def __init__(self, window: int = 60, max_keys: int = 8192):
        self.window = window
        self.max_keys = max_keys
        self._salt = secrets.token_bytes(32)
        self._buckets: dict[bytes, tuple[float, int]] = {}
        self._lock = threading.Lock()

    def clear(self) -> None:
        with self._lock:
            self._buckets.clear()

    def check(self, key: str, limit: int) -> None:
        if limit <= 0:
            return
        digest = hashlib.blake2b(key.encode(), key=self._salt, digest_size=16).digest()
        now = time.monotonic()
        with self._lock:
            self._buckets = {k: v for k, v in self._buckets.items() if v[0] > now}
            end, count = self._buckets.get(digest, (now + self.window, 0))
            if count >= limit or (digest not in self._buckets and len(self._buckets) >= self.max_keys):
                raise HTTPException(429, "尝试过于频繁，请稍后重试", headers={"Retry-After": str(self.window)})
            self._buckets[digest] = (end, count + 1)


limiter = AuthLimiter()


def check_auth_rate(request: Request, action: str, account: str) -> None:
    # Never parse untrusted X-Forwarded-For here. A trusted ASGI proxy configuration
    # may set request.client; the shipped configuration disables proxy headers.
    source = request.client.host if request.client else "unknown"
    limiter.check(f"source|{action}|{source}", settings.auth_rate_limit)
    limiter.check(f"account|{action}|{account.strip().lower()}", settings.auth_account_rate_limit)

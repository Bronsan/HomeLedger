"""Bounded, short-lived authentication throttling for a single API process.

Only keyed digests live in memory; no address/email/user-agent history is saved.

The counters live in this process, so **N workers or N replicas give an attacker
N times the budget**. Deploy a gateway-level limiter (nginx ``limit_req``,
Cloudflare, Traefik) or a shared-store limiter alongside this one whenever the
API runs with more than one process.
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
        # Expired keys are swept every `max_keys` calls instead of on every call.
        self._sweep_interval = max(1, max_keys)
        self._sweep_due = self._sweep_interval

    def clear(self) -> None:
        with self._lock:
            self._buckets.clear()
            self._sweep_due = self._sweep_interval

    def check(self, key: str, limit: int) -> None:
        if limit <= 0:
            return
        digest = hashlib.blake2b(key.encode(), key=self._salt, digest_size=16).digest()
        now = time.monotonic()
        with self._lock:
            # Sweeping on an amortised schedule keeps the hot path O(1). Rebuilding
            # the whole dict on every call made each request slower the harder the
            # endpoint was hammered, which helps the attacker, not us.
            self._sweep_due -= 1
            if self._sweep_due <= 0:
                self._buckets = {k: v for k, v in self._buckets.items() if v[0] > now}
                self._sweep_due = self._sweep_interval

            entry = self._buckets.get(digest)
            if entry is not None and entry[0] <= now:
                # The key we were asked about has expired: drop it now so this call
                # starts a fresh window without waiting for the next sweep.
                del self._buckets[digest]
                entry = None

            end, count = entry if entry is not None else (now + self.window, 0)
            if count >= limit or (entry is None and len(self._buckets) >= self.max_keys):
                raise HTTPException(429, "尝试过于频繁，请稍后重试", headers={"Retry-After": str(self.window)})
            self._buckets[digest] = (end, count + 1)


limiter = AuthLimiter()


def check_auth_rate(request: Request, action: str, account: str) -> None:
    # Never parse untrusted X-Forwarded-For here. A trusted ASGI proxy configuration
    # may set request.client; the shipped configuration disables proxy headers.
    source = request.client.host if request.client else "unknown"
    limiter.check(f"source|{action}|{source}", settings.auth_rate_limit)
    limiter.check(f"account|{action}|{account.strip().lower()}", settings.auth_account_rate_limit)

"""Login throttling: window accounting, expiry and the bounded key table."""

from __future__ import annotations

import time

import pytest
from fastapi import HTTPException

from app.rate_limit import AuthLimiter


def _status(limiter: AuthLimiter, key: str, limit: int) -> int | None:
    try:
        limiter.check(key, limit)
    except HTTPException as exc:
        return exc.status_code
    return None


def test_allows_up_to_the_limit_then_rejects():
    limiter = AuthLimiter(window=60, max_keys=16)
    for _ in range(3):
        assert _status(limiter, "source|login|1.2.3.4", 3) is None
    assert _status(limiter, "source|login|1.2.3.4", 3) == 429


def test_rejection_carries_retry_after_for_the_window():
    limiter = AuthLimiter(window=42, max_keys=16)
    limiter.check("k", 1)
    with pytest.raises(HTTPException) as raised:
        limiter.check("k", 1)
    assert raised.value.headers["Retry-After"] == "42"


def test_limit_of_zero_disables_throttling():
    limiter = AuthLimiter(window=60, max_keys=16)
    for _ in range(50):
        limiter.check("k", 0)


def test_expired_window_starts_over_without_waiting_for_the_sweep():
    limiter = AuthLimiter(window=1, max_keys=16)
    assert _status(limiter, "k", 1) is None
    assert _status(limiter, "k", 1) == 429
    time.sleep(1.05)
    # The key expired: this call must start a fresh window rather than stay blocked
    # until the amortised sweep happens to reach it.
    assert _status(limiter, "k", 1) is None


def test_key_table_stays_bounded():
    limiter = AuthLimiter(window=60, max_keys=8)
    for i in range(200):
        try:
            limiter.check(f"k{i}", 5)
        except HTTPException:
            pass
    assert len(limiter._buckets) <= 8


def test_clear_resets_counters_and_sweep_state():
    limiter = AuthLimiter(window=60, max_keys=16)
    limiter.check("k", 1)
    limiter.clear()
    assert limiter._buckets == {}
    assert _status(limiter, "k", 1) is None

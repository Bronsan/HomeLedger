"""On-demand viewer for scanned QR stickers.

A sticker on a storage box is read maybe twice a year. Keeping a rendering
path warm for that is a bad trade on a machine that is otherwise idle — a
Raspberry Pi in a cupboard, a laptop that went to sleep. So the viewer is a
lease-based service:

    asleep  ──scan──▶  awake  ──no heartbeat for N s──▶  asleep

While awake it keeps a decoded page cache (the expensive part: three joins,
a location path and a thumbnail lookup) and a watchdog thread that notices
silence. When it goes back to sleep both are dropped, so an idle household
holds no request state at all.

The lease is driven by a heartbeat from the page itself, not by a timeout on
the HTTP request: a person standing in front of a shelf reading a label has
the page open, and the socket may already be closed by then.

This is not a security boundary — that is `qr_lan_only` in the router. It is a
resource boundary, and it is deliberately simple enough to reason about.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from typing import Any

from ..config import settings


@dataclass
class _State:
    leases: dict[str, float] = field(default_factory=dict)
    cache: dict[str, tuple[float, str]] = field(default_factory=dict)
    thread: threading.Thread | None = None
    stop: threading.Event = field(default_factory=threading.Event)


class QrGateway:
    """Lease bookkeeping plus a page cache that only exists while awake."""

    # A cached page is thrown away if the item changed underneath it. Short
    # enough that an edit shows up on the next scan, long enough that the
    # heartbeat traffic of an open page costs nothing.
    CACHE_TTL = 20.0
    TICK = 5.0
    # Floor on the idle window, so a typo in the config cannot turn the viewer
    # off between a page load and its first heartbeat. Tests subclass this.
    MIN_IDLE = 15.0

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._state = _State()
        self._awake_since: float = 0.0
        self._slept_at: float = 0.0
        self._last_scan: float = 0.0
        self._views = 0
        self._wakes = 0

    # -- lifecycle ---------------------------------------------------------
    @property
    def awake(self) -> bool:
        with self._lock:
            return self._state.thread is not None and self._state.thread.is_alive()

    def wake(self, token: str, *, count: bool = True) -> bool:
        """Register a viewer. Returns True when this call woke the service.

        `count=False` is for a heartbeat arriving after the lease lapsed: the
        page was open in someone's pocket for ten minutes, but nobody scanned
        it again, and the counter should say so.
        """
        with self._lock:
            now = time.time()
            if count:
                self._last_scan = now
                self._views += 1
            woke = not self.awake
            if woke:
                self._wakes += 1
                self._awake_since = now
                self._state = _State()
                thread = threading.Thread(
                    target=self._watch, name="qr-gateway", daemon=True
                )
                self._state.thread = thread
                thread.start()
            self._state.leases[token] = now + self._ttl()
            return woke

    def beat(self, token: str) -> bool:
        """Extend a lease. Returns False when the lease had already lapsed."""
        with self._lock:
            now = time.time()
            if token not in self._state.leases:
                return False
            self._state.leases[token] = now + self._ttl()
            return True

    def _ttl(self) -> float:
        return max(self.MIN_IDLE, float(settings.qr_idle_seconds))

    def sleep(self) -> None:
        with self._lock:
            if not self.awake:
                return
            state = self._state
            state.stop.set()
            state.thread = None  # type: ignore[assignment]
            state.leases.clear()
            state.cache.clear()
            self._slept_at = time.time()

    # -- cache -------------------------------------------------------------
    def cached(self, token: str) -> str | None:
        with self._lock:
            hit = self._state.cache.get(token)
            if not hit:
                return None
            stamp, html = hit
            if time.time() - stamp > self.CACHE_TTL:
                self._state.cache.pop(token, None)
                return None
            return html

    def remember(self, token: str, html: str) -> None:
        with self._lock:
            # Bounded: a family with 5000 stickers should not be able to grow
            # this by scanning them all in one afternoon.
            if len(self._state.cache) >= 64:
                oldest = min(self._state.cache.items(), key=lambda kv: kv[1][0])[0]
                self._state.cache.pop(oldest, None)
            self._state.cache[token] = (time.time(), html)

    def forget(self, token: str | None = None) -> None:
        """Drop cache entries. Called when an item changes."""
        with self._lock:
            if token is None:
                self._state.cache.clear()
            else:
                self._state.cache.pop(token, None)

    # -- internals ---------------------------------------------------------
    def _watch(self) -> None:
        state = self._state
        idle = self._ttl()
        while not state.stop.wait(self.TICK):
            now = time.time()
            with self._lock:
                if state is not self._state:
                    return
                for token, deadline in list(state.leases.items()):
                    if deadline <= now:
                        state.leases.pop(token, None)
                        state.cache.pop(token, None)
                if state.leases:
                    continue
                # Nothing left to serve. Wait one full idle window before
                # dropping the cache so a second scan a minute later is still
                # served from memory.
                if self._awake_since and now - self._awake_since < idle:
                    continue
                state.stop.set()
                state.cache.clear()
                self._state.thread = None  # type: ignore[assignment]
                self._slept_at = now
                return

    # -- introspection -----------------------------------------------------
    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            now = time.time()
            return {
                "state": "awake" if self.awake else "asleep",
                "viewers": len(self._state.leases),
                "cached_pages": len(self._state.cache),
                "views_total": self._views,
                "wakes_total": self._wakes,
                "last_scan_at": _iso(self._last_scan or None),
                "awake_since": _iso(self._awake_since or None) if self.awake else None,
                "slept_at": _iso(self._slept_at or None),
                "idle_seconds": settings.qr_idle_seconds,
                "cache_ttl": self.CACHE_TTL,
                "next_sleep_in": (
                    round(max(0.0, min(self._state.leases.values()) - now), 1)
                    if self._state.leases
                    else None
                ),
            }


def _iso(ts: float | None) -> str | None:
    if not ts:
        return None
    from datetime import datetime, timezone

    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat().replace("+00:00", "Z")


gateway = QrGateway()

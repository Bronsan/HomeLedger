"""Audit trail + item lifecycle events.

Two different things, deliberately separate:
  * audit_logs  — who did what, for compliance ("who deleted the insurance PDF")
  * item_events — the story of one object ("moved to study", "battery replaced")

Both are append-only. Nothing in the app updates or deletes them.
"""

from __future__ import annotations

from typing import Any

from fastapi import Request
from sqlalchemy.orm import Session

from .models import AuditLog, Item, ItemEvent
from .permissions import Principal
from .services.events import note_change


def record(
    db: Session,
    principal: Principal | None,
    action: str,
    *,
    entity_type: str = "",
    entity_id: str = "",
    summary: str = "",
    before: dict[str, Any] | None = None,
    after: dict[str, Any] | None = None,
    request: Request | None = None,
    family_id: str | None = None,
    actor_name: str | None = None,
    actor_id: str | None = None,
) -> AuditLog:
    # Privacy: the audit trail answers "who changed what"; it deliberately does
    # not persist IP addresses or User-Agent strings. `request` stays in the
    # signature so callers do not need a second, privacy-aware variant.
    ip, ua = "", ""
    log = AuditLog(
        family_id=family_id or (principal.family_id if principal else ""),
        actor_id=actor_id if actor_id is not None else (principal.user_id if principal else ""),
        actor_name=actor_name or (principal.display_name if principal else "system"),
        action=action,
        entity_type=entity_type,
        entity_id=entity_id,
        summary=summary[:255],
        before=before,
        after=after,
        ip=ip,
        user_agent=ua,
    )
    db.add(log)
    # Every write path already funnels through here, so this is the one place
    # that can promise "any committed change is announced" without editing 90
    # routes. The event is emitted by the session's after_commit hook, not now:
    # a hint sent from inside a transaction that later rolls back is a lie, and
    # a client that got lied to once stops trusting the channel.
    note_change(
        db,
        family_id or (principal.family_id if principal else ""),
        entity_type or "all",
        action,
    )
    return log


def add_event(
    db: Session,
    principal: Principal | None,
    item: Item,
    event_type: str,
    summary: str,
    payload: dict[str, Any] | None = None,
) -> ItemEvent:
    ev = ItemEvent(
        family_id=item.family_id,
        item_id=item.id,
        event_type=event_type,
        summary=summary[:255],
        payload=payload or {},
        actor_id=principal.user_id if principal else "",
        actor_name=principal.display_name if principal else "system",
    )
    db.add(ev)
    return ev


def diff(before: dict[str, Any], after: dict[str, Any]) -> dict[str, Any]:
    """Compact field level diff stored in the audit log."""
    changed = {}
    for key, new in after.items():
        old = before.get(key)
        if old != new:
            changed[key] = {"from": old, "to": new}
    return changed

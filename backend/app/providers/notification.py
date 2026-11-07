"""Notification fan-out.

Channels are independent providers. A single logical notification is written
once to the in-app inbox and optionally mirrored to email / webhook. Failures in
an external channel must never break the business transaction that triggered
them — `dispatch` swallows and records, it never raises.
"""

from __future__ import annotations

import logging
import smtplib
from abc import ABC, abstractmethod
from email.message import EmailMessage
from typing import Any

from sqlalchemy.orm import Session

from ..config import settings
from ..models import Notification

log = logging.getLogger("homeledger.notify")


class NotificationProvider(ABC):
    channel: str = "base"

    @abstractmethod
    def send(
        self,
        db: Session,
        *,
        family_id: str,
        title: str,
        body: str,
        user_id: str | None = None,
        type: str = "system",
        entity_type: str = "",
        entity_id: str = "",
        dedupe_key: str | None = None,
        email_to: str | None = None,
    ) -> bool: ...

    def health(self) -> dict:
        return {"ok": True, "channel": self.channel}


class InAppProvider(NotificationProvider):
    channel = "inapp"

    def send(
        self,
        db: Session,
        *,
        family_id: str,
        title: str,
        body: str,
        user_id: str | None = None,
        type: str = "system",
        entity_type: str = "",
        entity_id: str = "",
        dedupe_key: str | None = None,
        email_to: str | None = None,
    ) -> bool:
        note = Notification(
            family_id=family_id,
            user_id=user_id,
            channel="inapp",
            type=type,
            title=title,
            body=body,
            entity_type=entity_type,
            entity_id=entity_id,
            dedupe_key=dedupe_key or "",
        )
        db.add(note)
        return True


class EmailProvider(NotificationProvider):
    channel = "email"

    def send(
        self,
        db: Session,
        *,
        family_id: str,
        title: str,
        body: str,
        user_id: str | None = None,
        type: str = "system",
        entity_type: str = "",
        entity_id: str = "",
        dedupe_key: str | None = None,
        email_to: str | None = None,
    ) -> bool:
        if not (settings.smtp_host and email_to):
            return False
        try:
            msg = EmailMessage()
            msg["Subject"] = f"[{settings.app_name}] {title}"
            msg["From"] = settings.smtp_from or settings.smtp_user
            msg["To"] = email_to
            msg.set_content(body)
            with smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=8) as smtp:
                smtp.starttls()
                if settings.smtp_user:
                    smtp.login(settings.smtp_user, settings.smtp_password)
                smtp.send_message(msg)
            return True
        except Exception as exc:
            log.warning("email notification failed: %s", exc)
            return False

    def health(self) -> dict:
        return {"ok": bool(settings.smtp_host), "channel": "email", "host": settings.smtp_host}


class WebhookProvider(NotificationProvider):
    channel = "webhook"

    def send(
        self,
        db: Session,
        *,
        family_id: str,
        title: str,
        body: str,
        user_id: str | None = None,
        type: str = "system",
        entity_type: str = "",
        entity_id: str = "",
        dedupe_key: str | None = None,
        email_to: str | None = None,
    ) -> bool:
        if not settings.webhook_url:
            return False
        try:
            import httpx

            payload: dict[str, Any] = {
                "source": "homeledger",
                "family_id": family_id,
                "title": title,
                "body": body,
                "type": type,
                "entity": {"type": entity_type, "id": entity_id},
            }
            httpx.post(settings.webhook_url, json=payload, timeout=6)
            return True
        except Exception as exc:
            log.warning("webhook notification failed: %s", exc)
            return False

    def health(self) -> dict:
        return {"ok": bool(settings.webhook_url), "channel": "webhook"}


_REGISTRY: dict[str, type[NotificationProvider]] = {
    "inapp": InAppProvider,
    "email": EmailProvider,
    "webhook": WebhookProvider,
}

_instances: list[NotificationProvider] | None = None


def get_notification_providers() -> list[NotificationProvider]:
    global _instances
    if _instances is None:
        _instances = [
            _REGISTRY[c]()
            for c in settings.notification_channel_list
            if c in _REGISTRY
        ] or [InAppProvider()]
    return _instances


def dispatch(
    db: Session,
    *,
    family_id: str,
    title: str,
    body: str = "",
    user_id: str | None = None,
    type: str = "system",
    entity_type: str = "",
    entity_id: str = "",
    dedupe_key: str | None = None,
    email_to: str | None = None,
) -> list[str]:
    """Fan out to every configured channel. Never raises."""
    delivered: list[str] = []
    for provider in get_notification_providers():
        try:
            ok = provider.send(
                db,
                family_id=family_id,
                title=title,
                body=body,
                user_id=user_id,
                type=type,
                entity_type=entity_type,
                entity_id=entity_id,
                dedupe_key=dedupe_key,
                email_to=email_to,
            )
            if ok:
                delivered.append(provider.channel)
        except Exception as exc:  # duplicate dedupe key etc.
            log.debug("channel %s skipped: %s", provider.channel, exc)
    db.flush()
    return delivered

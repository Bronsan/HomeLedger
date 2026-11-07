"""Deployment configuration.

HomeLedger is designed to run in three deployment modes that share the same
business logic and data model:

    local    - single machine, data stays on that device
    gateway  - long-running home server / NAS / mini-PC, LAN multi-user
    cloud    - hosted, remote access, optional object storage

Configuration is entirely environment driven so the same container image can be
deployed in any of the three modes.
"""

from __future__ import annotations

import os
import secrets
from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", env_prefix="HOMELEDGER_", extra="ignore"
    )

    # --- identity of this installation -------------------------------------
    app_name: str = "HomeLedger"
    app_version: str = "2.0.2-beta"
    deployment_mode: str = "gateway"  # local | gateway | cloud
    install_id: str = ""
    # Set by the desktop shell. Gates the /desktop/* bridge routes; a gateway or
    # cloud deployment never sets it, so those routes simply do not exist there.
    desktop_shell: bool = False

    # --- storage -----------------------------------------------------------
    data_dir: Path = Path("./data")
    database_url: str | None = None  # explicit override wins
    storage_backend: str = "local"  # local | s3
    s3_endpoint: str = ""
    s3_bucket: str = ""
    s3_access_key: str = ""
    s3_secret_key: str = ""
    s3_region: str = ""

    # --- security ----------------------------------------------------------
    secret_key: str = ""
    access_token_ttl_minutes: int = 60 * 24 * 14
    allow_registration: bool = True  # first-run bootstrap always allowed
    # Hosted account service: accounts only, no household data. Registration
    # also defaults to the QQ whitelist below unless email_domains overrides it.
    service_mode: bool = False
    email_domains: str = ""  # comma list; empty = no restriction (self-hosted)
    max_upload_mb: int = 64
    auth_rate_limit: int = 30  # per source/action/minute, one process; 0 disables for tests
    auth_account_rate_limit: int = 10
    cors_origins: str = "*"

    # --- providers ---------------------------------------------------------
    ai_provider: str = "local"  # local | cloud | disabled
    ai_endpoint: str = ""
    ai_api_key: str = ""
    notification_channels: str = "inapp"  # comma list: inapp,email,webhook
    smtp_host: str = ""
    smtp_port: int = 587
    smtp_user: str = ""
    smtp_password: str = ""
    smtp_from: str = ""
    webhook_url: str = ""

    # The interface the HTTP server listens on. Recorded here so the sticker
    # generator can tell "phones can reach this" from "only this machine can".
    bind_host: str = "127.0.0.1"

    # --- QR stickers -------------------------------------------------------
    # A printed sticker has to keep working long after the device that printed
    # it is gone, so the QR carries a server URL and an opaque token rather
    # than an app deep link. `qr_lan_only` is the security boundary: the page
    # is readable only from an address on the same network as the server.
    qr_enabled: bool = True
    qr_lan_only: bool = True
    # Price on the sticker page. On by default: the people scanning it are the
    # household, and "how much did we pay for this" is a normal question to ask
    # of your own ledger. Turn it off if guests use your Wi-Fi and you would
    # rather they did not read your receipts — the serial number is on the page
    # either way, so this is about manners, not secrecy.
    qr_show_price: bool = True
    # Override the host used in printed QRs, e.g. http://home.lan:8000. Empty
    # means "work it out from the request / the primary network interface".
    qr_public_base: str = ""
    # How long the viewer service stays awake after the last heartbeat. Short
    # enough that a scan does not leave a process spinning all evening.
    qr_idle_seconds: int = 90

    # --- behaviour ---------------------------------------------------------
    reminder_poll_seconds: int = 60
    auto_backup_hours: int = 24
    # Instance-wide retention. 0 disables pruning.
    backup_keep: int = 50
    serve_frontend: bool = True

    # --- derived -----------------------------------------------------------
    @property
    def resolved_data_dir(self) -> Path:
        p = Path(self.data_dir).expanduser().resolve()
        p.mkdir(parents=True, exist_ok=True)
        return p

    @property
    def upload_dir(self) -> Path:
        p = self.resolved_data_dir / "uploads"
        p.mkdir(parents=True, exist_ok=True)
        return p

    @property
    def backup_dir(self) -> Path:
        p = self.resolved_data_dir / "backups"
        p.mkdir(parents=True, exist_ok=True)
        return p

    @property
    def resolved_database_url(self) -> str:
        if self.database_url:
            return self.database_url
        return f"sqlite:///{(self.resolved_data_dir / 'homeledger.db').as_posix()}"

    @property
    def cors_origin_list(self) -> list[str]:
        raw = (self.cors_origins or "").strip()
        if not raw or raw == "*":
            return ["*"]
        return [o.strip() for o in raw.split(",") if o.strip()]

    @property
    def allowed_email_domains(self) -> list[str]:
        """Registration whitelist, empty means "accept any shaped address".

        The hosted account service starts QQ-only; self-hosted gateways keep the
        permissive behaviour they had before (home.lan, family@example.com ...).
        """
        raw = (self.email_domains or "").strip()
        if not raw:
            return ["qq.com"] if self.service_mode else []
        return [d.strip().lower().lstrip("@") for d in raw.split(",") if d.strip()]

    @property
    def notification_channel_list(self) -> list[str]:
        return [c.strip() for c in self.notification_channels.split(",") if c.strip()]

    def resolve_secret(self) -> str:
        """Return a stable secret key.

        In development an ephemeral key is generated and persisted next to the
        database so restarts do not invalidate every session. In production the
        operator is expected to supply HOMELEDGER_SECRET_KEY.
        """
        if self.secret_key:
            return self.secret_key
        key_file = self.resolved_data_dir / ".secret_key"
        if key_file.exists():
            return key_file.read_text(encoding="utf-8").strip()
        key = secrets.token_urlsafe(48)
        key_file.write_text(key, encoding="utf-8")
        try:
            os.chmod(key_file, 0o600)
        except OSError:
            pass
        return key

    def public_dict(self) -> dict:
        """Non-sensitive configuration surface for the UI."""
        return {
            "app_name": self.app_name,
            "app_version": self.app_version,
            "deployment_mode": self.deployment_mode,
            "install_id": self.resolved_install_id,
            "storage_backend": self.storage_backend,
            "ai_provider": self.ai_provider,
            "notification_channels": self.notification_channel_list,
            "allow_registration": self.allow_registration,
            "max_upload_mb": self.max_upload_mb,
            "database_dialect": self.resolved_database_url.split(":", 1)[0],
        }

    @property
    def resolved_install_id(self) -> str:
        if self.install_id:
            return self.install_id
        f = self.resolved_data_dir / ".install_id"
        if f.exists():
            return f.read_text(encoding="utf-8").strip()
        value = "hl_" + secrets.token_hex(6)
        f.write_text(value, encoding="utf-8")
        return value


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()

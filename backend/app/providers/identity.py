"""Identity provider.

Version 1 ships local accounts (email + scrypt password). The interface exists so
that an OIDC / LDAP / passkey provider can be added for gateway deployments in
schools, shared flats or small offices *without* rewriting the auth routers.

`supports_password` and `supports_external` tell the UI which login affordances
to render.
"""

from __future__ import annotations

from abc import ABC, abstractmethod


class IdentityProvider(ABC):
    name: str = "local"
    supports_password: bool = True
    supports_external: bool = False

    @abstractmethod
    def validate_credentials(self, identifier: str, secret: str, stored_hash: str) -> bool: ...

    def describe(self) -> dict:
        return {
            "name": self.name,
            "supports_password": self.supports_password,
            "supports_external": self.supports_external,
        }


class LocalIdentityProvider(IdentityProvider):
    name = "local"

    def validate_credentials(self, identifier: str, secret: str, stored_hash: str) -> bool:
        from ..security import verify_password

        return verify_password(secret, stored_hash)


class OIDCIdentityProvider(IdentityProvider):
    """Placeholder for a future `HOMELEDGER_IDENTITY=oidc` deployment."""

    name = "oidc"
    supports_password = False
    supports_external = True

    def validate_credentials(self, identifier: str, secret: str, stored_hash: str) -> bool:
        raise NotImplementedError(
            "OIDC 身份提供方尚未启用。请使用本地账号，或在 providers/identity.py 中实现。"
        )


_provider = LocalIdentityProvider()


def get_identity_provider() -> IdentityProvider:
    return _provider

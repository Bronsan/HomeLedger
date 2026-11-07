"""Replaceable infrastructure providers.

Everything that touches the outside world sits behind one of these interfaces:

    DatabaseProvider      db.py
    FileStorageProvider   storage.py
    NotificationProvider  notification.py
    IdentityProvider      identity.py
    AIProvider            ai.py
    BackupProvider        backup.py
    DeploymentConfig      deployment.py

The rule of thumb: the domain layer may depend on the *interface*, never on a
concrete vendor. Adding S3 or a cloud OCR vendor must not require touching a
single router.
"""

from .ai import AIProvider, get_ai_provider
from .backup import BackupProvider, get_backup_provider
from .deployment import DeploymentConfig, get_deployment_config
from .identity import IdentityProvider, get_identity_provider
from .notification import NotificationProvider, get_notification_providers
from .storage import FileStorageProvider, get_storage_provider

__all__ = [
    "AIProvider",
    "BackupProvider",
    "DeploymentConfig",
    "FileStorageProvider",
    "IdentityProvider",
    "NotificationProvider",
    "get_ai_provider",
    "get_backup_provider",
    "get_deployment_config",
    "get_identity_provider",
    "get_notification_providers",
    "get_storage_provider",
]

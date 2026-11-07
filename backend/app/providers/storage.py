"""Attachment storage: local filesystem now, S3-compatible object storage later.

Path layout (local):

    <data>/uploads/<family_id>/<owner_id>/<uuid>_<safe_name>
    <data>/uploads/<family_id>/<owner_id>/thumbs/<uuid>.jpg

The `relative_path` stored in the database is always provider-neutral, so a
future migration job can stream every blob to a bucket and rewrite the prefix
without changing the schema.
"""

from __future__ import annotations

import re
import uuid
from abc import ABC, abstractmethod
from dataclasses import dataclass
from pathlib import Path

from ..config import settings

_SAFE = re.compile(r"[^A-Za-z0-9._\-\u4e00-\u9fff]+")


@dataclass
class StoredFile:
    relative_path: str
    stored_name: str
    size_bytes: int
    sha256: str
    thumbnail_path: str | None = None


def safe_name(name: str, fallback: str = "file") -> str:
    base = Path(name or fallback).name
    cleaned = _SAFE.sub("_", base).strip("._") or fallback
    return cleaned[:120]


class FileStorageProvider(ABC):
    name: str = "base"

    @abstractmethod
    def save(
        self, data: bytes, *, family_id: str, owner_id: str, filename: str
    ) -> StoredFile: ...

    @abstractmethod
    def read(self, relative_path: str) -> bytes: ...

    @abstractmethod
    def delete(self, relative_path: str) -> None: ...

    def read_thumbnail(self, relative_path: str) -> bytes | None:
        thumb = self.thumbnail_path(relative_path)
        if thumb:
            try:
                return self.read(thumb)
            except FileNotFoundError:
                return None
        return None

    def thumbnail_path(self, relative_path: str) -> str | None:
        return None

    def health(self) -> dict:
        return {"ok": True, "backend": self.name}


class LocalStorage(FileStorageProvider):
    name = "local"

    def __init__(self, root: Path | None = None) -> None:
        self.root = Path(root or settings.upload_dir)
        self.root.mkdir(parents=True, exist_ok=True)

    def _abs(self, relative_path: str) -> Path:
        p = (self.root / relative_path).resolve()
        if not p.is_relative_to(self.root.resolve()):
            raise ValueError("非法的存储路径")
        return p

    def save(
        self, data: bytes, *, family_id: str, owner_id: str, filename: str
    ) -> StoredFile:
        import hashlib

        digest = hashlib.sha256(data).hexdigest()
        ext = Path(filename).suffix.lower()[:12]
        uid = uuid.uuid4().hex
        folder = Path(family_id) / owner_id
        target_dir = self.root / folder
        target_dir.mkdir(parents=True, exist_ok=True)
        stored_name = f"{uid}{ext}"
        abs_path = target_dir / stored_name
        abs_path.write_bytes(data)

        thumb_rel = None
        if ext in {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".heic"}:
            thumb_rel = self._make_thumbnail(abs_path, folder, uid)

        rel = (folder / stored_name).as_posix()
        try:
            mode = 0o640
            abs_path.chmod(mode)
        except OSError:
            pass
        return StoredFile(
            relative_path=rel,
            stored_name=stored_name,
            size_bytes=len(data),
            sha256=digest,
            thumbnail_path=thumb_rel,
        )

    def _make_thumbnail(self, abs_path: Path, folder: Path, uid: str) -> str | None:
        try:
            from PIL import Image, ImageOps

            with Image.open(abs_path) as img:
                if img.width * img.height > 16_000_000:
                    return None
                img = ImageOps.exif_transpose(img)
                img.thumbnail((640, 640))
                if img.mode not in ("RGB", "L"):
                    img = img.convert("RGB")
                thumb_dir = self.root / folder / "thumbs"
                thumb_dir.mkdir(parents=True, exist_ok=True)
                out = thumb_dir / f"{uid}.jpg"
                img.save(out, "JPEG", quality=82, optimize=True)
                return (folder / "thumbs" / f"{uid}.jpg").as_posix()
        except Exception:
            return None

    def read(self, relative_path: str) -> bytes:
        return self._abs(relative_path).read_bytes()

    def delete(self, relative_path: str) -> None:
        for rel in (relative_path, self.thumbnail_path(relative_path)):
            if not rel:
                continue
            try:
                self._abs(rel).unlink(missing_ok=True)
            except Exception:
                pass

    def thumbnail_path(self, relative_path: str) -> str | None:
        p = Path(relative_path)
        # thumbs/<uuid>.jpg is derived from <uuid>.ext
        stem = p.stem.split("_")[0]
        return (p.parent / "thumbs" / f"{stem}.jpg").as_posix()

    def health(self) -> dict:
        try:
            probe = self.root / ".probe"
            probe.write_text("ok", encoding="utf-8")
            probe.unlink()
            return {"ok": True, "backend": "local", "root": str(self.root)}
        except Exception as exc:
            return {"ok": False, "backend": "local", "error": str(exc)}


class S3Storage(FileStorageProvider):
    """S3 / MinIO / R2 target.

    Requires the optional `boto3` dependency. Kept behind the interface so a
    gateway deployment with a NAS does not pay for it.
    """

    name = "s3"

    def __init__(self) -> None:
        try:
            import boto3
        except ImportError as exc:  # pragma: no cover
            raise RuntimeError(
                "S3 存储需要安装 boto3：pip install boto3。或设置 HOMELEDGER_STORAGE_BACKEND=local"
            ) from exc

        self.bucket = settings.s3_bucket
        self.client = boto3.client(
            "s3",
            endpoint_url=settings.s3_endpoint or None,
            aws_access_key_id=settings.s3_access_key or None,
            aws_secret_access_key=settings.s3_secret_key or None,
            region_name=settings.s3_region or None,
        )

    def save(
        self, data: bytes, *, family_id: str, owner_id: str, filename: str
    ) -> StoredFile:
        import hashlib

        digest = hashlib.sha256(data).hexdigest()
        ext = Path(filename).suffix.lower()[:12]
        key = f"{family_id}/{owner_id}/{uuid.uuid4().hex}{ext}"
        self.client.put_object(
            Bucket=self.bucket, Key=key, Body=data, ContentType="application/octet-stream"
        )
        return StoredFile(
            relative_path=key,
            stored_name=Path(key).name,
            size_bytes=len(data),
            sha256=digest,
        )

    def read(self, relative_path: str) -> bytes:
        obj = self.client.get_object(Bucket=self.bucket, Key=relative_path)
        return obj["Body"].read()

    def delete(self, relative_path: str) -> None:
        try:
            self.client.delete_object(Bucket=self.bucket, Key=relative_path)
        except Exception:
            pass

    def health(self) -> dict:
        try:
            self.client.head_bucket(Bucket=self.bucket)
            return {"ok": True, "backend": "s3", "bucket": self.bucket}
        except Exception as exc:
            return {"ok": False, "backend": "s3", "error": str(exc)}


_provider: FileStorageProvider | None = None


def get_storage_provider() -> FileStorageProvider:
    global _provider
    if _provider is None:
        _provider = S3Storage() if settings.storage_backend == "s3" else LocalStorage()
    return _provider

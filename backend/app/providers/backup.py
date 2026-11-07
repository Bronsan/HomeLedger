"""Validated local SQLite archives (database, uploads and encrypted sync blobs).

This is not a PostgreSQL/S3 disaster-recovery implementation. Restore requires a
maintenance window with one process and no other active readers or writers.
Signing/JWT secrets are intentionally not copied; preserve them separately.
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import sqlite3
import stat
import tempfile
import time
import zipfile
from abc import ABC, abstractmethod
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path, PureWindowsPath

from sqlalchemy import select
from sqlalchemy.engine import make_url

from ..config import settings
from ..models import BackupRecord

MAX_ENTRIES = 50_000
MAX_ENTRY_BYTES = 2 * 1024**3
MAX_TOTAL_BYTES = 8 * 1024**3
MAX_RATIO = 1000
REQUIRED_TABLES = {"users", "families", "memberships", "items", "attachments", "backups", "schema_migrations"}


class BackupProvider(ABC):
    name = "local"

    @abstractmethod
    def create(self, *, include_files: bool, note: str, created_by: str) -> dict: ...

    @abstractmethod
    def list_files(self) -> list[dict]: ...

    @abstractmethod
    def path_of(self, filename: str) -> Path: ...

    def health(self) -> dict:
        supported = settings.resolved_database_url.startswith("sqlite") and settings.storage_backend == "local"
        return {"ok": supported, "backend": self.name, "dir": str(settings.backup_dir),
                "scope": "SQLite + local uploads + sync blobs", "requires_maintenance_restore": True}


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _database_path() -> Path:
    url = make_url(settings.resolved_database_url)
    if url.get_backend_name() != "sqlite" or not url.database or url.database == ":memory:":
        raise ValueError("此备份仅支持文件型 SQLite；PostgreSQL 请使用独立备份恢复工具")
    if settings.storage_backend != "local":
        raise ValueError("对象存储备份尚未实现，请使用数据库与对象存储的联合备份流程")
    return Path(url.database).resolve()


def _validate_database(path: Path) -> None:
    if not path.is_file() or path.stat().st_size < 100 or path.read_bytes()[:16] != b"SQLite format 3\x00":
        raise ValueError("缺少有效 SQLite 数据库")
    with closing(sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)) as con:
        con.execute("PRAGMA trusted_schema=OFF")
        con.execute("PRAGMA query_only=ON")
        if con.execute("PRAGMA quick_check").fetchall() != [("ok",)]:
            raise ValueError("数据库完整性校验失败")
        tables = {row[0] for row in con.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if not REQUIRED_TABLES.issubset(tables):
            raise ValueError("归档不是支持的 HomeLedger 数据库")


def _entry_parts(name: str) -> list[str]:
    win = PureWindowsPath(name)
    parts = name.rstrip("/").split("/")
    if not name or "\\" in name or ":" in name or "\x00" in name or win.drive or name.startswith("/"):
        raise ValueError("归档包含非法路径")
    if any(not p or p in {".", ".."} or p.rstrip(" .") != p or PureWindowsPath(p).is_reserved() for p in parts):
        raise ValueError("归档包含非法路径组件")
    if parts[0] not in {"manifest.json", "database.db", "uploads", "sync"}:
        raise ValueError("归档包含不支持的条目")
    if parts[0] in {"manifest.json", "database.db"} and len(parts) != 1:
        raise ValueError("归档布局不正确")
    return parts


def _extract_validated(source: Path, target: Path) -> tuple[dict, int]:
    try:
        with zipfile.ZipFile(source) as archive:
            entries = archive.infolist()
            if len(entries) > MAX_ENTRIES:
                raise ValueError("归档条目过多")
            seen: set[str] = set()
            total = 0
            for entry in entries:
                parts = _entry_parts(entry.filename)
                name = "/".join(parts).casefold()
                mode = entry.external_attr >> 16
                kind = stat.S_IFMT(mode)
                if name in seen or kind not in {0, stat.S_IFREG, stat.S_IFDIR} or entry.flag_bits & 1:
                    raise ValueError("归档含重复、链接、特殊或加密条目")
                seen.add(name)
                total += entry.file_size
                if (entry.file_size > MAX_ENTRY_BYTES or total > MAX_TOTAL_BYTES or
                        entry.file_size > max(1, entry.compress_size) * MAX_RATIO):
                    raise ValueError("归档超过解压资源限制")
                if parts[0] == "manifest.json" and entry.file_size > 65536:
                    raise ValueError("归档清单过大")
                if entry.is_dir() and parts[0] in {"database.db", "manifest.json"}:
                    raise ValueError("归档核心文件不正确")
            # Explicit reads, never extractall. Size/CRC are also checked by ZipFile.
            for entry in entries:
                dest = target.joinpath(*_entry_parts(entry.filename))
                if entry.is_dir():
                    dest.mkdir(parents=True, exist_ok=True)
                    continue
                dest.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(entry) as src, dest.open("xb") as out:
                    copied = 0
                    while chunk := src.read(1024 * 1024):
                        copied += len(chunk)
                        if copied > entry.file_size or copied > MAX_ENTRY_BYTES:
                            raise ValueError("归档实际大小不符")
                        out.write(chunk)
                    if copied != entry.file_size:
                        raise ValueError("归档被截断")
        manifest = json.loads((target / "manifest.json").read_text("utf-8"))
        if not isinstance(manifest, dict) or manifest.get("app") != settings.app_name or type(manifest.get("includes_files")) is not bool:
            raise ValueError("归档清单不正确")
        _validate_database(target / "database.db")
        return manifest, len(entries)
    except (zipfile.BadZipFile, sqlite3.Error, UnicodeError, json.JSONDecodeError, FileNotFoundError) as exc:
        raise ValueError("归档或数据库校验失败") from exc


class LocalBackupProvider(BackupProvider):
    def _reserve(self) -> Path:
        stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
        for attempt in range(1, 100):
            name = f"homeledger-{stamp}.zip" if attempt == 1 else f"homeledger-{stamp}-{attempt}.zip"
            candidate = settings.backup_dir / name
            try:
                fd = os.open(candidate, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            except FileExistsError:
                continue
            os.close(fd)
            return candidate
        raise RuntimeError("无法分配备份文件名")

    def create(self, *, include_files: bool, note: str, created_by: str) -> dict:
        db_path = _database_path()
        if not db_path.is_file():
            raise ValueError("数据库文件不存在，拒绝创建空备份")
        target = self._reserve()
        try:
            with tempfile.TemporaryDirectory(prefix="hl-backup-") as tmp:
                snapshot = Path(tmp) / "database.db"
                with closing(sqlite3.connect(db_path.as_uri() + "?mode=ro", uri=True)) as src, closing(sqlite3.connect(snapshot)) as dst:
                    src.backup(dst)
                _validate_database(snapshot)
                with closing(sqlite3.connect(snapshot)) as con:
                    row = con.execute("SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1").fetchone()
                manifest = {"app": settings.app_name, "version": settings.app_version,
                            "install_id": settings.resolved_install_id, "deployment_mode": settings.deployment_mode,
                            "created_at": datetime.now(timezone.utc).isoformat(), "includes_files": include_files,
                            "note": note, "created_by": created_by, "schema_version": row[0] if row else "",
                            "scope": ["database", "uploads", "sync"] if include_files else ["database"],
                            "secrets_included": False}
                with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
                    archive.write(snapshot, "database.db")
                    archive.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False))
                    if include_files:
                        for folder in ("uploads", "sync"):
                            root = settings.resolved_data_dir / folder
                            if not root.exists():
                                continue
                            for path in root.rglob("*"):
                                if path.is_symlink() or not path.resolve().is_relative_to(root.resolve()):
                                    raise ValueError("备份目录含符号链接或越界文件")
                                if path.is_file():
                                    archive.write(path, f"{folder}/{path.relative_to(root).as_posix()}")
            return {"filename": target.name, "relative_path": target.name,
                    "size_bytes": target.stat().st_size, "sha256": _sha256(target),
                    "note": note, "includes_files": include_files, "created_by": created_by}
        except BaseException:
            target.unlink(missing_ok=True)
            raise

    def list_files(self) -> list[dict]:
        return [{"filename": p.name, "size_bytes": p.stat().st_size,
                 "modified_at": datetime.fromtimestamp(p.stat().st_mtime, tz=timezone.utc).isoformat()}
                for p in sorted(settings.backup_dir.glob("*.zip"), reverse=True) if p.is_file() and not p.is_symlink()]

    def path_of(self, filename: str) -> Path:
        if not filename or any(c in filename for c in '/\\:\x00') or filename in {".", ".."} or not filename.endswith(".zip") or filename.rstrip(" .") != filename:
            raise ValueError("非法的备份文件名")
        path = settings.backup_dir / filename
        if path.is_symlink() or path.resolve().parent != settings.backup_dir.resolve():
            raise ValueError("非法的备份文件路径")
        if not path.is_file():
            raise FileNotFoundError(filename)
        return path


_provider = LocalBackupProvider()


def get_backup_provider() -> BackupProvider:
    return _provider


def prune_old_backups(db) -> list[str]:
    keep = settings.backup_keep
    if keep <= 0:
        return []
    db.flush()
    rows = list(db.execute(select(BackupRecord).order_by(BackupRecord.created_at.desc(), BackupRecord.id.desc())).scalars())
    removed = []
    for row in rows[keep:]:
        try:
            _provider.path_of(row.filename).unlink(missing_ok=True)
        except (ValueError, FileNotFoundError, OSError):
            pass
        db.delete(row)
        removed.append(row.filename)
    return removed


def _sqlite_sidecars(db_path: Path) -> list[Path]:
    return [db_path.with_name(db_path.name + suffix) for suffix in ("-wal", "-shm")]


def _remove_sidecars(db_path: Path, attempts: int = 10) -> None:
    for sidecar in _sqlite_sidecars(db_path):
        for attempt in range(attempts):
            try:
                sidecar.unlink(missing_ok=True)
                break
            except OSError as exc:
                if attempt == attempts - 1:
                    raise RuntimeError("数据库仍被占用，请停止其他进程后恢复") from exc
                time.sleep(0.05 * (attempt + 1))


def restore_from_zip(filename: str) -> dict:
    source = get_backup_provider().path_of(filename)
    db_path = _database_path()
    with tempfile.TemporaryDirectory(prefix="hl-restore-", dir=settings.resolved_data_dir) as tmp:
        stage = Path(tmp)
        manifest, count = _extract_validated(source, stage)
        from ..db import provider as db_provider
        # Everything above is read-only with respect to the live DB/files.
        db_provider.engine.dispose()
        if db_path.exists():
            with closing(sqlite3.connect(db_path)) as con:
                checkpoint = con.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()
                if checkpoint and checkpoint[0]:
                    raise RuntimeError("数据库仍有活跃连接，恢复已中止")
        _remove_sidecars(db_path)
        # The staged DB is on the data volume, but an explicit DB path may be on
        # another volume. Stage the replacement beside that path before rename.
        fd, staged_name = tempfile.mkstemp(prefix=".hl-restore-", dir=db_path.parent)
        os.close(fd)
        replacement = Path(staged_name)
        try:
            shutil.copy2(stage / "database.db", replacement)
            restored = 0
            if manifest["includes_files"]:
                for folder in ("uploads", "sync"):
                    root = settings.resolved_data_dir / folder
                    for path in (stage / folder).rglob("*"):
                        if not path.is_file():
                            continue
                        dest = root / path.relative_to(stage / folder)
                        if not dest.resolve().is_relative_to(root.resolve()) or dest.is_symlink():
                            raise ValueError("目标存储目录包含越界链接")
                        dest.parent.mkdir(parents=True, exist_ok=True)
                        shutil.copy2(path, dest)
                        restored += 1
            os.replace(replacement, db_path)
        finally:
            replacement.unlink(missing_ok=True)
        return {"entries": count, "restored_files": restored, "database": "SQLite",
                "includes_files": manifest["includes_files"]}

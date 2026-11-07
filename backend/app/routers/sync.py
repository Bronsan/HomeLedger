"""Replication endpoints.

Every HomeLedger client keeps a complete copy of the family data and keeps
working with the network unplugged. This router is the only thing the server
has to provide for that model: a per-family sequence to pull from, an
idempotent sink to push into, and a bucket for encrypted blobs.

Two rules shape the implementation:

1. **The server is not the source of truth.** It stores the newest state each
   device reports, ordered by a hybrid logical clock. It never re-derives
   business state from the replication payload, because that would mean
   duplicating every validation rule in two languages and letting the two
   drift.

2. **The server cannot read private fields.** `meta` exists so a freshly
   paired device can show a list before the user types the sync passphrase.
   Everything else lives in `secret`, which is XChaCha20-Poly1305 ciphertext produced
   on the client. No code path here decrypts it, and no key material that would
   allow one is ever uploaded.
"""

from __future__ import annotations

import hashlib
import json
import logging
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from ..config import settings
from ..db import get_db
from ..deps import Principal, require
from ..models import (
    SyncBlob,
    SyncDevice,
    SyncFamilyState,
    SyncKey,
    SyncRecord,
    iso,
    utcnow,
)
from ..permissions import ITEM_CREATE, ITEM_VIEW, SYSTEM_DEPLOY
from ..sync_contract import SyncKeyIn, SyncResetIn

log = logging.getLogger("homeledger.sync")

router = APIRouter(tags=["sync"])

# A household is not a data centre. These ceilings exist so a buggy client
# cannot fill the disk before anyone notices; they sit far above normal use.
MAX_RECORDS_PER_PUSH = 500
MAX_META_BYTES = 16 * 1024
MAX_SECRET_BYTES = 512 * 1024
MAX_BLOB_BYTES = 64 * 1024 * 1024
MAX_PULL = 500

ENTITIES = {
    "family",
    "member",
    "location",
    "category",
    "item",
    "component",
    "batch",
    "attachment",
    "maintenance",
    "loan",
    "event",
    "notification",
}


def _blob_root() -> Path:
    path = Path(settings.resolved_data_dir) / "sync"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _record_out(r: SyncRecord) -> dict:
    return {
        "entity": r.entity,
        "id": r.entity_id,
        "hlc": r.hlc,
        "op": r.op,
        "meta": r.meta or {},
        "secret": r.secret,
        "blobs": r.blob_ids or [],
        "device_id": r.device_id,
        "seq": r.seq,
        "updated_at": iso(r.updated_at),
    }


def _touch_device(
    db: Session,
    family_id: str,
    device_id: str,
    name: str,
    kind: str,
    version: str,
    cursor: int | None = None,
) -> SyncDevice:
    device = db.get(SyncDevice, device_id)
    if device is None:
        device = SyncDevice(
            id=device_id,
            family_id=family_id,
            name=(name or "")[:120],
            kind=(kind or "desktop")[:24],
            app_version=(version or "")[:32],
        )
        db.add(device)
        db.flush()
    if device.family_id != family_id:
        # Device ids are client generated. A collision across families means a
        # copied data directory or a malicious client; either way we must not
        # let one family's device alias another's.
        raise HTTPException(status.HTTP_409_CONFLICT, "设备标识已被其他家庭占用，请重新配对")
    device.name = (name or device.name)[:120]
    device.kind = (kind or device.kind)[:24]
    device.app_version = (version or device.app_version)[:32]
    device.last_seen_at = utcnow()
    if cursor is not None:
        device.last_cursor = max(device.last_cursor, cursor)
    return device


def _head(db: Session, family_id: str) -> SyncFamilyState:
    state = db.get(SyncFamilyState, family_id)
    if state is None:
        state = SyncFamilyState(family_id=family_id, head=0)
        db.add(state)
        db.flush()
    return state


@router.get("/sync/status")
def sync_status(
    principal: Principal = Depends(require(ITEM_VIEW)), db: Session = Depends(get_db)
) -> dict:
    fid = principal.family_id
    state = db.get(SyncFamilyState, fid)
    count = db.execute(
        select(func.count()).select_from(SyncRecord).where(SyncRecord.family_id == fid)
    ).scalar()
    blob_count, blob_bytes = db.execute(
        select(func.count(SyncBlob.id), func.coalesce(func.sum(SyncBlob.size_bytes), 0)).where(
            SyncBlob.family_id == fid
        )
    ).one()
    key = db.get(SyncKey, fid)
    devices = db.execute(
        select(SyncDevice)
        .where(SyncDevice.family_id == fid)
        .order_by(SyncDevice.last_seen_at.desc())
    ).scalars()
    return {
        "enabled": True,
        "head": int(state.head if state else 0),
        "record_count": int(count or 0),
        "blob_count": int(blob_count or 0),
        "blob_bytes": int(blob_bytes or 0),
        "e2ee": bool(key and key.wrapped_dek),
        "devices": [
            {
                "id": d.id,
                "name": d.name,
                "kind": d.kind,
                "app_version": d.app_version,
                "last_cursor": d.last_cursor,
                "first_seen_at": iso(d.first_seen_at),
                "last_seen_at": iso(d.last_seen_at),
            }
            for d in devices
        ],
    }


# --- end-to-end encryption --------------------------------------------------
@router.get("/sync/key")
def get_key(
    principal: Principal = Depends(require(ITEM_VIEW)), db: Session = Depends(get_db)
) -> dict:
    """Public key material. Safe to hand to any member: it is a salt and a key
    wrapped by a passphrase the server never sees."""
    key = db.get(SyncKey, principal.family_id)
    if key is None or not key.wrapped_dek:
        return {"configured": False}
    return {
        "configured": True,
        "kdf": key.kdf,
        "salt": key.salt,
        "memory_kib": key.memory_kib,
        "iterations": key.iterations,
        "parallelism": key.parallelism,
        "wrapped_dek": key.wrapped_dek,
        "verifier": key.verifier,
        "updated_at": iso(key.updated_at),
    }


@router.post("/sync/key")
def put_key(
    payload: SyncKeyIn,
    principal: Principal = Depends(require(SYSTEM_DEPLOY)),
    db: Session = Depends(get_db),
) -> dict:
    payload = payload.model_dump()
    wrapped = str(payload.get("wrapped_dek") or "")
    salt = str(payload.get("salt") or "")
    verifier = str(payload.get("verifier") or "")
    if not wrapped or not salt or not verifier:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "缺少密钥材料")
    if len(wrapped) > 4096:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "密钥材料过大")

    key = db.get(SyncKey, principal.family_id)
    created = key is None or not key.wrapped_dek
    if key is None:
        key = SyncKey(family_id=principal.family_id)
        db.add(key)
    elif not created and not payload.get("rotate"):
        # Silently replacing the key would orphan every existing secret. The
        # caller has to say "rotate" out loud, and the UI has to warn first.
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "该家庭已设置同步口令。轮换密钥会让旧数据无法解密，请使用「轮换」入口",
        )
    key.kdf = str(payload.get("kdf") or "argon2id")[:24]
    key.salt = salt[:64]
    key.memory_kib = int(payload.get("memory_kib") or 65536)
    key.iterations = int(payload.get("iterations") or 3)
    key.parallelism = int(payload.get("parallelism") or 1)
    key.wrapped_dek = wrapped
    key.verifier = verifier[:512]
    key.updated_at = utcnow()
    db.commit()
    return {"ok": True, "created": created}


@router.delete("/sync/key")
def delete_key(
    principal: Principal = Depends(require(SYSTEM_DEPLOY)), db: Session = Depends(get_db)
) -> dict:
    """Removes the wrapped key. Existing ciphertext stays unreadable — that is
    the point: this is the "forget the passphrase everywhere" escape hatch."""
    db.execute(delete(SyncKey).where(SyncKey.family_id == principal.family_id))
    db.commit()
    return {"ok": True}


# --- replication ------------------------------------------------------------
@router.get("/sync/pull")
def pull(
    since: int = Query(default=0, ge=0),
    limit: int = Query(default=200, ge=1, le=MAX_PULL),
    principal: Principal = Depends(require(ITEM_VIEW)),
    db: Session = Depends(get_db),
) -> dict:
    rows = list(
        db.execute(
            select(SyncRecord)
            .where(SyncRecord.family_id == principal.family_id, SyncRecord.seq > since)
            .order_by(SyncRecord.seq)
            .limit(limit)
        ).scalars()
    )
    head = _head(db, principal.family_id).head
    return {
        "records": [_record_out(r) for r in rows],
        "cursor": rows[-1].seq if rows else since,
        "head": int(head),
        "has_more": bool(rows) and len(rows) == limit,
    }


@router.post("/sync/apply")
def apply(
    payload: dict,
    principal: Principal = Depends(require(ITEM_CREATE)),
    db: Session = Depends(get_db),
) -> dict:
    """Idempotent per record: the highest HLC wins.

    When the server's copy is newer, it is returned in `resolved` so the
    pushing device can adopt it in the same round trip instead of waiting for
    the next pull.
    """
    device_id = str(payload.get("device_id") or "").strip()
    if not device_id or len(device_id) > 64:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "device_id 必须为 1–64 字符")
    cursor = payload.get("cursor", 0)
    if type(cursor) is not int or cursor < 0:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "cursor 必须为非负整数")
    records = payload.get("records") or []
    if not isinstance(records, list):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "records 必须是数组")
    if len(records) > MAX_RECORDS_PER_PUSH:
        raise HTTPException(
            status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            f"单次最多推送 {MAX_RECORDS_PER_PUSH} 条记录",
        )

    device = _touch_device(
        db,
        principal.family_id,
        device_id,
        str(payload.get("device_name") or ""),
        str(payload.get("device_kind") or ""),
        str(payload.get("app_version") or ""),
    )
    state = _head(db, principal.family_id)

    applied = 0
    ignored = 0
    resolved: list[dict] = []
    for raw in records:
        if not isinstance(raw, dict):
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "记录必须为对象")
        entity = str(raw.get("entity") or "").strip()
        entity_id = str(raw.get("id") or raw.get("entity_id") or "").strip()
        if not entity or not entity_id or len(entity_id) > 64 or entity not in ENTITIES:
            ignored += 1
            continue

        meta = raw.get("meta") or {}
        if not isinstance(meta, dict):
            meta = {}
        if len(json.dumps(meta, ensure_ascii=False).encode()) > MAX_META_BYTES:
            ignored += 1
            continue
        secret = raw.get("secret")
        if secret is not None:
            secret = str(secret)
            if len(secret.encode()) > MAX_SECRET_BYTES:
                ignored += 1
                continue
        blobs = raw.get("blobs") or []
        if not isinstance(blobs, list):
            blobs = []
        blobs = [str(b)[:64] for b in blobs][:50]
        hlc = str(raw.get("hlc") or "")[:48]
        op = "delete" if raw.get("op") == "delete" else "upsert"

        existing = db.get(SyncRecord, (principal.family_id, entity, entity_id))
        if existing is not None and existing.hlc >= hlc:
            # Their copy is at least as new. Return ours so they converge now.
            if existing.hlc > hlc:
                resolved.append(_record_out(existing))
            ignored += 1
            continue

        state.head += 1
        if existing is None:
            db.add(
                SyncRecord(
                    family_id=principal.family_id,
                    entity=entity,
                    entity_id=entity_id[:64],
                    hlc=hlc,
                    op=op,
                    meta=meta,
                    secret=secret,
                    blob_ids=blobs,
                    device_id=device_id[:64],
                    seq=state.head,
                )
            )
        else:
            existing.hlc = hlc
            existing.op = op
            existing.meta = meta
            existing.secret = secret
            existing.blob_ids = blobs
            existing.device_id = device_id[:64]
            existing.seq = state.head
            existing.updated_at = utcnow()
        applied += 1

    device.last_cursor = max(device.last_cursor, int(payload.get("cursor") or 0))
    db.commit()
    return {
        "applied": applied,
        "ignored": ignored,
        "resolved": resolved,
        "head": state.head,
    }


@router.post("/sync/reset")
def reset(
    payload: SyncResetIn,
    principal: Principal = Depends(require(SYSTEM_DEPLOY)),
    db: Session = Depends(get_db),
) -> dict:
    """Wipes the replication state. Refuses unless the caller echoes the head,
    which makes an accidental click impossible."""
    confirm = payload.confirm_head
    head = _head(db, principal.family_id).head
    if confirm != int(head):
        raise HTTPException(status.HTTP_409_CONFLICT, "确认值不匹配：请先读取服务器状态再操作")
    db.execute(delete(SyncRecord).where(SyncRecord.family_id == principal.family_id))
    db.execute(delete(SyncBlob).where(SyncBlob.family_id == principal.family_id))
    db.execute(delete(SyncDevice).where(SyncDevice.family_id == principal.family_id))
    db.execute(
        delete(SyncFamilyState).where(SyncFamilyState.family_id == principal.family_id)
    )
    db.commit()
    return {"ok": True, "removed_head": confirm}


# --- encrypted blobs --------------------------------------------------------
@router.put("/sync/blob/{blob_id}")
async def put_blob(
    blob_id: str,
    request: Request,
    principal: Principal = Depends(require(ITEM_CREATE)),
    db: Session = Depends(get_db),
) -> dict:
    safe = "".join(ch for ch in blob_id if ch.isalnum() or ch in "-_")
    if safe != blob_id or not blob_id or len(blob_id) > 64:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "非法的 blob id")

    body = await request.body()
    if not body:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "空内容")
    if len(body) > MAX_BLOB_BYTES:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "单个加密附件超过 64MB")

    existing = db.get(SyncBlob, blob_id)
    if existing and existing.family_id != principal.family_id:
        raise HTTPException(status.HTTP_409_CONFLICT, "blob id 冲突")

    digest = hashlib.sha256(body).hexdigest()
    folder = _blob_root() / principal.family_id[:8]
    folder.mkdir(parents=True, exist_ok=True)
    target = folder / f"{blob_id}.bin"
    # Write to a temp file and rename: a half-written blob that the database
    # already points at is worse than no blob at all.
    tmp = target.with_suffix(".tmp")
    tmp.write_bytes(body)
    tmp.replace(target)

    if existing is None:
        db.add(
            SyncBlob(
                id=blob_id,
                family_id=principal.family_id,
                size_bytes=len(body),
                sha256=digest,
                storage_key=str(target),
            )
        )
    else:
        existing.size_bytes = len(body)
        existing.sha256 = digest
        existing.storage_key = str(target)
    db.commit()
    return {"ok": True, "id": blob_id, "size_bytes": len(body), "sha256": digest}


@router.get("/sync/blob/{blob_id}")
def get_blob(
    blob_id: str,
    principal: Principal = Depends(require(ITEM_VIEW)),
    db: Session = Depends(get_db),
) -> Response:
    blob = db.get(SyncBlob, blob_id)
    if blob is None or blob.family_id != principal.family_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "附件不存在")
    path = (_blob_root() / principal.family_id[:8] / f"{blob_id}.bin").resolve()
    if not path.is_relative_to(_blob_root().resolve()):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "附件不存在")
    if not path.exists():
        raise HTTPException(status.HTTP_410_GONE, "附件内容已丢失，请从仍有副本的设备重新上传")
    return Response(
        content=path.read_bytes(),
        media_type="application/octet-stream",
        headers={"X-Blob-Sha256": blob.sha256, "Cache-Control": "private, max-age=3600"},
    )


@router.delete("/sync/blob/{blob_id}")
def delete_blob(
    blob_id: str,
    principal: Principal = Depends(require(ITEM_CREATE)),
    db: Session = Depends(get_db),
) -> dict:
    blob = db.get(SyncBlob, blob_id)
    if blob is None or blob.family_id != principal.family_id:
        return {"ok": True}
    try:
        path = (_blob_root() / principal.family_id[:8] / f"{blob_id}.bin").resolve()
        if not path.is_relative_to(_blob_root().resolve()):
            raise HTTPException(status.HTTP_404_NOT_FOUND, "附件不存在")
        path.unlink(missing_ok=True)
    except OSError:  # pragma: no cover - filesystem races
        log.warning("无法删除 blob 文件 %s", blob.storage_key)
    db.delete(blob)
    db.commit()
    return {"ok": True}


@router.delete("/sync/device/{device_id}")
def forget_device(
    device_id: str,
    principal: Principal = Depends(require(ITEM_CREATE)),
    db: Session = Depends(get_db),
) -> dict:
    device = db.get(SyncDevice, device_id)
    if device and device.family_id == principal.family_id:
        db.delete(device)
        db.commit()
    return {"ok": True}


__all__ = ["router"]

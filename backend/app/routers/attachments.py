"""Attachment upload / download.

Downloads accept `?token=` because <img> tags cannot set an Authorization
header. The dependency layer only honours that fallback for attachment and label
paths, and the token is still a full signature-verified JWT.
"""

from __future__ import annotations

from urllib.parse import quote

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, Response, UploadFile, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..audit import add_event, record
from ..config import settings
from ..db import get_db
from ..deps import require
from ..models import Attachment, Item, MaintenanceTask, utcnow
from ..permissions import DOC_DELETE, DOC_DOWNLOAD, DOC_UPLOAD, DOC_VIEW, Principal
from ..providers.storage import get_storage_provider
from ..serializers import attachment_out

router = APIRouter(tags=["attachments"])

ALLOWED_KINDS = {"photo", "invoice", "manual", "receipt", "warranty", "contract", "other"}


@router.post("/attachments", status_code=201)
async def upload_attachment(
    request: Request,
    file: UploadFile = File(...),
    item_id: str | None = Form(default=None),
    maintenance_id: str | None = Form(default=None),
    kind: str = Form(default="photo"),
    set_cover: bool = Form(default=False),
    principal: Principal = Depends(require(DOC_UPLOAD)),
    db: Session = Depends(get_db),
) -> dict:
    if kind not in ALLOWED_KINDS:
        kind = "other"
    limit = settings.max_upload_mb * 1024 * 1024
    data = await file.read(limit + 1)
    if len(data) == 0:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "文件为空")
    if len(data) > limit:
        raise HTTPException(
            status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            f"文件超过 {settings.max_upload_mb}MB 限制",
        )

    if maintenance_id:
        task = db.get(MaintenanceTask, maintenance_id)
        if not task or task.deleted_at or task.family_id != principal.family_id:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "保养任务不存在")
        if item_id and item_id != task.item_id:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "附件的物品与保养任务不一致")
        item_id = task.item_id
    item: Item | None = None
    if item_id:
        item = db.get(Item, item_id)
        if not item or item.deleted_at or item.family_id != principal.family_id:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "物品不存在")

    stored = get_storage_provider().save(
        data,
        family_id=principal.family_id,
        owner_id=item_id or "general",
        filename=file.filename or "upload.bin",
    )
    att = Attachment(
        family_id=principal.family_id,
        item_id=item_id,
        maintenance_id=maintenance_id,
        kind=kind,
        original_name=(file.filename or "upload.bin")[:255],
        stored_name=stored.stored_name,
        relative_path=stored.relative_path,
        mime_type=file.content_type or "application/octet-stream",
        size_bytes=stored.size_bytes,
        sha256=stored.sha256,
        uploaded_by=principal.user_id,
    )
    db.add(att)
    db.flush()

    if set_cover and item:
        item.cover_attachment_id = att.id
        item.version += 1
    if item:
        add_event(
            db, principal, item, "attachment",
            f"上传附件：{att.original_name}", {"kind": kind, "size": att.size_bytes},
        )
    record(
        db, principal, "attachment.upload", entity_type="attachment", entity_id=att.id,
        summary=f"上传 {kind}：{att.original_name}", request=request,
    )
    db.commit()
    return {"attachment": attachment_out(att)}


@router.get("/attachments/{attachment_id}/raw")
def download_attachment(
    attachment_id: str,
    request: Request,
    variant: str = "orig",
    principal: Principal = Depends(require(DOC_VIEW)),
    db: Session = Depends(get_db),
) -> Response:
    att = db.get(Attachment, attachment_id)
    if not att or att.family_id != principal.family_id or att.deleted_at:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "附件不存在")
    if variant not in {"orig", "thumb"}:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "不支持的附件版本")
    if variant == "orig" and not principal.can(DOC_DOWNLOAD):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "缺少下载附件原件的权限")
    storage = get_storage_provider()
    try:
        if variant == "thumb":
            payload = storage.read_thumbnail(att.relative_path)
            if payload is None:
                raise HTTPException(status.HTTP_404_NOT_FOUND, "此附件没有可安全预览的缩略图")
        else:
            payload = storage.read(att.relative_path)
    except FileNotFoundError:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "文件已丢失")

    filename = att.original_name
    # The uploader controls the MIME value. Only server-generated JPEG previews
    # are inline; originals (including HTML/SVG/PDF) are untrusted downloads.
    disposition = "inline" if variant == "thumb" else "attachment"
    return Response(
        content=payload,
        media_type="application/octet-stream" if variant != "thumb" else "image/jpeg",
        headers={
            "Content-Disposition": f"{disposition}; filename*=UTF-8''{quote(filename)}",
            "Cache-Control": "no-store",
            "Content-Security-Policy": "sandbox; default-src 'none'; frame-ancestors 'none'",
            "X-Content-Type-Options": "nosniff",
            "Referrer-Policy": "no-referrer",
            "ETag": f'"{att.sha256[:32]}"',
        },
    )


@router.delete("/attachments/{attachment_id}")
def delete_attachment(
    attachment_id: str,
    request: Request,
    principal: Principal = Depends(require(DOC_DELETE)),
    db: Session = Depends(get_db),
) -> dict:
    att = db.get(Attachment, attachment_id)
    if not att or att.family_id != principal.family_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "附件不存在")
    att.deleted_at = utcnow()
    if att.item_id:
        item = db.get(Item, att.item_id)
        if item and item.cover_attachment_id == att.id:
            item.cover_attachment_id = None
        if item:
            add_event(db, principal, item, "attachment_removed", f"删除附件：{att.original_name}")
    # Delay physical deletion: soft delete keeps the audit trail meaningful.
    record(
        db, principal, "attachment.delete", entity_type="attachment", entity_id=att.id,
        summary=f"删除附件：{att.original_name}", request=request,
    )
    db.commit()
    return {"ok": True}


@router.get("/attachments")
def list_attachments(
    item_id: str | None = None,
    kind: str | None = None,
    principal: Principal = Depends(require(DOC_VIEW)),
    db: Session = Depends(get_db),
) -> dict:
    stmt = select(Attachment).where(
        Attachment.family_id == principal.family_id, Attachment.deleted_at.is_(None)
    )
    if item_id:
        stmt = stmt.where(Attachment.item_id == item_id)
    if kind:
        stmt = stmt.where(Attachment.kind == kind)
    rows = db.execute(stmt.order_by(Attachment.created_at.desc()).limit(500)).scalars().all()
    return {"items": [attachment_out(a) for a in rows]}

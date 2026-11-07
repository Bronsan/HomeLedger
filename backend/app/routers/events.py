"""实时推送：一条 SSE 长连接，告诉页面「有人改了东西」。

为什么不是 WebSocket：这里只需要服务器 → 客户端单向、纯文本、每秒可能一条也
可能一小时一条。SSE 是 HTTP/1.1 上的普通响应，能穿过所有反代、复用现有鉴权、
断线由客户端重连；WebSocket 要额外的握手、心跳、代理配置，换来的是我们不需要
的双向能力。ADR-037 记录了完整取舍。

为什么鉴权走 Authorization 头而不是 `?token=`：`EventSource` 不能设请求头，
只能把 token 拼进 URL——那会被写进 nginx 访问日志、浏览器历史、Referer。
所以客户端不用 `EventSource`，改用 `fetch` + `ReadableStream` 自己读流（见
`frontend/src/lib/live.ts`），代价是三十行帧解析，收益是 token 不落地。

为什么这里不用 `Depends(get_db)`：依赖里的 Session 要到**响应结束**才释放，
而这条响应可能挂几个小时。一个家庭三台设备就是三个长期占用的数据库连接，
SQLite 的池会先被 SSE 占满，然后所有普通请求开始超时。所以鉴权在一个短命的
Session 里做完就关掉，之后这条连接不碰数据库。
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator

from fastapi import APIRouter, Header, HTTPException, Request, status
from fastapi.responses import StreamingResponse

from ..db import provider
from ..deps import resolve_family
from ..models import User
from ..permissions import Principal, effective_permissions
from ..security import decode_token
from ..services import events

router = APIRouter(tags=["events"])

# 心跳间隔。要小于常见反代的 60s 空闲超时，也要小于移动网络的 NAT 超时；
# 25 秒是这两个约束下的常用值。心跳是注释帧（`: ping`），SSE 客户端会忽略，
# 它的唯一作用是让中间设备看到"这条连接还活着"。
HEARTBEAT_SECONDS = 25


def _authenticate(request: Request, authorization: str | None) -> Principal:
    """Resolve the principal and close the database session immediately."""
    token = ""
    if authorization and authorization.lower().startswith("bearer "):
        token = authorization[7:].strip()
    if not token:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "未登录")
    payload = decode_token(token)
    if not payload:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "登录已过期，请重新登录")

    with provider.session() as db:
        user = db.get(User, payload.get("sub", ""))
        if not user or not user.is_active:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "账号不可用")
        if int(payload.get("ver", 1)) != user.token_version:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "会话已失效，请重新登录")
        family = resolve_family(request, db, user)
        membership = request.state.membership
        return Principal(
            user_id=user.id,
            display_name=user.display_name,
            family_id=family.id,
            role=membership.role,
            is_owner=membership.role == "owner",
            permissions=effective_permissions(membership.role, membership.permission_overrides),
        )


def _frame(event: str, data: dict | None = None) -> str:
    body = f"event: {event}\n"
    if data is not None:
        body += f"data: {json.dumps(data, ensure_ascii=False)}\n"
    return body + "\n"


@router.get("/events/stream")
async def stream(
    request: Request,
    authorization: str | None = Header(default=None),
) -> StreamingResponse:
    principal = _authenticate(request, authorization)
    sub = events.subscribe(principal.family_id)

    async def body() -> AsyncIterator[str]:
        try:
            # 先发一帧，客户端才知道"连上了"而不是"还在连"。设置页拿它显示状态点。
            yield _frame("ready", {"family_id": principal.family_id})
            while True:
                if await request.is_disconnected():
                    break
                try:
                    event = await asyncio.wait_for(sub.queue.get(), timeout=HEARTBEAT_SECONDS)
                except asyncio.TimeoutError:
                    yield ": ping\n\n"
                    continue
                yield _frame("change", event)
        finally:
            # 客户端关页面、切网络、进程退出都会走到这里。漏掉这一句，
            # 订阅表就会随每个关掉的标签页长一条，最终 publish 遍历一堆死队列。
            events.unsubscribe(sub)

    return StreamingResponse(
        body(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            # nginx 默认会把响应缓冲到 4KB 再发，SSE 会被它按死。这个头是
            # nginx 认的"别缓冲我"约定；Caddy 和 Apache 不看它，但也不缓冲
            # text/event-stream。
            "X-Accel-Buffering": "no",
        },
    )

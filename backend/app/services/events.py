"""家庭级事件总线：告诉正在看页面的人「有人改了东西」。

这是**提示**，不是数据通道。事件里只有"哪个实体变了"，没有任何行内容：
拿到提示的客户端自己去重新请求当前视图。这个选择决定了整个模块的复杂度——

* 推送数据就要处理顺序、增量、丢失重放、字段版本，最后长成一个糟糕的同步协议；
  而同步协议这个项目已经有了（`sync/engine.ts`），不需要第二个。
* 提示可以在任何地方丢：客户端漏收一条，下一次交互照样能拿到正确数据。
* 事件里不带行内容，也就不存在"推送把别人的数据泄给这一条连接"的可能。

订阅是**进程内**的。多 worker 部署时每个 worker 只知道自己那一份订阅，
所以 A worker 上的写不会唤醒 B worker 上的连接。这一点在 `docs/ARCHITECTURE_DECISIONS.md`
的 ADR-037 里写清楚了：网关模式默认单进程，够用；要多 worker 就得换成 Redis pub/sub，
那是一个明确的下一步，而不是假装已经支持。
"""

from __future__ import annotations

import asyncio
import logging
import threading
from dataclasses import dataclass, field
from datetime import datetime, timezone

log = logging.getLogger("homeledger.events")

# 一个浏览器标签积压超过这么多条，说明它已经跟不上了（切到后台、网络卡住）。
# 与其让它无限吃内存，不如丢掉最旧的：反正提示是"去刷新一下"，丢掉中间几条
# 不影响最终结果，而阻塞写路径会影响所有人。
QUEUE_SIZE = 8


@dataclass(eq=False)  # identity hashing: two subscribers are never "equal"
class Subscriber:
    family_id: str
    queue: asyncio.Queue = field(default_factory=lambda: asyncio.Queue(maxsize=QUEUE_SIZE))
    loop: asyncio.AbstractEventLoop = field(default_factory=asyncio.get_running_loop)


_lock = threading.Lock()
_subscribers: set[Subscriber] = set()


def subscribe(family_id: str, loop: asyncio.AbstractEventLoop | None = None) -> Subscriber:
    """Register one open stream.

    `loop` is explicit so the bus can be exercised from a test that has no
    running loop of its own; in production the caller is the request handler
    and the running loop is the right one.
    """
    sub = Subscriber(family_id=family_id, loop=loop or asyncio.get_running_loop())
    with _lock:
        _subscribers.add(sub)
    return sub


def unsubscribe(sub: Subscriber) -> None:
    with _lock:
        _subscribers.discard(sub)


def subscriber_count(family_id: str | None = None) -> int:
    with _lock:
        if family_id is None:
            return len(_subscribers)
        return sum(1 for s in _subscribers if s.family_id == family_id)


def _offer(queue: asyncio.Queue, event: dict) -> None:
    """Runs on the subscriber's own loop, so touching the queue is safe."""
    try:
        queue.put_nowait(event)
    except asyncio.QueueFull:
        try:
            queue.get_nowait()  # 丢最旧的
        except asyncio.QueueEmpty:  # pragma: no cover - 竞态下的空队列
            pass
        try:
            queue.put_nowait(event)
        except asyncio.QueueFull:  # pragma: no cover
            pass


def publish(family_id: str, entities: list[str], action: str = "change") -> None:
    """Fan out one hint to every open stream of this family.

    Called from request handlers, which FastAPI runs in a **thread pool** for
    sync endpoints — so it must not touch `asyncio.Queue` directly. Each
    subscriber is handed its event through its own loop.
    """
    if not family_id:
        return
    event = {
        "type": "change",
        "action": action,
        "entities": sorted({e for e in entities if e}),
        "at": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
    }
    with _lock:
        targets = [s for s in _subscribers if s.family_id == family_id]
    for sub in targets:
        try:
            sub.loop.call_soon_threadsafe(_offer, sub.queue, event)
        except RuntimeError:  # pragma: no cover - 事件循环已关闭
            unsubscribe(sub)


# --- 写操作 -> 提交后广播 ----------------------------------------------------
#
# 广播必须发生在 **commit 之后**：在事务里推出去，回滚时那条提示就是假的，
# 客户端会白刷一次，而且下次真的有人改了就没人信了。
#
# 让每个路由自己写 publish() 是不现实的——89 个写路径，漏一个就是一条静默的
# 不一致。所以在这里挂一个 Session 级监听器：`audit.record()`（所有写操作都会
# 调它）先在 session.info 里记一笔，after_commit 时统一发出去。

_PENDING = "hl_pending_events"


def note_change(session, family_id: str, entity: str, action: str) -> None:
    """Called from `audit.record()`. Cheap: appends to a list on the session."""
    try:
        pending = session.info.setdefault(_PENDING, {})
        slot = pending.setdefault((family_id, action), set())
        slot.add(entity)
    except Exception:  # pragma: no cover - session 处于异常状态时不能拖垮写操作
        log.debug("cannot note change for %s", entity, exc_info=True)


def _install_hooks() -> None:
    from sqlalchemy import event as sa_event
    from sqlalchemy.orm import Session

    @sa_event.listens_for(Session, "after_commit")
    def _after_commit(session) -> None:  # pragma: no cover - 由集成测试覆盖
        pending = session.info.pop(_PENDING, None)
        if not pending:
            return
        for (family_id, action), entities in pending.items():
            publish(family_id, list(entities), action)

    @sa_event.listens_for(Session, "after_rollback")
    def _after_rollback(session) -> None:
        session.info.pop(_PENDING, None)


_install_hooks()

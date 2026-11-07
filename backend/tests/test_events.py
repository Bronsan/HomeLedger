"""实时推送。

这个通道最容易出的问题不是"没推"，而是"推了不该推的"和"推了但卡住写路径"。
所以这里的断言集中在四件事上：只在提交之后推、只推给自己家、积压了不阻塞、
以及心跳不会被 gzip 缓冲吃掉。
"""

from __future__ import annotations

import asyncio
import time

import pytest

from app.db import provider
from app.services import events

API = "/api/v1"


def _drain(loop: asyncio.AbstractEventLoop, sub, timeout: float = 1.0):
    """Run the loop until the subscriber's queue has something (or times out)."""
    return loop.run_until_complete(asyncio.wait_for(sub.queue.get(), timeout=timeout))


def _settle(loop: asyncio.AbstractEventLoop) -> None:
    """Let queued `call_soon` callbacks run without blocking on a queue."""
    loop.run_until_complete(asyncio.sleep(0))
    loop.run_until_complete(asyncio.sleep(0))


@pytest.fixture()
def bus_loop():
    loop = asyncio.new_event_loop()
    try:
        yield loop
    finally:
        loop.close()


def test_stream_requires_a_token(client):
    r = client.get(f"{API}/events/stream")
    assert r.status_code == 401


def test_stream_opens_with_a_ready_frame(family, client):
    """The client must be able to tell "connected" from "still connecting"."""
    headers = {"Authorization": f"Bearer {family.token}", "X-Family-Id": family.family_id}
    with client.stream("GET", f"{API}/events/stream", headers=headers) as r:
        assert r.status_code == 200
        assert r.headers["content-type"].startswith("text/event-stream")
        # gzip 会把 12 字节的心跳缓冲到 800 字节才发，这条流必须绕开它
        assert "content-encoding" not in r.headers
        assert r.headers.get("x-accel-buffering") == "no"
        first = next(r.iter_lines())
        assert first == "event: ready"


def test_committed_write_publishes_one_event(family, bus_loop):
    sub = events.subscribe(family.family_id, bus_loop)
    try:
        item = family.create_item(name="实时推送测试")
        event = _drain(bus_loop, sub)
        assert event["type"] == "change"
        assert "item" in event["entities"]
        assert event["action"] == "item.create"
        # 事件里只有"变了什么"，没有行内容——它是提示，不是数据通道
        assert "name" not in event
        assert item["name"] == "实时推送测试"
    finally:
        events.unsubscribe(sub)


def test_rolled_back_transaction_publishes_nothing(family, bus_loop):
    """A hint sent from inside a transaction that rolls back is a lie."""
    from app.audit import record

    sub = events.subscribe(family.family_id, bus_loop)
    try:
        with provider.session() as db:
            record(
                db,
                None,
                "item.create",
                entity_type="item",
                family_id=family.family_id,
                actor_name="test",
            )
            db.rollback()
        _settle(bus_loop)
        assert sub.queue.empty()
    finally:
        events.unsubscribe(sub)


def test_events_do_not_cross_family_boundaries(owner, family, bus_loop):
    other = owner.post("/families", json={"name": "隔壁家"}).json()["family"]["id"]
    stranger = owner.as_family(other)

    sub = events.subscribe(family.family_id, bus_loop)
    try:
        stranger.create_item(name="别人家的东西")
        _settle(bus_loop)
        assert sub.queue.empty(), "隔壁家的写入推到了我家"
    finally:
        events.unsubscribe(sub)


def test_a_slow_consumer_is_dropped_not_awaited(family, bus_loop):
    """A tab that stopped reading must never slow down a database write."""
    sub = events.subscribe(family.family_id, bus_loop)
    try:
        for _ in range(events.QUEUE_SIZE + 5):
            events.publish(family.family_id, ["item"], "item.update")
        _settle(bus_loop)
        # 队列有上限，超出的丢最旧的，而不是无限增长
        assert sub.queue.qsize() == events.QUEUE_SIZE

        started = time.monotonic()
        family.create_item(name="积压之后的写入")
        elapsed = time.monotonic() - started
        assert elapsed < 2.0, f"写入被慢消费者拖住了：{elapsed:.2f}s"
    finally:
        events.unsubscribe(sub)


def test_subscribers_are_released_when_the_stream_closes(family, client):
    """Every closed tab must remove its queue, or publish walks dead queues."""
    headers = {"Authorization": f"Bearer {family.token}", "X-Family-Id": family.family_id}
    before = events.subscriber_count(family.family_id)
    with client.stream("GET", f"{API}/events/stream", headers=headers) as r:
        next(r.iter_lines())
        assert events.subscriber_count(family.family_id) == before + 1
    assert events.subscriber_count(family.family_id) == before

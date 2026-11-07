"""Bootstrap data.

A brand new household should not face an empty taxonomy. We seed a sensible
Chinese家庭 taxonomy on family creation, and offer a richer sample dataset for
explicit development/demo use (`python -m app.seed --demo --email ...`).
No demo account or sample row is created by a normal install.
"""

from __future__ import annotations

import random
from datetime import date, datetime, timedelta

from sqlalchemy.orm import Session

from .models import (
    AuditLog,
    Category,
    Family,
    Item,
    ItemBatch,
    ItemComponent,
    ItemEvent,
    Location,
    MaintenanceTask,
    Membership,
    User,
)
from .security import make_asset_code

DEFAULT_CATEGORIES = [
    ("家电", "tv", "#f97316"),
    ("数码", "laptop", "#6366f1"),
    ("家具", "sofa", "#a855f7"),
    ("厨房", "chef-hat", "#ef4444"),
    ("工具", "wrench", "#f59e0b"),
    ("衣物", "shirt", "#ec4899"),
    ("运动户外", "bike", "#10b981"),
    ("药品健康", "heart-pulse", "#14b8a6"),
    ("文件证件", "file-text", "#3b82f6"),
    ("儿童用品", "baby", "#8b5cf6"),
    ("其他", "box", "#64748b"),
]

DEFAULT_LOCATIONS = [
    ("客厅", "room", "sofa"),
    ("主卧", "room", "bed"),
    ("次卧", "room", "bed"),
    ("厨房", "room", "chef-hat"),
    ("卫生间", "room", "droplets"),
    ("书房", "room", "book"),
    ("储物间", "room", "archive"),
    ("阳台", "room", "sun"),
]


def seed_taxonomy(db: Session, family_id: str, created_by: str) -> dict:
    cats: dict[str, Category] = {}
    for i, (name, icon, color) in enumerate(DEFAULT_CATEGORIES):
        c = Category(
            family_id=family_id, name=name, icon=icon, color=color, sort_order=i * 10
        )
        db.add(c)
        cats[name] = c
    locs: dict[str, Location] = {}
    for i, (name, kind, icon) in enumerate(DEFAULT_LOCATIONS):
        loc = Location(
            family_id=family_id, name=name, kind=kind, icon=icon, sort_order=i * 10
        )
        db.add(loc)
        locs[name] = loc
    db.flush()
    return {"categories": cats, "locations": locs}


# name, category, location, brand, model, price, months_ago, warranty_months, status
DEMO_ITEMS = [
    ("戴森 V12 无线吸尘器", "家电", "储物间", "Dyson", "V12 Detect Slim", 3699, 2, 24, "in_use"),
    ("小米空气净化器 4 Pro", "家电", "客厅", "Xiaomi", "AC-M15-SC", 1299, 1, 12, "in_use"),
    ("松下 IH 电饭煲", "厨房", "厨房", "Panasonic", "SR-HBC104", 1099, 4, 12, "in_use"),
    ("德龙全自动咖啡机", "厨房", "厨房", "De'Longhi", "ECAM 22.110", 3299, 14, 24, "in_use"),
    ("双立人 30cm 炒锅", "厨房", "厨房", "Zwilling", "Pro 30", 899, 26, 0, "in_use"),
    ("MacBook Pro 14 M3", "数码", "书房", "Apple", "A2918", 15999, 3, 12, "in_use"),
    ("索尼 A7M4 微单", "数码", "书房", "Sony", "ILCE-7M4", 16999, 9, 12, "in_use"),
    ("索尼 FE 24-70mm F2.8 GM II", "数码", "书房", "Sony", "SEL2470GM2", 15999, 9, 12, "in_use"),
    ("群晖 DS923+ NAS", "数码", "书房", "Synology", "DS923+", 4599, 12, 24, "in_use"),
    ("华硕 AX86U 路由器", "数码", "客厅", "ASUS", "RT-AX86U", 1499, 18, 36, "in_use"),
    ("爱普生墨仓式打印机", "数码", "书房", "Epson", "L3253", 899, 5, 12, "repair"),
    ("小米净水器 H800", "家电", "厨房", "Xiaomi", "H800", 1499, 6, 12, "in_use"),
    ("格力 1.5 匹壁挂空调", "家电", "主卧", "GREE", "KFR-35GW", 3299, 20, 72, "in_use"),
    ("宜家 MALM 双人床", "家具", "主卧", "IKEA", "MALM 160x200", 2499, 48, 0, "in_use"),
    ("宜家 POÄNG 扶手椅", "家具", "客厅", "IKEA", "POÄNG", 799, 36, 0, "in_use"),
    ("博世充电冲击钻", "工具", "储物间", "Bosch", "GSB 18V-50", 1299, 16, 24, "in_use"),
    ("小米米家工具箱 60 件套", "工具", "储物间", "Xiaomi", "MJTGJ-60", 199, 2, 0, "stored"),
    ("牧高笛露营帐篷 3-4 人", "运动户外", "储物间", "Mobi Garden", "冷山 3", 899, 8, 0, "stored"),
    ("捷安特 ATX 山地车", "运动户外", "阳台", "Giant", "ATX 830", 3299, 34, 24, "lent"),
    ("始祖鸟 Beta LT 冲锋衣", "衣物", "主卧", "Arc'teryx", "Beta LT", 4800, 15, 0, "in_use"),
    ("飞利浦声波电动牙刷", "家电", "卫生间", "Philips", "HX6730", 399, 3, 24, "in_use"),
    ("戴森吹风机 HD15", "家电", "卫生间", "Dyson", "HD15", 2999, 1, 24, "in_use"),
    ("家庭急救药箱", "药品健康", "卫生间", "海氏海诺", "标准版", 168, 2, 0, "in_use"),
    ("欧姆龙电子血压计", "药品健康", "主卧", "Omron", "U30", 349, 22, 24, "in_use"),
    ("Britax 儿童安全座椅", "儿童用品", "阳台", "Britax", "双面骑士 i-Size", 3680, 26, 36, "stored"),
    ("房屋产权证与购房合同", "文件证件", "书房", "—", "—", None, 60, 0, "in_use"),
    ("米家扫地机器人 2 Pro", "家电", "客厅", "Xiaomi", "STYTJ02YM", 1899, 24, 12, "repair"),
    ("家用灭火器 3kg", "其他", "厨房", "江荆", "MFZ/ABC3", 129, 5, 0, "in_use"),
]

# title, item name, type, interval_days, due_days_from_now, priority
DEMO_TASKS = [
    ("更换净水器滤芯", "小米净水器 H800", "replacement", 90, -3, "high"),
    ("吸尘器滤网清洗", "戴森 V12 无线吸尘器", "routine", 30, 2, "normal"),
    ("空调滤网清洗", "格力 1.5 匹壁挂空调", "routine", 60, 6, "normal"),
    ("灭火器压力检查", "家用灭火器 3kg", "inspection", 180, 20, "high"),
    ("相机传感器清洁", "索尼 A7M4 微单", "routine", 180, 45, "low"),
    ("打印机墨盒更换", "爱普生墨仓式打印机", "repair", None, 1, "urgent"),
]

DEMO_FILES = [
    ("发票-戴森V12.pdf", "invoice"),
    ("保修卡-索尼A7M4.jpg", "warranty"),
    ("说明书-松下电饭煲.pdf", "manual"),
]


def seed_demo(db: Session, family: Family, owner: User) -> dict:
    """A realistic dataset so the UI can be evaluated immediately."""
    rng = random.Random(42)
    tax = seed_taxonomy(db, family.id, owner.id)
    cats, locs = tax["categories"], tax["locations"]
    today = date.today()
    created: dict[str, Item] = {}

    for idx, (name, cat, loc, brand, model, price, months_ago, warranty, status) in enumerate(
        DEMO_ITEMS
    ):
        bought = today - timedelta(days=months_ago * 30 + rng.randint(0, 12))
        created_at = datetime.utcnow() - timedelta(days=months_ago * 30 + rng.randint(1, 20))
        it = Item(
            family_id=family.id,
            code=make_asset_code(idx + 1),
            name=name,
            description="",
            category_id=cats[cat].id,
            location_id=locs[loc].id,
            status=status,
            condition="good" if months_ago < 30 else "fair",
            brand=brand,
            model=model,
            purchase_date=bought,
            purchase_price=price,
            currency="CNY",
            warranty_until=bought + timedelta(days=warranty * 30) if warranty else None,
            expected_life_months=rng.choice([36, 60, 96]),
            owner_user_id=owner.id,
            custodian_user_id=owner.id,
            tags=rng.sample(
                ["常用", "贵重", "保修期内", "可外借", "季节性", "耗材"],
                k=rng.choice([0, 1, 1, 2]),
            ),
            created_by=owner.id,
            updated_by=owner.id,
            created_at=created_at,
            updated_at=datetime.utcnow() - timedelta(days=rng.randint(0, 45)),
        )
        db.add(it)
        created[name] = it

    db.flush()

    # --- components on the camera -------------------------------------------
    camera = created.get("索尼 A7M4 微单")
    if camera:
        for cname, ctype, serial in [
            ("FE 24-70mm F2.8 GM II", "lens", "S01-8842137"),
            ("NP-FZ100 电池 ×2", "battery", ""),
            ("128GB CFexpress Type A", "storage", "CFA-99201"),
        ]:
            db.add(
                ItemComponent(
                    family_id=family.id,
                    item_id=camera.id,
                    name=cname,
                    component_type=ctype,
                    serial_number=serial,
                    installed_at=today - timedelta(days=280),
                )
            )

    # --- batches on the medicine box ----------------------------------------
    # 到期状态是这个功能的全部意义，所以演示数据一次给齐三种：一个已经过期、
    # 一个落在 30 天窗口里、一个还很新。全都"正常"的演示数据什么都证明不了。
    kit = created.get("家庭急救药箱")
    if kit:
        for batch_no, qty, produced_days_ago, expires_in_days, note in [
            ("240510", 1, 530, -12, "布洛芬混悬液，已过期"),
            ("251021", 2, 370, 18, "创可贴与碘伏棉棒"),
            ("260915", 1, 45, 240, "退热贴，未开封"),
        ]:
            db.add(
                ItemBatch(
                    family_id=family.id,
                    item_id=kit.id,
                    batch_no=batch_no,
                    quantity=qty,
                    produced_on=today - timedelta(days=produced_days_ago),
                    expires_on=today + timedelta(days=expires_in_days),
                    location_id=kit.location_id,
                    supplier="社区药房",
                    note=note,
                    created_by=owner.id,
                    updated_by=owner.id,
                )
            )

    # --- maintenance --------------------------------------------------------
    for title, item_name, ttype, interval, due_days, priority in DEMO_TASKS:
        target = created.get(item_name)
        if not target:
            continue
        db.add(
            MaintenanceTask(
                family_id=family.id,
                item_id=target.id,
                title=title,
                task_type=ttype,
                interval_days=interval,
                next_due_at=datetime.utcnow() + timedelta(days=due_days),
                status="pending",
                priority=priority,
                created_by=owner.id,
                notes="",
            )
        )

    # --- lifecycle events ---------------------------------------------------
    for name, item in created.items():
        base = item.created_at
        db.add(
            ItemEvent(
                family_id=family.id,
                item_id=item.id,
                event_type="created",
                summary=f"创建物品「{name}」",
                payload={"code": item.code},
                actor_id=owner.id,
                actor_name=owner.display_name,
                created_at=base,
            )
        )
        # a couple of plausible follow-ups on a subset
        if rng.random() < 0.55:
            moved_at = base + timedelta(days=rng.randint(3, 30))
            db.add(
                ItemEvent(
                    family_id=family.id,
                    item_id=item.id,
                    event_type="moved",
                    summary="位置从「未分配」移至「"
                    + (db.get(Location, item.location_id).name if item.location_id else "储物间")
                    + "」",
                    payload={},
                    actor_id=owner.id,
                    actor_name=owner.display_name,
                    created_at=moved_at,
                )
            )
        if rng.random() < 0.4:
            db.add(
                ItemEvent(
                    family_id=family.id,
                    item_id=item.id,
                    event_type="updated",
                    summary=f"更新了 {rng.randint(1, 3)} 个字段",
                    payload={"fields": ["purchase_price", "tags"]},
                    actor_id=owner.id,
                    actor_name=owner.display_name,
                    created_at=base + timedelta(days=rng.randint(1, 40)),
                )
            )

    # a completed maintenance on the vacuum for the timeline
    vacuum = created.get("戴森 V12 无线吸尘器")
    if vacuum:
        db.add(
            ItemEvent(
                family_id=family.id,
                item_id=vacuum.id,
                event_type="maintenance_done",
                summary="完成维护：吸尘器滤网清洗",
                payload={"cost": 0},
                actor_id=owner.id,
                actor_name=owner.display_name,
                created_at=datetime.utcnow() - timedelta(days=28),
            )
        )
        db.add(
            ItemEvent(
                family_id=family.id,
                item_id=vacuum.id,
                event_type="attachment",
                summary="上传附件：发票-戴森V12.pdf",
                payload={"kind": "invoice"},
                actor_id=owner.id,
                actor_name=owner.display_name,
                created_at=datetime.utcnow() - timedelta(days=20),
            )
        )

    # --- audit trail --------------------------------------------------------
    audit_plan = [
        ("family.create", "family", f"创建家庭：{family.name}", 62),
        ("item.create", "item", "新增物品：戴森 V12 无线吸尘器", 61),
        ("item.create", "item", "新增物品：MacBook Pro 14 M3", 55),
        ("maintenance.create", "maintenance", "创建维护任务：吸尘器滤网清洗", 54),
        ("attachment.upload", "attachment", "上传 invoice：发票-戴森V12.pdf", 20),
        ("maintenance.complete", "maintenance", "完成维护任务：吸尘器滤网清洗", 28),
        ("item.update", "item", "修改物品：小米空气净化器 4 Pro", 9),
        ("loan.create", "loan", "借出：捷安特 ATX 山地车 → 邻居老周", 6),
        ("item.update", "item", "修改物品：爱普生墨仓式打印机", 4),
        ("system.backup", "backup", "创建备份：homeledger-demo.zip", 2),
    ]
    for action, etype, summary, days_ago in audit_plan:
        db.add(
            AuditLog(
                family_id=family.id,
                actor_id=owner.id,
                actor_name=owner.display_name,
                action=action,
                entity_type=etype,
                entity_id="",
                summary=summary,
                ip="",
                user_agent="",
                created_at=datetime.utcnow() - timedelta(days=days_ago),
            )
        )

    db.flush()
    return {"items": len(created), "tasks": len(DEMO_TASKS)}


if __name__ == "__main__":
    import argparse
    import os

    from .db import provider
    from .migrate import run_migrations
    from .models import utcnow
    from .security import hash_password, make_invite_code

    parser = argparse.ArgumentParser(
        description="创建一个初始账号。默认不会创建演示账号、示例物品或任何测试用户。"
    )
    parser.add_argument("--email", default=os.getenv("HOMELEDGER_SEED_EMAIL", ""))
    parser.add_argument("--password", default=os.getenv("HOMELEDGER_SEED_PASSWORD", ""))
    parser.add_argument("--display-name", default=os.getenv("HOMELEDGER_SEED_NAME", ""))
    parser.add_argument("--family-name", default=os.getenv("HOMELEDGER_SEED_FAMILY", ""))
    parser.add_argument(
        "--demo",
        action="store_true",
        help="同时写入演示物品和维护计划（仅用于开发/演示环境）",
    )
    args = parser.parse_args()

    email = args.email.strip().lower()
    password = args.password
    if not email or not password:
        parser.error(
            "请用 --email/--password 或 HOMELEDGER_SEED_EMAIL/HOMELEDGER_SEED_PASSWORD "
            "指定要创建的账号"
        )
    if len(password) < 8:
        parser.error("密码至少 8 位")

    run_migrations(verbose=False)
    with provider.transaction() as db:
        user = db.query(User).filter(User.email == email).one_or_none()
        if not user:
            display_name = args.display_name.strip() or email.split("@")[0]
            user = User(
                email=email,
                display_name=display_name,
                password_hash=hash_password(password),
                avatar_color="#0d6b5f",
            )
            db.add(user)
            db.flush()
            print(f"已创建账号：{email}")
            print("该账号是家庭所有者，不是实例管理员；如需整库备份/恢复，请另行执行：")
            print(f"  python -m app.cli admin {email}")
        else:
            print(f"账号已存在，未修改密码：{email}")

        fam = db.query(Family).filter(Family.created_by == user.id).one_or_none()
        if not fam:
            display_name = user.display_name or email.split("@")[0]
            fam = Family(
                name=args.family_name.strip() or f"{display_name}的家",
                invite_code=make_invite_code(),
                invite_expires_at=utcnow() + timedelta(minutes=5),
                created_by=user.id,
                deployment_mode="gateway",
            )
            db.add(fam)
            db.flush()
            db.add(Membership(family_id=fam.id, user_id=user.id, role="owner"))
            print(f"已创建家庭：{fam.name}")
            print(f"邀请码：{fam.invite_code}（5 分钟内有效，可在应用内重新生成）")

        if args.demo:
            if db.query(Item).filter(Item.family_id == fam.id).count() == 0:
                print(seed_demo(db, fam, user))
            else:
                print("家庭里已有物品，跳过演示数据")

# 架构说明

## 1. 设计前提

HomeLedger 的架构由四个现实约束推导而来，而不是由技术偏好决定：

1. **数据是家庭资产，不是平台资产。** 用户必须能在没有网络、没有我们服务器的情况下继续使用并导出全部数据。
2. **多人协作是常态，不是增值功能。** 夫妻、父母、成年子女会同时使用，权限必须从第一天就存在——事后补租户字段的代价极高。
3. **运行环境差异巨大。** 树莓派、群晖 NAS、淘汰的笔记本、云主机都要能跑。
4. **"替换"必须是真替换。** 接口抽象如果只是把 `if` 挪到另一个文件，等于没抽象。

由此得到主线：**统一业务服务层 + 可替换基础设施层**。业务代码只认识接口，不认识 SQLite、S3 或 SMTP。

---

## 2. 分层

```
┌──────────────────────────────────────────────────┐
│ 终端：桌面浏览器 / 手机 PWA / 平板                │
└───────────────────┬──────────────────────────────┘
                    │ HTTPS · REST · JSON
┌───────────────────▼──────────────────────────────┐
│ 路由层 routers/      参数校验、鉴权依赖、序列化    │
├──────────────────────────────────────────────────┤
│ 领域层 services/     二维码、导入器、调度           │
│          permissions/audit  权限判定与审计写入      │
├──────────────────────────────────────────────────┤
│ 数据层 models.py + db.py   ORM 模型与 Provider     │
├──────────────────────────────────────────────────┤
│ 基础设施 providers/   存储 / 通知 / 身份 / AI / 备份│
└──────────────────────────────────────────────────┘
```

依赖方向严格单向：路由 → 领域 → 数据 → 基础设施。反向依赖只出现在 Provider 读取配置时。

**没有任何路由分支在部署模式上。** 三种模式的差异全部收敛到 `providers/deployment.py` 的能力矩阵，由前端读取后决定展示哪些功能、给出哪些警告。这保证了一个模式下的 bug 不会因为另一个模式的分支而隐藏。

---

## 3. 三种标识符，绝不混用

这是家庭物品管理最容易被做错的建模点。系统里同时存在三个概念：

| 概念 | 字段 | 生成方式 | 语义 | 是否唯一 |
| --- | --- | --- | --- | --- |
| **资产编号** | `items.code` | 系统生成 `HL-000123` | 一件**实物**的身份，印在二维码上 | 家庭内唯一，永不复用 |
| **商品条码** | `items.barcode` | 扫码枪 / 手动录入 EAN-13、UPC-A | 一个**型号**的标识，同型号多件共享 | 允许重复 |
| **序列号** | `items.serial_number` | 厂商印刷 | 厂商维度的单件标识，保修凭证 | 通常唯一，但不强制 |

后果直接体现在交互里：

- 扫到 `HL-000123` → 精确定位一件物品，`matched_by = asset_code`。
- 扫到 `6901234567892` → 可能是三台同型号空气净化器，接口返回 `ambiguous: true` 与候选列表，提示"该条码对应商品型号，可能有多件实物"。
- 新增物品时条码重复**只警告不拦截**，因为买第二台同型号设备是完全正常的行为。
- 资产编号重复则**直接 409**，因为贴纸必须指向唯一实物。

删除物品后编号退役，不会被后来者复用——否则贴在柜子上的旧标签会静默指向另一件东西。

---

## 4. 数据模型

23 张表，全部带 `family_id`（除 `users` 与 `schema_migrations`）。

```
users ──┐
        ├── memberships ── families ──┬── locations（自引用树）
        │                             ├── categories（自引用树）
        │                             ├── items ──┬── item_components
        │                             │           ├── attachments
        │                             │           ├── maintenance_tasks
        │                             │           ├── item_events
        │                             │           ├── loans
        │                             │           └── item_acl
        │                             ├── audit_logs
        │                             ├── notifications
        │                             └── backups
```

### 通用字段

所有业务表都有：`id`（uuid4 字符串）、`created_at`、`updated_at`、`created_by`、`updated_by`。

可变实体额外有：
- `deleted_at` —— 软删除。读取路径全部过滤，但审计与关联记录保留。
- `archived_at` —— 归档。物品"退役但仍在册"，扫码会提示已归档而非"找不到"，避免用户重复建件。
- `version` —— 乐观并发版本号，仅 `items` 使用。

### 为什么时间是 naive UTC

`utcnow()` 返回不带时区的 UTC `datetime`。SQLite 不存储时区，带 tzinfo 的对象写进去再读出来会变成 naive，随后 `>` 比较直接抛 `TypeError`。统一用 naive UTC、在序列化时补 `Z`，比在每个查询里防御性处理成本低得多。展示层按家庭时区（默认 `Asia/Shanghai`）转换。

### JSON 列

`items.tags`、`items.custom_fields`、`memberships.permission_overrides`、`audit_logs.before/after` 使用 JSON 列。SQLite 存为 TEXT，PostgreSQL 可用 JSONB。标签筛选走 `LIKE '%"tag"%'`——在家庭规模（数千件）下完全够用，不值得为此引入 FTS 表。

---

## 5. 多租户

`family_id` 是隔离边界，不是"分组标签"。规则：

1. 每个写操作从 `Principal` 取 `family_id`，**从不**从请求体取。
2. 每个读操作在 WHERE 中显式带上 `family_id`，包括按主键查询后的二次校验。
3. 终端通过 `X-Family-Id` 头切换当前家庭；头无效时回退到用户的第一个有效成员关系，**不会**跨家庭泄露数据。

跨租户访问统一返回 **404** 而不是 403——"这个 ID 在别的家庭存在"本身就是信息泄露。

成员被移出家庭后，`membership.status` 置为 `suspended` 或记录被删除，后续请求返回 409「你还没有加入任何家庭」，而不是 500 或空列表。

---

## 6. 权限模型

### 三层判定

```
最终权限 = 角色预设  ←  grant 追加  ←  deny 移除
                        （deny 永远优先）
```

`effective_permissions(role, overrides)` 是唯一入口，前后端共用同一份定义（前端从 `/permission-meta` 拉取）。

### 23 项权限 · 5 个角色

权限按域分组：物品（6）、文档（4）、维护（4）、成员（4）、系统（5）。

| 角色 | 定位 | 典型能力 |
| --- | --- | --- |
| `owner` 家庭所有者 | 最终负责人 | 全部；且**不可被降级或移除**，`system.restore`/`system.deploy` 永不被 deny 剥夺 |
| `admin` 家庭管理员 | 日常管理 | 物品全权、成员邀请与调整、备份与导出；无恢复与部署设置 |
| `member` 普通成员 | 主要使用者 | 查看/新增/修改/借还、上传文档、维护任务；**不能删除物品** |
| `viewer` 只读成员 | 老人、孩子 | 只能看，不能改 |
| `guest` 访客 | 临时共享 | 仅查看物品与文档 |

设计取舍：`member` 默认不给 `item.delete`。删错一件物品的代价远高于多问一次管理员。

### 物品级共享（`item_acl`）

`item_acl` 提供**加性**授权：在角色权限之外，额外允许某个成员查看或编辑**某一件**物品。

- 只能放宽，不能收窄。这与全局 `grant` 语义一致，避免出现"隐藏某件物品导致全家统计口径不一致"。
- 用途：给来访的父母单独共享"药品柜"这一件；让某人临时帮忙编辑某台设备。
- 实现上，`require_view_or_shared` 依赖允许"无 `item.view` 但有共享记录"的成员进入，列表查询再按 `Item.id IN (SELECT item_id FROM item_acl WHERE user_id = ?)` 收窄。

### 错误契约

权限不足返回结构化 403，而非纯文本：

```json
{ "detail": "缺少权限：item.delete", "permission": "item.delete", "code": "permission_denied" }
```

前端据此高亮缺失的具体能力，而不是弹一句无用的"操作失败"。

---

## 7. 并发与一致性

### 乐观锁

两个人在两台手机上同时编辑同一件物品是真实场景。`PATCH /items/{id}` 接受可选的 `version`：

- 版本匹配 → 更新，`version += 1`。
- 版本落后 → **409**，响应体附带 `current_version` 与 `current` 完整记录，前端可展示"对方改了什么"。

`version` 是可选的：批量脚本、导入等场景可以不传，退化为 last-write-wins。选择权交给调用方，而不是替所有人做决定。

### 软删除 + 归档 + 审计

三种"让东西消失"的方式，语义不同：

| 操作 | 效果 | 可恢复 | 出现在列表 |
| --- | --- | --- | --- |
| 归档 | 标记退役 | ✓ 一键恢复 | 仅在「含归档」筛选下 |
| 删除 | `deleted_at` 置位 | ✓ 数据库层面 | 否 |
| 硬删除 | 物理删除 | ✗ | 否 |

每一次写操作产生两条独立记录：

- `item_events` —— 面向人阅读的时间线（"完成维护：更换滤芯（费用 ¥89）"）。
- `audit_logs` —— 面向追责的操作记录（操作者、IP、UA、before/after JSON）。

两者都不允许更新，只追加。

### 事务边界

一个请求一个事务，`db.commit()` 在路由末尾。跨实体的连锁操作（如完成任务 → 顺延日期 → 写事件 → 写审计）在同一事务内完成，要么全成要么全不成。

---

## 8. 七个 Provider

| 接口 | 实现 | 替换方式 |
| --- | --- | --- |
| `DatabaseProvider` | SQLite / PostgreSQL | `HOMELEDGER_DATABASE_URL` |
| `FileStorageProvider` | 本地磁盘 / S3 兼容 | `HOMELEDGER_STORAGE_BACKEND=s3` |
| `NotificationProvider` | 站内 / SMTP / Webhook | `HOMELEDGER_NOTIFICATION_CHANNELS=inapp,email` |
| `IdentityProvider` | 本地 scrypt / OIDC 占位 | `IDENTITY_BACKEND` |
| `AIProvider` | 本地启发式 / 云端 Vision / 关闭 | `HOMELEDGER_AI_PROVIDER` |
| `BackupProvider` | 本地 zip | 可扩展为异地对象存储 |
| `DeploymentConfig` | local / gateway / cloud | `HOMELEDGER_DEPLOYMENT_MODE` |

### 抽象必须诚实

`DatabaseProvider.capabilities()` 不是装饰性的元数据，而是**事实陈述**：

```python
{
  "dialect": "sqlite",
  "concurrent_writers": False,
  "json_query": True,
  "full_text_search": True,
  "recommended_mode": "local/gateway",
  "note": "Write concurrency is serialised; always put the API in front."
}
```

UI 读取它来降级功能、显示警告。若把 SQLite 和 PostgreSQL 描述成"只差一个连接串"，第一个踩坑的会是用户。

同理，`AIProvider.describe()` 必须返回 `leaves_device` 与 `privacy_notice`。云端识别时前端显示"图片将上传到配置的云端 AI 服务"，本地模式显示"识别在本地完成，图片不会离开设备"。本地模式**不会**伪造识别结果——它明确返回 `needs_review: true` 与"未安装 OCR 引擎，请手动补全"。

---

## 9. 备份与恢复

### 备份

不直接复制 `.db` 文件。原因：WAL 模式下最新提交可能还在 `-wal` 里，复制主文件会丢数据。

正确做法是 SQLite 在线备份 API：

```python
src = sqlite3.connect(db_path)
dst = sqlite3.connect(snapshot_path)
src.backup(dst)   # 一致性快照，无需停机
```

备份包结构：

```
homeledger-20261028-161448.zip
├── manifest.json   # 应用版本、schema_version、install_id、行数、创建时间
├── database.db     # 一致性快照
└── uploads/...     # 附件（可选）
```

### 恢复

破坏性操作，三重保险：

1. 必须输入确认词 `RESTORE`，否则 400。
2. 自动先做一次完整备份，返回 `pre_restore_backup` 文件名。
3. 覆盖前保留 `.db.pre-restore` 副本（先 `wal_checkpoint(TRUNCATE)`，否则副本同样缺 WAL 数据）。

顺序至关重要，写错会静默损坏数据：

```
1. engine.dispose()            # 释放池中连接，否则旧句柄继续写旧 inode
2. wal_checkpoint(TRUNCATE)    # 把 WAL 内容并入主文件
3. 复制 .db.pre-restore
4. 覆盖 database.db
5. 删除 -wal / -shm            # 否则 SQLite 会把旧 WAL 重放到新库上
```

第 5 步是最容易漏的：残留的 WAL 会在下次打开时被回放到刚恢复的快照之上，产生"恢复了但数据是错的"这种最难排查的故障。

### 文件名唯一性

备份文件名基于秒级时间戳，因此同一秒内的两次备份会撞名——而"先做安全备份再恢复"恰好就是同一秒内两次备份。命名通过 `O_CREAT | O_EXCL` 原子占位，冲突时追加 `-2`、`-3`。

没有这一层，恢复操作会用当前状态覆盖掉用户想恢复的那个归档，然后"成功"恢复出一份没有变化的数据。

---

## 10. 调度器

`asyncio` 后台任务，在 API 进程内运行（`HOMELEDGER_ENABLE_SCHEDULER=false` 可关闭，云上多副本场景应改为独立单例 worker）。

每轮扫描三件事：

| 类型 | 触发条件 | 去重键 |
| --- | --- | --- |
| 维护到期 | `next_due_at <= now` 且 `status = pending` | `maint:{task_id}:{日期}` |
| 保修提醒 | 30 天内到期或已过保 | `warranty:{item_id}:{到期日}` |
| 借出逾期 | `due_at < now` 且未归还 | `loan:{loan_id}:{日期}` |

去重键写入 `notifications.dedupe_key` 并建唯一索引。效果：进程重启、手动重跑、双实例竞争都不会重复通知；而任务顺延到下一周期后日期变化，会正常发出新提醒。

---

## 11. 前端

- **无 UI 框架**。手写 CSS 设计系统（约 900 行变量与组件样式），暗色主题通过 `prefers-color-scheme` 与手动切换双通道。
- **手写 SVG 图标**（约 90 个），单文件，按需 `<Icon name="..." />`，避免 300KB 的图标库。
- **PWA**：manifest + service worker。静态资源 cache-first，页面导航 network-first，**API 永不缓存**——缓存业务数据会让用户看到过期的库存状态，比不缓存更糟。
- **响应式三形态**：≥1024px 侧边栏 + 主区；860–1024px 折叠侧边栏；<860px 底部导航 + 悬浮扫码按钮。
- **⌘K 命令面板**：防抖调用 `/items?q=`，与静态导航、操作混合排序。
- **错误可读**：`ApiError` 保留状态码与结构化 body，表单就地提示，权限不足时说明缺哪个权限。

---

## 12. 已知边界

| 限制 | 原因 | 影响 |
| --- | --- | --- |
| 离线不可用 | 无本地缓存层与冲突解决 | 断网时无法查看物品；PWA 仅缓存静态资源 |
| SQLite 单写 | 引擎级限制 | 多人高频写入需网关 + 单进程 |
| 自动恢复仅 SQLite | PG 需 `pg_restore` | 云端恢复走运维流程，接口明确报错 |
| 标签用 `LIKE` 匹配 | 家庭规模下够用 | 万级以上物品需引入 FTS |
| 无实时推送 | 无 WebSocket | 他人修改需刷新页面才能看到（409 冲突会提示） |
| OIDC 为占位实现 | 家庭场景本地账号足够 | 企业级 SSO 需补 `OIDCIdentityProvider` |

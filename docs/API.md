# API 参考

- **基础路径**：`/api/v1`
- **交互式文档**：`/api/docs`（Swagger UI）、`/api/redoc`、`/api/openapi.json`
- **共 101 个端点**，按模块分为：物品与借还（26，含借还 3）、认证与家庭成员（17）、系统（15，含通知、审计与注册人数）、同步（11）、分类与位置（8）、维护（7）、附件（4）、批次（4）、扫码（3）、公开二维码（3）、标签（2）、实时事件（1）

其中 98 个出现在 `/api/openapi.json`；`/public/*` 三个端点用 `include_in_schema=False` 隐藏，它们服务于手机相机而不是 API 客户端，见[公开扫码页](#公开扫码页public)。另有 1 个桌面外壳专用的托盘桥接端点，只在安装版内注册，不计入上面的服务器端点数。

---

## 鉴权

登录后拿到 JWT，放进 `Authorization: Bearer <token>`。

```bash
TOKEN=$(curl -s -X POST http://localhost:8000/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","password":"your-password"}' | jq -r .token)
```

三种传参方式，优先级从高到低：

1. `Authorization: Bearer <token>`（推荐）
2. `?token=<token>`（仅用于 `<img>`、`<a download>` 等无法设置请求头的场景，如二维码、附件原图）
3. 无 —— 返回 401

### 多家庭切换

一个账号可属于多个家庭。请求头 `X-Family-Id` 指定当前家庭：

```bash
curl -H "Authorization: Bearer $TOKEN" -H "X-Family-Id: $FID" \
  http://localhost:8000/api/v1/items
```

- 省略该头 → 使用用户的第一个有效成员关系
- 头中的家庭无效 → **回退**到第一个成员关系（不报错，避免离开家庭后前端卡死）

### Token 失效

修改密码会把 `token_version + 1`，**所有旧 token 立即失效**（返回 401）。这是"我在别人手机上登录过"的唯一补救手段。

---

## 错误约定

| 状态码 | 含义 | 典型场景 |
| --- | --- | --- |
| 400 | 请求可解析但业务上不允许 | 恢复时确认词不是 `RESTORE`、位置形成环 |
| 401 | 未登录 / token 失效 | 缺少 token、密码已改 |
| 403 | 已登录但缺权限 | 只读成员尝试新增物品 |
| 404 | 不存在**或不属于当前家庭** | 跨租户访问统一 404，不泄露存在性 |
| 409 | 冲突 | 邮箱已注册、物品编号重复、乐观锁版本落后、无家庭成员关系 |
| 413 | 载荷过大 | 附件超过 `HOMELEDGER_MAX_UPLOAD_MB` |
| 422 | 参数校验失败 | 缺少必填字段、数量为负 |

权限错误的响应体是结构化的：

```json
{
  "detail": "缺少权限：item.delete",
  "permission": "item.delete",
  "code": "permission_denied"
}
```

其余错误的 `detail` 可能是字符串，也可能是对象（乐观锁冲突时携带完整现场）。

---

## 认证与家庭

### `POST /auth/register`

注册的账号会成为**自己家庭的所有者**，但**不会**成为实例管理员。带 `invite_code` 则加入已有家庭。实例管理员只能在服务器终端用 `python -m app.cli admin <邮箱>` 设置。

```json
{
  "email": "you@example.com",
  "password": "至少 8 位",
  "display_name": "老爸",
  "family_name": "梧桐里 3 号",
  "invite_code": "可选"
}
```

```json
201
{
  "token": "eyJ...",
  "expires_in": 1209600,
  "user": { "id": "...", "email": "...", "display_name": "...", "is_instance_admin": true },
  "current_family_id": "..."
}
```

> 邮箱校验只检查形状（`x@y.z`），不查 DNS/MX。自托管家庭常用 `you@example.com` 这类地址，用严格校验会把人挡在门外。

### `POST /auth/login` → 同上结构

### `GET /auth/me`

前端启动时调用，一次拿齐上下文：

```json
{
  "user": { "...": "" },
  "families": [{ "id": "...", "name": "我的家", "my_role": "owner", "invite_code": "8位邀请码" }],
  "current_family_id": "...",
  "role": "owner",
  "permissions": ["item.create", "item.delete", "..."],
  "deployment": { "mode": "gateway", "capabilities": { "...": "" }, "warnings": [], "checklist": [] },
  "identity": { "backend": "local" }
}
```

### 其他

| 端点 | 说明 |
| --- | --- |
| `PATCH /auth/me` | 改昵称、头像色 |
| `POST /auth/change-password` | 需当前密码；成功后旧 token 全部失效 |
| `GET /families` | 我加入的所有家庭 |
| `POST /families` | 新建家庭（创建者成为所有者） |
| `POST /families/join` | 用邀请码加入 |
| `GET /families/current` | 当前家庭详情 + 我的权限 + 成员数 |
| `PATCH /families/current` | 改家庭名与设置（需 `system.deploy`） |
| `POST /families/current/rotate-invite` | 重置邀请码（需 `member.invite`） |
| `GET /families/current/permission-meta` | 权限目录：分组、中文标签、角色预设——前端渲染权限表用 |
| `GET/POST /families/current/members` | 成员列表 / 邀请 |
| `PATCH/DELETE /families/current/members/{id}` | 调整角色与覆盖权限 / 移除 |

邀请成员时若邮箱未注册，会创建一个**占位账号**（`password_hash = "!"`，无法登录），等对方接受邀请后自行设置密码。

---

## 物品

### `GET /items`

| 参数 | 说明 |
| --- | --- |
| `q` | 模糊搜索：名称、品牌、型号、序列号、条码、编号、描述 |
| `category_id` | 分类筛选，**包含所有子分类** |
| `location_id` | 位置筛选，**包含所有子位置** |
| `status` | `in_use` / `stored` / `lent` / `repair` / `lost` / `disposed` / `archived` |
| `condition` | `new` / `good` / `fair` / `poor` |
| `tag` | 单个标签精确匹配 |
| `warranty` | `active` / `expiring`（30 天内）/ `expired` |
| `owner_id` | 按所有人筛选 |
| `include_archived` | 是否包含已归档，默认 `false` |
| `sort` | `updated`（默认）/ `created` / `name` / `price` / `warranty` / `code` |
| `order` | `desc`（默认）/ `asc` |
| `page` / `page_size` | 默认 1 / 24，上限 200 |

```json
{
  "items": [
    {
      "id": "9f2a...",
      "code": "HL-000007",
      "name": "戴森 V12 无线吸尘器",
      "category": { "id": "...", "name": "家电", "icon": "plug", "color": "#..." },
      "location": { "id": "...", "name": "储物间", "kind": "room" },
      "location_path": "储物间 / 清洁工具柜",
      "quantity": 1, "unit": "件",
      "status": "in_use", "condition": "good",
      "brand": "Dyson", "model": "V12 Detect Slim",
      "serial_number": "SN-9F2A-1188", "barcode": "5025155056530", "barcode_type": "ean13",
      "purchase_date": "2025-08-19", "purchase_price": 3699.0, "currency": "CNY",
      "warranty_until": "2027-08-08",
      "warranty_state": "active",
      "tags": ["贵重"], "custom_fields": {},
      "cover_url": "/api/v1/attachments/xxx/raw?variant=thumb",
      "open_tasks": 1, "next_due_at": "2026-11-02T00:00:00Z",
      "version": 3,
      "created_at": "2025-08-19T10:12:00Z", "updated_at": "2026-10-01T09:00:00Z",
      "archived_at": null
    }
  ],
  "total": 28, "page": 1, "page_size": 24, "pages": 2
}
```

`warranty_state` 与 `open_tasks` 是**计算字段**，不由客户端推算——否则每端都要复制一份"30 天算即将过保"的规则，早晚不一致。

### `POST /items`

必填只有 `name`。`code` 留空则自动分配 `HL-000001` 递增编号。

```json
201 { "item": { "...": "" }, "duplicate_warning": { "item_id": "...", "name": "...", "message": "同条码物品已存在：..." } }
```

- `code` 重复 → `409`
- `barcode` 重复 → **201 + `duplicate_warning`**（同型号多件是正常需求，不拦）
- `quantity` 为负 → `422`

### `GET /items/{id}`

返回 `{ "item": { ...含 components / attachments / maintenance / events / loans / acl } }`。

### `PATCH /items/{id}`

支持部分更新。传 `version` 启用乐观锁：

```json
// 请求
{ "name": "改个名", "version": 3 }

// 200 → { "item": { "version": 4, ... } }
// 409
{
  "detail": {
    "message": "该物品已被其他人修改，请刷新后重试",
    "current_version": 4,
    "current": { "...完整当前记录..." }
  }
}
```

不传 `version` 则退化为 last-write-wins，供脚本与批量场景使用。

### 生命周期

| 端点 | 效果 |
| --- | --- |
| `POST /items/{id}/archive` | 归档：移出默认列表，扫码时提示"已归档"，可恢复 |
| `POST /items/{id}/restore` | 从归档恢复 |
| `DELETE /items/{id}` | 软删除：所有读取路径消失，审计记录保留 |

### 组件

```
POST   /items/{id}/components        { "name": "24-70mm 镜头", "component_type": "accessory", "serial_number": "", "quantity": 1 }
DELETE /items/{id}/components/{cid}
```

`component_type`：`accessory` / `consumable` / `part` / `extension`。

### 批次与保质期

```
GET    /items/{id}/batches            → { "items": [...] }   // 到期早的在前，无到期日的沉底
POST   /items/{id}/batches            { "batch_no": "20261030-A", "quantity": 2, "unit": "", "produced_on": "2026-10-01", "expires_on": "2026-11-10", "location_id": null, "supplier": "楼下超市", "note": "" }
PATCH  /batches/{bid}                 同上，字段全部可选；传 null 表示清空该字段
DELETE /batches/{bid}                 软删除（写墓碑，同步给其他设备）
```

返回体里 `expiry_state`（`none` / `fresh` / `expiring` / `expired`）与 `days_left`
是**按当天日期算出来的**，不是数据库列：存下来的状态过了午夜就是错的。
`expiring` 的窗口是 30 天，与保修提醒同一个口径。

`unit` 为空表示沿用物品单位；`location_id` 是批次自己的存放位置（同一物品可以
分开存）。权限复用 `item.view` / `item.update`，没有独立的 `batch.*` 权限。

批次数量**不会**回写 `items.quantity`。两者不一致时由界面提示差额，由人决定改哪边。

### 批量与克隆（1.0.9）

```
POST /items/{id}/clone        201 → { "item": {...} }   // 复制「描述」：字段照搬，编号重排、条码/序列号/附件不跟，名字加「（副本）」
POST /items/batch-update      { "ids": [...], "fields": { "location_id": "...", "quantity": 2 } } → { "ok": true, "updated": 2 }
POST /items/purge-deleted     → { "purged": 2, "blocked": [{ "id": "...", "name": "..." }] }
```

- `batch-update` 的 `fields` 白名单刻意排除 `name`/`code`/`barcode`——批量写同值等于销毁数据；任一 id 越权或不存在则整批 403。
- `purge-deleted` 清空回收站的「已删除」视图：有未归还借出的**跳过不拒**，放进 `blocked`。
- 权限：克隆 `item.create`、批量修改 `item.update`、清空回收站 `item.delete`。

### 物品级共享

```
POST   /items/{id}/acl   { "user_id": "...", "permission": "view" }   // view | edit
DELETE /items/{id}/acl/{user_id}
```

**加性授权**：只能放宽，不能收窄。用户可以没有 `item.view` 却因为某条 `view` 共享记录看到这一件物品（列表也只返回共享给他的）。`edit` 同理可越过 `item.update`。

### 借还

```
GET  /loans?status=open|returned
POST /loans              { "item_id": "...", "borrower_name": "邻居老王", "borrower_contact": "", "due_at": "2026-11-01T00:00:00Z", "note": "" }
POST /loans/{id}/return  { "note": "完好" }
```

返回体中的 `is_open` 与 `overdue` 为计算字段。

### 导入导出

| 端点 | 说明 |
| --- | --- |
| `GET /items/export.csv` | 全量导出，带 UTF-8 BOM（Excel 直接打开不乱码） |
| `POST /items/import` | 批量导入，支持预检 |
| `POST /items/bulk` | 批量新增（JSON 数组） |
| `GET /items/facets` | 状态计数、总价值、标签 Top20 |

导入支持中英文表头自动映射（`名称/name`、`条码/barcode`、`价格/purchase_price`…），日期接受 `2024-03-05`、`2024/03/05`、`20240305`，金额可带 `¥` 与千分位。

```json
POST /items/import
{ "rows": [{ "名称": "电饭煲", "分类": "厨房", "价格": "¥1,299" }], "dry_run": true, "create_missing_taxonomy": true }

200
{
  "dry_run": true, "created": 1, "skipped": 0,
  "errors": [{ "row": 3, "message": "分类「不存在的分类」不存在（未开启自动创建）" }],
  "preview": [{ "row": 2, "code": "HL-000029", "name": "电饭煲" }],
  "new_categories": ["厨房"], "new_locations": []
}
```

`create_missing_taxonomy=false` 时，遇到未知分类或位置会**报错并跳过该行**，而不是静默丢失分类——静默丢失会让人以为导入成功。

### 二维码与标签

| 端点 | 返回 |
| --- | --- |
| `GET /items/{id}/qr.png` | 单件二维码 PNG，内容为 `<base>/public/q/{token}` |
| `GET /items/{id}/label.png` | 420×168 贴纸，含名称、编号、位置、二维码 |
| `GET /items/{id}/qr-link` | 该物品当前的扫码链接（token、宿主地址、是否可达、累计查看） |
| `DELETE /items/{id}/qr-link` | 作废当前链接，下次取图会签发新的 |
| `GET /labels/sheet?item_ids=a,b&limit=60` | A4 三列打印页（HTML，二维码内联为 data URL） |
| `GET /labels/batch.zip` | 批量贴纸 PNG 打包 |

图片类端点支持 `?token=`，因为 `<img>` 无法携带请求头。

二维码里**不写物品编号**，写的是一个随机 token，指向服务器的公开查看页（见下节）。这样贴纸贴上去之后换服务器、换端口、换部署方式都不必重印；链接泄露了也能单件作废。

`GET /items/{id}/qr-link` 的返回：

```json
{
  "token": "hK3vQ8sT2mR9xLpA1cN7",
  "url": "http://192.168.1.10:8000/api/v1/public/q/hK3vQ8sT2mR9xLpA1cN7",
  "base": "http://192.168.1.10:8000",
  "lan_only": true,
  "reachable": true,
  "hits": 7,
  "last_used_at": "2026-10-30T09:12:44Z"
}
```

`reachable` 是服务器对自己地址的判断：如果它算出来的宿主地址只有回环，或者监听在 `127.0.0.1`，这里为 `false`，前端会提示用户去打开「允许家庭内设备连接」。链接本身照常签发——用户可能之后才开。

链接按 `item_id + base_url` 复用：同一物品、同一个访问地址永远拿到同一个 token，反复打印不会让旧贴纸失效。换了访问地址（比如从 IP 改成主机名）会签新的，旧的那张仍然有效，只是指向旧地址。

---

## 实时事件（`/events`）

```
GET /events/stream        → text/event-stream
```

一条 SSE 长连接，把「这个家里有人改了东西」推给正在看页面的设备。

```
event: ready
data: {"family_id":"..."}

event: change
data: {"type":"change","action":"item.update","entities":["item"],"at":"2026-10-30T15:02:11Z"}

: ping
```

- **只有提示，没有内容**。`entities` 是实体名（`item` / `batch` / `maintenance` / `loan` /
  `attachment` / `notification` / `all`），客户端收到后自己重新请求当前视图。
  这样丢一条消息最多是晚一点看到，不会让两边的数据不一致。
- **只在提交之后发**。实现挂在 SQLAlchemy 的 `after_commit` 上：事务回滚了就不会有提示。
- **按家庭隔离**。连接以 JWT 里的身份解析家庭，`publish` 只投给同家庭的连接。
- **心跳 25 秒**（`: ping` 注释帧）。反代默认会把响应缓冲到 4KB，所以响应带
  `X-Accel-Buffering: no`，同时这条路径绕开 gzip——gzip 会等 800 字节才 flush，
  心跳只有 12 字节，会被它按死。
- **鉴权用 `Authorization: Bearer`**，不接受 `?token=`：`EventSource` 不能设请求头，
  所以客户端用 `fetch` + `ReadableStream` 读流（见 `frontend/src/lib/live.ts`）。
- **进程内广播**。多 worker 部署时每个 worker 只认识自己的订阅，需要换成 Redis pub/sub；
  网关模式默认单进程，够用。

## 公开扫码页（`/public`）

这组端点给**手机相机**用，不经过 App，也不接受 JWT。它们不出现在 Swagger 里（`include_in_schema=False`），因为它们不是给 API 客户端调的。

| 端点 | 说明 |
| --- | --- |
| `GET /public/q/{token}` | 服务端渲染的物品页（HTML） |
| `POST /public/q/{token}/beat` | 心跳续租，204 |
| `GET /public/q/{token}/photo` | 物品封面图 |

### 访问控制

两道闸门，都在 `GET /public/q/{token}` 上：

1. `HOMELEDGER_QR_ENABLED=false` → 404，整个功能关掉。
2. `HOMELEDGER_QR_LAN_ONLY=true`（默认）时检查 `request.client.host`：只有私网、回环、链路本地地址放行，其余一律 403。

拒绝时返回的页面和「token 不存在」的页面**长得一模一样**，都是「仅限家庭内网访问」。不区分这两种情况，是因为区分了就等于告诉外网扫描者「这个 token 是真的，只是你不在家」——那是一份可被枚举的存在性预言机。

判定走 `ipaddress` 的 `is_private / is_loopback / is_link_local`，不做字符串前缀匹配。`10.0.0.0/8` 和 `192.168.0.0/16` 好判断，但 `172.16.0.0/12` 的边界、`100.64.0.0/10` 的运营商级 NAT、IPv6 的 `fc00::/7`，手写前缀迟早会漏。

### 静默与唤醒

服务平时不占资源：没有查看者时，`QrGateway` 不持有任何页面缓存，只有一条后台线程每 5 秒检查租约是否过期。

```
扫码 → wake(token)  租约 90s，缓存渲染好的 HTML
     → 页面里的脚本每 5s POST .../beat  续租
     → 关掉页面，心跳停 → 90s 后租约过期 → 缓存丢弃 → 线程退出
```

`HOMELEDGER_QR_IDLE_SECONDS` 控制这个 90 秒。缓存上限 64 条（LRU），超过就丢最旧的——一家人同时扫 64 个码的情况不存在，但被脚本刷的时候要有上限。

### 查看页内容

服务端直接渲染 HTML，不加载任何 JS 框架。手机扫完码到看见内容只有一次请求，弱网下也不会白屏半小时。

- 名称、编号、位置路径（房间 / 家具 / 容器）、分类、品牌型号、购买日期、保修到期、序列号
- 价格按 `HOMELEDGER_QR_SHOW_PRICE` 决定是否显示（默认 `true`：扫的人就是这家人，问「这个多少钱买的」是正常的事。有客人用你家 WiFi 时可以关掉——序列号反正都在页面上，这一项管的是体面，不是保密）
- 备注、下次保养、最近一次保养记录
- 封面图（`/photo`，走缩略图，不在首页塞原图）
- 底部「仅家庭内网可访问 · 数据不离开你的服务器」

页面 `noindex`，`viewport-fit=cover`，浅色/深色跟随系统。

---

## 扫码

### `GET /scan/lookup?code=...`

系统按 **资产码 → 商品条码/序列号 → 名称** 的顺序匹配，并告诉你命中的是哪一种。
精确标识符永远优先：名字里恰好含 `HL-000042` 的物品，不会盖过编号就是 `HL-000042`
的那一件。

桌面端没有摄像头，这一页在界面上叫「查询」，只保留输入框，所以名称模糊匹配不是
可选功能——没有它，桌面用户除了背编号什么都查不了。名称命中多条时 `ambiguous`
为 true，`candidates` 里是全部候选（最多 20 条，按更新时间倒序）。

```json
{
  "found": true,
  "matched_by": "barcode",       // asset_code | barcode | serial | name
  "ambiguous": true,
  "archived": false,
  "query": "6901234567892",
  "item": { "id": "...", "name": "小米空气净化器 4 Pro", "code": "HL-000002", "archived": false },
  "candidates": [
    { "id": "...", "name": "小米空气净化器 4 Pro", "code": "HL-000002", "match": "barcode", "status": "in_use", "location_id": "...", "archived": false },
    { "id": "...", "name": "小米空气净化器 4 Pro（次卧）", "code": "HL-000018", "match": "barcode", "status": "stored", "location_id": "...", "archived": false }
  ],
  "hint": "该条码对应商品型号，可能有多件实物"
}
```

优先级：`asset_code` > `barcode` / `serial`。命中资产编号即精确到单件。

未找到：

```json
{ "found": false, "query": "HL-999999", "message": "没有找到对应物品。可能是新物品，可直接创建。", "suggest_create": true }
```

已归档的物品**仍会命中**，但带 `archived: true` 与提示"该物品已归档，如需继续使用请先恢复"。若返回"找不到"，用户会直接再建一件，造成重复。

扫码内容若是整串 URL（`https://home/scan?code=HL-000123`），会自动提取 `code` 参数。

### AI 识别

```
GET  /scan/ai/providers        当前 Provider 与可选项
POST /scan/ocr  { "attachment_id": "...", "hint": "" }
```

返回固定包含 `needs_review` 与 `leaves_device`：

```json
{
  "fields": { "barcode": "6901234567892", "purchase_price": 299.0 },
  "confidence": 0.15,
  "needs_review": true,
  "provider": "local",
  "leaves_device": false,
  "message": "本地模式未安装 OCR 引擎。已保留图片，请手动补全字段，或配置云端识别。"
}
```

本地模式**不会**生成看似可信的假数据；所有结果都要求人工确认后才入库。

---

## 维护

```
GET  /maintenance?status=pending&item_id=&assignee_id=&overdue=true&upcoming_days=7
POST /maintenance
PATCH /maintenance/{id}
POST /maintenance/{id}/complete
POST /maintenance/{id}/skip    // 跳过一次：按原周期顺延到期日，不记完成；一次性任务 409
DELETE /maintenance/{id}
```

创建：

```json
{
  "item_id": "...",
  "title": "更换滤芯",
  "task_type": "routine",        // routine | repair | inspection | warranty | replacement
  "interval_days": 90,           // 不传 = 一次性任务
  "due_at": "2026-11-01T00:00:00Z",
  "priority": "normal",
  "assignee_id": null,
  "estimated_cost": null,
  "notes": ""
}
```

完成：

```json
POST /maintenance/{id}/complete
{ "completed_at": null, "cost": 89.0, "notes": "换了 PP 棉", "create_next": true, "attachment_ids": [] }
```

- 周期任务（有 `interval_days`）→ `next_due_at` 顺延到下一个未来日期，状态保持 `pending`
- 一次性任务 → 状态 `done`，`next_due_at` 置空
- 同时写入物品时间线（`maintenance_done`）

列表返回 `counts` 为按状态计数的字典，前端用于渲染统计卡。

---

## 附件

```
POST   /attachments        multipart/form-data
GET    /attachments?item_id=&kind=
GET    /attachments/{id}/raw?variant=thumb
DELETE /attachments/{id}
```

上传字段：`file`（必填）、`item_id`、`maintenance_id`、`kind`（`photo` / `document` / `receipt` / `manual` / `other`）、`set_cover`。

- 图片自动生成 640px 长边缩略图，`thumbnail_url` 指向 `?variant=thumb`
- 空文件 `400`，超过 `HOMELEDGER_MAX_UPLOAD_MB` `413`
- 下载响应带 `ETag` 与 RFC 5987 的 `filename*=utf-8''`，中文文件名不乱码
- 删除为软删除，物品详情不再列出，但文件保留

---

## 分类与位置

```
GET/POST      /locations          ?flat=true 只返回扁平列表
PATCH/DELETE  /locations/{id}
GET/POST      /categories
PATCH/DELETE  /categories/{id}
```

`GET /locations` 同时返回两种形态：

```json
{
  "tree": [{ "id": "...", "name": "客厅", "children": [ ... ] }],
  "items": [{ "id": "...", "name": "客厅", "item_count": 7, "path": "客厅" }]
}
```

`item_count` 是**子树汇总**：客厅的数字包含电视柜、抽屉里的物品。

把位置设为自己的后代 → `400`（防环）。

---

## 系统

| 端点 | 鉴权 | 说明 |
| --- | --- | --- |
| `GET /system/health` | 公开 | 存活探针，含数据库状态 |
| `GET /system/info` | 公开 | 首次启动引导：是否需要初始化、部署模式、上传上限、注册人数。**不含任何密钥或账号身份** |
| `GET /system/stats` | 公开 | 仅返回 `{ "registered_users": N }`；N 为可登录账号数，邀请占位账号不计入 |
| `GET /system/providers` | 登录 | 七个 Provider 的实现与健康状态 |
| `GET /system/dashboard` | `item.view` | 统计、6 个月购入趋势、分类分布、最近动态 |
| `GET /audit?action=&entity_type=&page=` | `system.audit` | 审计日志，before/after 可展开 |
| `GET /notifications?unread_only=` | 登录 | 站内通知 |
| `POST /notifications/read` | 登录 | `{ "all": true }` 或 `{ "ids": [...] }`；只影响自己的通知 |
| `GET /system/backups` | `system.backup` | 备份列表 |
| `POST /system/backups` | `system.backup` | 立即备份 `{ "note": "" }` |
| `GET /system/backups/{file}/download` | `system.backup` | 下载 zip |
| `POST /system/backups/restore` | `system.restore` | 恢复，需 `{ "filename": "...", "confirm": "RESTORE" }` |
| `DELETE /system/backups/{file}` | `system.backup` | 删除备份文件 |
| `GET /system/export.json` | `system.export` | 全量 JSON 导出 |
| `GET /system/qr` | `item.view` | 二维码查看服务的状态：开/关、访问范围、宿主地址、当前是否唤醒、在线人数、累计查看 |

`GET /system/qr` 的返回（前端「设置 → 同步」每 8 秒轮询一次）：

```json
{
  "enabled": true,
  "lan_only": true,
  "base": "http://192.168.1.10:8000",
  "reachable": true,
  "idle_seconds": 90,
  "state": "awake",
  "viewers": 1,
  "cached_pages": 1,
  "views_total": 12,
  "wakes_total": 5,
  "last_scan_at": "2026-10-30T09:12:44Z",
  "awake_since": "2026-10-30T09:12:44Z",
  "slept_at": null,
  "cache_ttl": 20.0,
  "next_sleep_in": 81.4
}
```

`gateway.snapshot()` 是**平铺**进这个响应的，不再套一层 `gateway` 对象——前端只关心「醒着没有」这一个开关，多一层嵌套只是多一次解引用。

`reachable === false` 是最常见的问题：服务监听在 `127.0.0.1`，手机连不上。这时前端直接给出「允许家庭内设备连接」的开关入口，而不是让用户自己猜为什么扫不出来。

### 恢复的返回

```json
{
  "ok": true,
  "restored": { "entries": 2, "restored_files": 0, "database": "/data/homeledger.db" },
  "pre_restore_backup": "homeledger-20261028-161448-2.zip",
  "message": "数据已恢复，请重启服务以重新加载数据库连接。"
}
```

注意 `pre_restore_backup` 是**自动做的安全备份**，与要恢复的文件不同名（即使同一秒创建）。恢复会替换整个数据库，多 worker 部署后需重启。

---

## 权限速查

| 权限 | owner | admin | member | viewer | guest |
| --- | :-: | :-: | :-: | :-: | :-: |
| `item.view` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `item.create` | ✓ | ✓ | ✓ | | |
| `item.update` | ✓ | ✓ | ✓ | | |
| `item.archive` | ✓ | ✓ | | | |
| `item.delete` | ✓ | ✓ | | | |
| `item.loan` | ✓ | ✓ | ✓ | | |
| `doc.upload` | ✓ | ✓ | ✓ | | |
| `doc.delete` | ✓ | ✓ | | | |
| `maintenance.create` | ✓ | ✓ | ✓ | | |
| `maintenance.complete` | ✓ | ✓ | ✓ | | |
| `member.invite` | ✓ | ✓ | | | |
| `member.update` | ✓ | ✓ | | | |
| `member.disable` | ✓ | | | | |
| `system.backup` | ✓ | ✓ | | | |
| `system.restore` | ✓ | | | | |
| `system.export` | ✓ | ✓ | | | |
| `system.deploy` | ✓ | | | | |
| `system.audit` | ✓ | ✓ | | | |

成员可在角色之外单独授予或禁止某几项（deny 优先）。完整表格见 `GET /families/current/permission-meta`。


---

## 同步（`/sync`）

本地优先客户端之间复制数据用。服务器只负责按序分发状态、存放密文附件、保存被口令包封的数据密钥；
它拿不到解密所需的口令或 DEK。协议与设计见 [LOCAL_FIRST.md](LOCAL_FIRST.md)。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/sync/status` | 家庭复制头、记录数、密文桶用量、设备列表 |
| GET | `/sync/key` | 公开密钥材料（salt + 包封后的 DEK + verifier），未配置时 `configured: false` |
| POST | `/sync/key` | 首次上传密钥材料；已存在时必须显式 `rotate: true` 才能覆盖 |
| DELETE | `/sync/key` | 删除包封好的 DEK（等价于「让所有设备都忘记口令」） |
| GET | `/sync/pull?since=&limit=` | 按家庭内序列增量拉取，`has_more` 表示还要继续 |
| POST | `/sync/apply` | 幂等推送一批记录；HLC 落败的记录会在 `resolved` 里原样回传 |
| POST | `/sync/reset` | 清空复制状态，必须回显当前 `head` 作为确认 |
| PUT | `/sync/blob/{id}` | 上传分块密文（`application/octet-stream`，上限 64 MB） |
| GET | `/sync/blob/{id}` | 下载密文；丢失时返回 410，提示从仍有副本的设备重传 |
| DELETE | `/sync/blob/{id}` | 删除密文 |
| DELETE | `/sync/device/{id}` | 从设备列表移除一台设备 |

推送体示例：

```json
{
  "device_id": "d-8f2c…",
  "device_name": "客厅平板",
  "device_kind": "desktop",
  "app_version": "1.0.2",
  "cursor": 128,
  "records": [
    {
      "entity": "item",
      "id": "3f1e…",
      "hlc": "00000m4k2p-001-ab12cd34",
      "op": "upsert",
      "meta": { "id": "3f1e…", "name": "戴森 V12", "status": "in_use" },
      "secret": "base64(nonce‖ciphertext)",
      "blobs": ["blob-9a…"]
    }
  ]
}
```

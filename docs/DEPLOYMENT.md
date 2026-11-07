# 部署指南

三种模式共用同一个镜像 / 同一份代码，差异只来自环境变量。本文按"从最省事到最可控"排列。

> 使用 CentOS 7.9？看专门的 [CentOS 7.9 部署教程](DEPLOYMENT-CENTOS-7.9.md)，里面包含
> EOL 注意事项、Docker 静态安装、SELinux、Caddy HTTPS、注册人数查看和备份。
> 账号服务器到底存了什么、安装后缓存目录在哪，见 [PRIVACY.md](PRIVACY.md)。

---

## 0. 部署前先决定两件事

| 问题 | 影响 |
| --- | --- |
| **谁会用？** 只有自己 → `local`；全家人 → `gateway`；异地访问 → `cloud` | 决定部署模式与是否需要 HTTPS |
| **数据放哪？** 容器卷 / NAS 共享目录 / 云盘 | 决定 `HOMELEDGER_DATA_VOLUME` 与备份策略 |

无论哪种模式，请先准备一个稳定密钥：

```bash
openssl rand -base64 48
```

把它写进 `.env` 的 `HOMELEDGER_SECRET_KEY`。**不设置也能跑**（会自动生成并持久化到 `data/.secret_key`），但多实例部署或数据目录丢失后，所有设备都需要重新登录。

---

## 1. 家庭网关（推荐）

适用：群晖 / 威联通 NAS、树莓派、迷你主机、淘汰的笔记本。特点是**常年开机、在内网、全家能访问**。

### 1.1 Docker Compose

```bash
git clone <repo> homeledger && cd homeledger
cp .env.example .env

# 至少改这三项
sed -i "s|^HOMELEDGER_SECRET_KEY=.*|HOMELEDGER_SECRET_KEY=$(openssl rand -base64 48)|" .env
# HOMELEDGER_DATA_VOLUME=/volume1/docker/homeledger   ← NAS 上建议用绝对路径
# HOMELEDGER_MEMORY_LIMIT=512M

docker compose up -d --build
docker compose logs -f homeledger
```

打开 `http://<网关IP>:8000`。首屏会引导创建第一个账号，并自动建立一个家庭——这个账号是**家庭所有者，不是实例管理员**。整库备份/恢复需要实例管理员，请在服务器终端执行：

```bash
docker compose exec homeledger python -m app.cli admin you@example.com
```

> **国内网络较慢？** 官方 Debian 源与 PyPI 在国内常见 30 KB/s，装中文字体和 sqlalchemy 这类大包会把构建拖到十几分钟。构建时换源即可：
>
> ```bash
> docker build \
>   --build-arg APT_MIRROR=https://mirrors.tuna.tsinghua.edu.cn \
>   --build-arg PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple \
>   -t homeledger:1.0.2 .
> docker compose up -d --no-build     # 用刚构建好的镜像
> ```
>
> `docker compose build` 同样支持：`docker compose build --build-arg APT_MIRROR=... --build-arg PIP_INDEX_URL=...`。
> 两个参数都不设置时使用官方源，因此镜像对任何网络环境都可用。

**在路由器上给网关分配固定内网 IP（DHCP 保留）**，否则重启后地址变化，家里所有人都要重新记新网址。

### 1.2 裸机 systemd

没有 Docker 时：

```bash
sudo useradd -r -s /usr/sbin/nologin homeledger
sudo mkdir -p /opt/homeledger /var/lib/homeledger
sudo chown -R homeledger:homeledger /opt/homeledger /var/lib/homeledger

# 代码放到 /opt/homeledger/{backend,frontend}
cd /opt/homeledger/backend
sudo -u homeledger python3 -m venv /opt/homeledger/.venv
sudo -u homeledger /opt/homeledger/.venv/bin/pip install -r requirements.txt

# 构建前端
cd /opt/homeledger/frontend && pnpm install && pnpm build   # 产物进 backend/app/static

sudo -u homeledger /opt/homeledger/.venv/bin/python -m app.migrate
sudo cp deploy/homeledger.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now homeledger
```

unit 文件已包含 `ProtectSystem=strict`、`MemoryMax=512M`、`NoNewPrivileges` 等加固项；数据目录是唯一可写路径。

### 1.3 NAS 上的注意事项

- **不要**把数据目录放在会被同步客户端扫描的路径（如群晖 Cloud Sync 监控目录），SQLite 在文件被外部读取/复制时可能触发锁竞争。
- 群晖 DSM 的 Docker 套件里，"启用自动重启"要打开，否则 NAS 重启后服务不会自己起来。
- 内存 512M 足够 10 人以内家庭使用；导入大批量 CSV 时可临时调到 1G。

---

## 2. 本地单机（隐私优先）

```bash
cd backend
HOMEDLEDGER_DATA_DIR=~/.homeledger \
  python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

`--host 127.0.0.1` 是关键：只监听本机回环，局域网内其它设备无法访问。适合"我只想先把自己的东西理清楚，不想让任何人看到"的场景。

单机模式的能力矩阵会关闭多成员、局域网访问与定时任务。想要提醒功能，请改用网关模式（哪怕部署在同一台机器上，只是把 `--host` 改成 `0.0.0.0`）。

单机模式没有自动备份，**请立刻**在「设置 → 数据备份」里手动做一次，并定期导出。

---

## 3. 云服务器

适用：家庭成员不在同一个城市，或者希望随时随地访问。

### 3.1 最低配置

| 项目 | 建议 |
| --- | --- |
| 规格 | 1 核 1G（≤10 人家庭），2 核 2G 更稳 |
| 系统 | Ubuntu 22.04 / Debian 12 |
| 存储 | 20G 起，视附件量增加 |
| 数据库 | 人数少可继续用 SQLite；多副本或高并发请上 PostgreSQL |

### 3.2 反向代理与 HTTPS

**不要把 8000 端口直接暴露到公网。** 用 Caddy 会自动申请证书：

```bash
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile
sudo sed -i 's/homeledger.example.com/你的域名/' /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Caddyfile 内容（已包含安全头与上传体积上限，完整版见 `deploy/Caddyfile`）：

```
homeledger.example.com {
    encode zstd gzip

    request_body {
        max_size 64MB          # 与 HOMELEDGER_MAX_UPLOAD_MB 保持一致
    }

    reverse_proxy 127.0.0.1:8000 {
        header_up X-Real-IP {remote_host}
        header_up X-Forwarded-Proto {scheme}
    }

    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
        X-Content-Type-Options "nosniff"
        X-Frame-Options "SAMEORIGIN"
        Referrer-Policy "strict-origin-when-cross-origin"
        -Server
    }

    # 不写访问日志：默认日志含客户端 IP，本项目不保留这类信息。
}
```

用 Nginx 的话见 `deploy/nginx.conf`，注意 `client_max_body_size` 要与 `HOMELEDGER_MAX_UPLOAD_MB` 匹配，否则大图上传会被代理层拦掉并返回 413。

同时把 `.env` 里的 `HOMELEDGER_DEPLOYMENT_MODE` 改成 `cloud`，界面会显示云端专属的检查清单与警告。

### 3.3 使用 PostgreSQL

```bash
docker compose --profile postgres up -d
```

```env
HOMELEDGER_DATABASE_URL=postgresql+psycopg2://homeledger:<密码>@postgres:5432/homeledger
```

镜像默认不装 `psycopg2`（保持体积）；需要在 `requirements.txt` 里取消注释并重新构建：

```
psycopg2-binary==2.9.9
```

> **切换数据库不是改个连接串就完事。** 两者共用同一套 ORM 模型，但 JSON 列类型、`LIKE` 大小写敏感性、日期函数行为不同。切换前请：
> 1. 在测试环境跑一遍 `python -m pytest`；
> 2. 用 `GET /system/export.json` 导出，导入新库后逐项核对条数；
> 3. 确认 `GET /system/providers` 里 `database.dialect` 已变成 `postgresql`。

切换后**自动恢复功能不可用**（接口会明确报错），PostgreSQL 请用 `pg_dump` / `pg_restore`。

---

## 4. 备份

### 4.1 应用内备份

「设置 → 数据备份」可手动创建，或由调度器按 `HOMELEDGER_AUTO_BACKUP_HOURS`（默认 24 小时）自动执行。

- 使用 SQLite 在线备份 API，**无需停机**，快照一致。
- 包内含 `manifest.json`（版本、schema 版本、行数）、`database.db`、`uploads/`。
- 恢复需输入 `RESTORE`，且会先自动做一次安全备份。

### 4.2 冷备份脚本

`deploy/backup.sh` 适合放进 cron，把备份复制到另一块盘或 NAS：

```bash
sudo cp deploy/backup.sh /usr/local/bin/homeledger-backup
sudo chmod +x /usr/local/bin/homeledger-backup

# 每天 3:20 备份，保留 14 天，并复制到挂载的备份盘
20 3 * * * HOMELEDGER_DATA_DIR=/var/lib/homeledger \
           HOMELEDGER_BACKUP_DIR=/mnt/backup/homeledger \
           HOMELEDGER_BACKUP_KEEP_DAYS=14 \
           /usr/local/bin/homeledger-backup
```

脚本用 `sqlite3 .backup` 做一致性快照（不是 `cp`），并清理过期文件。

### 4.3 异地副本（3-2-1 原则）

家庭数据量很小（通常 < 1G），完全做得到：

1. 本地一份（网关自身）
2. 家庭内另一台设备一份（NAS 同步 / 移动硬盘）
3. 异地一份（加密后传对象存储，或定期带走的 U 盘）

第 3 份不需要自动化，每季度手动拷一次就比 90% 的家庭做得好。

---

## 5. 升级

```bash
cd homeledger
git pull
docker compose up -d --build     # 迁移在启动时自动执行，且是幂等的
```

裸机部署：

```bash
sudo systemctl stop homeledger
sudo -u homeledger /opt/homeledger/.venv/bin/pip install -r backend/requirements.txt
sudo -u homeledger /opt/homeledger/.venv/bin/python -m app.migrate
sudo systemctl start homeledger
```

**升级前先备份。** 迁移是向前的，没有自动回滚；出问题时靠备份包恢复。

前端有更新时记得重新 `pnpm build`，产物要落到 `backend/app/static`。

---

## 6. 常见故障

| 现象 | 原因与处理 |
| --- | --- |
| 打开是 404 / 白屏 | 前端未构建。`ls backend/app/static/index.html` 确认；构建后重启 |
| 所有人被强制重新登录 | `HOMELEDGER_SECRET_KEY` 变了（或未设置且数据目录被重建）。设一个固定值 |
| 上传大图报 413 | 代理层 `client_max_body_size` 小于 `HOMELEDGER_MAX_UPLOAD_MB`，两者对齐 |
| 上传中文文件名乱码 | 需 `Content-Disposition` 的 `filename*=utf-8''`；本项目已处理，若仍异常多为代理改写头部 |
| 多人同时编辑提示冲突 | 正常行为：乐观锁返回 409 并展示对方改动，刷新后重试即可 |
| 提醒重复发 | 检查是否多副本各自跑了调度器。多副本时设 `HOMELEDGER_ENABLE_SCHEDULER=false`，改用独立单例 worker |
| 服务随机卡住 | NAS 上数据目录被同步软件监控 / 放在网络共享上。改到本地磁盘路径 |
| 恢复后数据不对 | 确认恢复的是哪个 zip（`pre_restore_backup` 是恢复前的现场）。恢复会替换整个数据库，请从备份列表核对时间戳 |
| 内存持续增长 | 附件缩略图生成时 PIL 占用较高；限制单文件大小并定期重启（`MemoryMax` 会自动兜底） |

### 健康检查

```bash
curl -s http://127.0.0.1:8000/api/v1/system/health | jq
```

```json
{
  "ok": true,
  "app": "HomeLedger",
  "version": "1.0.2",
  "mode": "gateway",
  "database": { "ok": true, "dialect": "sqlite", "path": "/data/homeledger.db" }
}
```

`ok: false` 通常意味着数据目录权限错误或磁盘已满。

### 查看当前生效的 Provider

```bash
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8000/api/v1/system/providers | jq
```

「设置 → 部署」页面对应的就是这份数据，可以直观看到数据库、存储、通知、AI 各自的实现与健康状况。

---

## 7. 安全清单

上线前逐项确认：

- [ ] `HOMELEDGER_SECRET_KEY` 已显式设置为随机值，且未提交到版本库
- [ ] 外网访问一律走 HTTPS，8000 端口不对公网开放
- [ ] 家庭成员注册完成后，把 `HOMELEDGER_ALLOW_REGISTRATION` 改为 `false`
- [ ] 邀请码在成员加入后重置一次（「成员 → 重置邀请码」）
- [ ] 已配置自动备份，并**实际做过一次恢复演练**
- [ ] 网关接入 UPS 或至少防止直接断电（SQLite 抗断电，但文件系统不一定）
- [ ] 定期检查「操作记录」，确认没有异常账号活动
- [ ] 云端部署时确认 `HOMELEDGER_AI_PROVIDER=local`（除非确实接受图片外发）

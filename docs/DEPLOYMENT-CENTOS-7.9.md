# 在 CentOS 7.9 上部署账号服务器

这篇是给「我有一台 CentOS 7.9 服务器，想让家人登录 HomeLedger」的完整操作手册。
按顺序执行即可，命令都假设你是 root 或有 sudo。

> 这里部署的是**用户自己的数据服务器**。软件方的联网账号服务（`nas.ltyfans.cn`）
> 是另一套东西，只做注册/登录验证，不存物品数据，部署见
> [ACCOUNT-SERVICE.md](ACCOUNT-SERVICE.md)。

> **先看这一句：CentOS 7.9 已于 2024-06-30 停止维护，官方不再发安全更新。**
> 这台机器如果暴露在公网，风险会随时间上升。能换系统就换 Rocky Linux 9 / AlmaLinux 9 /
> Debian 12；必须留在 7.9 时，至少做到：只开 80/443、强密码、定期备份、及时关注
> 服务商的安全通告。下面的方案在 7.9 上可用，但不会改变 7.9 本身已停止维护的事实。

---

## 0. 先弄清「数据在谁手里」

HomeLedger 有三种模式，服务器部署只负责其中两种：

| 模式 | 数据位置 | 服务器存什么 |
| --- | --- | --- |
| 仅本机 | 手机/电脑本机 | 不连接服务器 |
| 本机 + 加密同步 | 每台设备各一份，服务器做会合点 | 登录账号 + 同步索引明文 + 敏感字段/照片密文 |
| 直连服务器 | 服务器数据库 | 登录账号 + 家庭物品数据 |

服务器**不会**替客户端做「全量明文上传」：同步模式下描述、序列号、价格、备注、照片等
都是客户端加密后才上传的。账号侧只保存邮箱、密码哈希、显示名、家庭成员关系和
时间戳；不采集手机号、地址、定位、通讯录、设备指纹或使用行为。完整说明见
[PRIVACY.md](PRIVACY.md)。

---

## 1. 准备

### 1.1 服务器

| 项目 | 最低 | 建议 |
| --- | --- | --- |
| CPU / 内存 | 1 核 1G | 2 核 2G |
| 磁盘 | 20G | 40G 起，按附件量增加 |
| 系统 | CentOS 7.9 x86_64 | Rocky/Alma 9 |
| 域名 | 可选 | 建议有，HTTPS 需要 |

确认系统信息：

```bash
cat /etc/centos-release
uname -m
df -h
free -m
```

后面的命令都以 **x86_64** 为准。ARM 服务器需要换 Docker/Caddy 的 arm64 包。

### 1.2 DNS 和防火墙

如果使用域名，先在 DNS 服务商添加一条 A 记录：

```
hl.example.com  ->  你的服务器公网 IP
```

防火墙只放行 SSH、HTTP、HTTPS。**不要放行 8000**，应用会只绑定在 127.0.0.1，
由 Caddy 反向代理：

```bash
sudo firewall-cmd --permanent --add-service=ssh
sudo firewall-cmd --permanent --add-service=http
sudo firewall-cmd --permanent --add-service=https
sudo firewall-cmd --reload
sudo firewall-cmd --list-all
```

如果云厂商还有安全组，也要在控制台放行 22/80/443。

### 1.3 安装基础工具

```bash
sudo yum install -y yum-utils curl tar sqlite openssl ca-certificates
sudo update-ca-certificates
```

CentOS 7 的 CA 证书可能偏旧；如果后面 `curl https://github.com` 报证书错误，先执行：

```bash
sudo yum update -y ca-certificates
```

---

## 2. 安装 Docker（CentOS 7 的两种方式）

### 方式 A：Docker CE 仓库（优先）

```bash
sudo yum install -y yum-utils device-mapper-persistent-data lvm2
sudo yum-config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo

# CentOS 7 已 EOL，部分镜像站不再提供 $releasever 的 7 目录；固定成 7。
sudo sed -i 's/\$releasever/7/g' /etc/yum.repos.d/docker-ce.repo

# 固定 24.0.9：这是仍支持 CentOS 7 的最后一个稳定大版本之一。
sudo yum install -y \
  docker-ce-24.0.9-1.el7 \
  docker-ce-cli-24.0.9-1.el7 \
  containerd.io

sudo systemctl enable --now docker
sudo docker version
```

如果仓库已经 404，直接走方式 B。

### 方式 B：Docker 静态二进制（仓库不可用时）

```bash
curl -fsSL https://download.docker.com/linux/static/stable/x86_64/docker-24.0.9.tgz \
  -o /tmp/docker.tgz
sudo tar -xzf /tmp/docker.tgz -C /tmp
sudo cp /tmp/docker/* /usr/bin/

sudo tee /etc/systemd/system/docker.service >/dev/null <<'EOF'
[Unit]
Description=Docker Application Container Engine
After=network-online.target firewalld.service
Wants=network-online.target

[Service]
Type=notify
ExecStart=/usr/bin/dockerd --host=unix:///var/run/docker.sock
ExecReload=/bin/kill -s HUP $MAINPID
LimitNOFILE=infinity
LimitNPROC=infinity
LimitCORE=infinity
TasksMax=infinity
Delegate=yes
KillMode=process
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now docker
sudo docker version
```

### 2.1 Docker 日志与 Compose

限制 Docker 日志，避免把磁盘写满：

```bash
sudo mkdir -p /etc/docker
sudo tee /etc/docker/daemon.json >/dev/null <<'EOF'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" },
  "live-restore": true
}
EOF
sudo systemctl restart docker
```

安装 Compose v2 插件（静态二进制，不依赖 Python）：

```bash
sudo mkdir -p /usr/local/lib/docker/cli-plugins
sudo curl -fsSL \
  https://github.com/docker/compose/releases/download/v2.29.7/docker-compose-linux-x86_64 \
  -o /usr/local/lib/docker/cli-plugins/docker-compose
sudo chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
docker compose version
```

> 如果服务器访问 GitHub 很慢，可以在本机下载后 `scp` 上去，或改用服务商提供的
> Docker 镜像加速。镜像加速只影响拉取基础镜像，不影响 Compose 插件。

---

## 3. 部署 HomeLedger

### 3.1 把代码放到服务器

```bash
sudo mkdir -p /opt/homeledger
sudo chown "$USER":"$USER" /opt/homeledger
git clone <你的仓库地址> /opt/homeledger
cd /opt/homeledger
```

没有 git 时，在本机把仓库打成 zip，用 `scp` 上传后解压到 `/opt/homeledger`。

### 3.2 准备数据目录

用宿主机目录保存数据，升级/删容器都不会丢：

```bash
sudo mkdir -p /srv/homeledger/data
# 容器内运行用户是 uid 10001，必须让它能写
sudo chown -R 10001:10001 /srv/homeledger/data
# CentOS 7 默认开 SELinux；给目录打上容器可写标签
sudo chcon -Rt svirt_sandbox_file_t /srv/homeledger/data
```

### 3.3 写 `.env`

```bash
cd /opt/homeledger
cp .env.example .env

# 生成一个固定密钥；换掉它会让所有已登录设备重新登录
SECRET=$(openssl rand -base64 48)
sed -i "s|^HOMELEDGER_SECRET_KEY=.*|HOMELEDGER_SECRET_KEY=${SECRET}|" .env

# 公网服务器用 cloud；只在家里局域网用 gateway
sed -i 's|^HOMELEDGER_DEPLOYMENT_MODE=.*|HOMELEDGER_DEPLOYMENT_MODE=cloud|' .env

# 数据放到宿主机目录，并让 SELinux 放行
sed -i 's|^HOMELEDGER_DATA_VOLUME=.*|HOMELEDGER_DATA_VOLUME=/srv/homeledger/data|' .env
sed -i 's|^# HOMELEDGER_DATA_VOLUME_OPTS=.*|HOMELEDGER_DATA_VOLUME_OPTS=:Z|' .env

# 只监听本机，公网只通过 Caddy 的 443 进来
sed -i 's|^HOMELEDGER_PORT=.*|HOMELEDGER_PORT=127.0.0.1:8000|' .env

# 先允许自助注册；账号建完后可以改成 false（见第 6 节）
sed -i 's|^HOMELEDGER_ALLOW_REGISTRATION=.*|HOMELEDGER_ALLOW_REGISTRATION=true|' .env

grep -E '^(HOMELEDGER_SECRET_KEY|HOMELEDGER_DEPLOYMENT_MODE|HOMELEDGER_DATA_VOLUME|HOMELEDGER_DATA_VOLUME_OPTS|HOMELEDGER_PORT|HOMELEDGER_ALLOW_REGISTRATION)=' .env
```

`.env` 里不要提交到 git。`HOMELEDGER_SECRET_KEY` 一旦丢失，所有人需要重新登录；
数据本身不受影响。

### 3.4 构建镜像

```bash
cd /opt/homeledger

# 国内服务器建议换 Debian/PyPI 镜像，否则构建可能十几分钟
docker compose build \
  --build-arg APT_MIRROR=https://mirrors.aliyun.com \
  --build-arg PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple

docker compose up -d
docker compose ps
```

如果服务器拉不到 `node:20-alpine` / `python:3.12-slim`，在本机（能联网的 Docker）构建：

```bash
# 本机
docker build -t homeledger:2.0.2-beta .
docker save homeledger:2.0.2-beta | gzip -9 > homeledger-image.tar.gz
scp homeledger-image.tar.gz root@<服务器IP>:/root/

# 服务器
docker load < /root/homeledger-image.tar.gz
cd /opt/homeledger
docker compose up -d --no-build
```

### 3.5 先验证后端

```bash
curl -fsS http://127.0.0.1:8000/api/v1/system/health | python -m json.tool
```

应该看到 `"ok": true`。首次启动会自动建表；不需要手动跑迁移。

再看公开信息：

```bash
curl -fsS http://127.0.0.1:8000/api/v1/system/info | python -m json.tool
```

其中：

- `bootstrap_required: true` 表示还没有账号，第一个从网页注册的人会创建家庭并成为家庭所有者（**不是实例管理员**）；
- `registered_users` 是当前可登录账号数，邀请占位账号不计入；
- 没有演示账号，也没有默认密码。

---

## 4. 配置 HTTPS（Caddy）

HomeLedger 自带前端静态文件，Caddy 只做反向代理和证书。

### 4.1 安装 Caddy

```bash
CADDY_VERSION=2.11.8
curl -fsSL \
  "https://github.com/caddyserver/caddy/releases/download/v${CADDY_VERSION}/caddy_${CADDY_VERSION}_linux_amd64.tar.gz" \
  -o /tmp/caddy.tar.gz
sudo tar -xzf /tmp/caddy.tar.gz -C /tmp caddy
sudo mv /tmp/caddy /usr/bin/caddy
sudo chmod +x /usr/bin/caddy

sudo useradd --system --home /var/lib/caddy --shell /usr/sbin/nologin caddy 2>/dev/null || true
sudo mkdir -p /etc/caddy /var/lib/caddy
sudo chown -R caddy:caddy /var/lib/caddy
```

### 4.2 写 Caddyfile

仓库里的 [deploy/Caddyfile](../deploy/Caddyfile) 已经包含安全头和上传上限。复制并替换域名：

```bash
sudo cp /opt/homeledger/deploy/Caddyfile /etc/caddy/Caddyfile
# 把第一行的域名改成你自己的域名，例如 hl.example.com
sudo nano /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile
```

> Caddyfile 里的 `request_body` 需要 Caddy 2.10+；上面的 2.11.8 满足。
> 如果 `caddy validate` 报未知指令，升级 Caddy 或删掉 `request_body` 块——应用自身
> 仍会按 `HOMELEDGER_MAX_UPLOAD_MB` 限制上传大小。

Caddy 的 systemd unit：

```bash
sudo tee /etc/systemd/system/caddy.service >/dev/null <<'EOF'
[Unit]
Description=Caddy
Documentation=https://caddyserver.com/docs/
After=network.target

[Service]
User=caddy
Group=caddy
Environment=HOME=/var/lib/caddy
ExecStart=/usr/bin/caddy run --environ --config /etc/caddy/Caddyfile
ExecReload=/usr/bin/caddy reload --config /etc/caddy/Caddyfile --force
TimeoutStopSec=5s
LimitNOFILE=1048576
PrivateTmp=true
ProtectSystem=full
AmbientCapabilities=CAP_NET_BIND_SERVICE

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now caddy
sudo systemctl status caddy --no-pager
```

Caddy 会自动向 Let's Encrypt 申请证书。前提是：

1. `hl.example.com` 已解析到这台服务器；
2. 80 和 443 对公网开放；
3. 服务器能访问外网。

第一次申请通常几十秒。看日志：

```bash
sudo journalctl -u caddy -n 80 --no-pager
```

### 4.3 检查

```bash
curl -I https://hl.example.com
curl -fsS https://hl.example.com/api/v1/system/health | python -m json.tool
```

`curl -I` 应返回 `200` 或前端首页；`health` 应为 `ok: true`。

> 没有域名时，Caddy 无法自动签证书。可以先用 `http://服务器IP:8000` 在家庭内网
> 测试，但**不要**把 8000 直接暴露到公网。正式使用请配域名 + HTTPS。

---

## 5. 创建账号并让家人登录

### 5.1 第一个账号

浏览器打开：

```
https://hl.example.com
```

第一个从网页注册的账号会创建一个家庭，并成为**家庭所有者，不是实例管理员**。**没有默认账号、没有演示密码。**
密码至少 8 位。

整库备份、恢复和服务器诊断只对实例管理员开放，需要在服务器终端单独设置：

```bash
docker compose exec homeledger \
  python -m app.cli admin you@example.com
```

也可以在服务器上直接建账号（不经过浏览器）：

```bash
docker compose exec homeledger \
  python -m app.seed \
  --email you@example.com \
  --password '至少8位的密码' \
  --family-name '我的家'
```

脚本只使用你传入的邮箱/密码；不加 `--demo` 不会写任何示例物品。它创建的同样是
家庭所有者，不会自动获得实例管理员权限——需要时再执行上面的 `app.cli admin`。
输出里的邀请码 5 分钟内有效，过期可在应用的「成员」页面重新生成。

### 5.2 家人加入

有两种方式：

1. 管理员在「成员」页面邀请邮箱，生成邀请链接/邀请码；
2. 家人自己注册时选择「加入家庭」，填邀请码。

注册完成后，各自在客户端「设置 → 同步」里选择：

- **仅本机**：物品只在自己设备，不上传；
- **本机 + 加密同步**：登录账号后，设备之间同步加密副本；
- **直连服务器**：浏览器/瘦客户端直接读写服务器数据库。

### 5.3 查看注册人数

公开接口只返回一个整数，不返回任何账号信息：

```bash
curl -fsS http://127.0.0.1:8000/api/v1/system/stats | python -m json.tool
```

```json
{ "registered_users": 3 }
```

`/api/v1/system/info` 里也有同一个字段。人数从 `users` 表实时统计，邀请占位账号
（还没完成注册的邮箱）不计入。

---

## 6. 关闭自助注册（可选）

家庭成员都注册完成后，如果不想让陌生人看到注册页：

```bash
cd /opt/homeledger
sed -i 's|^HOMELEDGER_ALLOW_REGISTRATION=.*|HOMELEDGER_ALLOW_REGISTRATION=false|' .env
docker compose up -d
```

之后新成员只能由管理员邀请。需要再开放时改回 `true` 并重启。注意：当前版本的
邀请占位账号仍需对方通过注册页完成注册；如果关闭注册，先确认所有成员都已完成注册。

---

## 7. 备份与恢复

### 7.1 应用内备份

管理员在「设置 → 数据与备份」里可以手动创建备份，也可以按
`HOMELEDGER_AUTO_BACKUP_HOURS`（默认 24 小时）自动备份。备份文件在：

```
/srv/homeledger/data/backups/
```

### 7.2 冷备份（推荐再加一层）

`deploy/backup.sh` 用 SQLite 在线备份 API 做一致性快照，再打包附件：

```bash
sudo install -m 755 /opt/homeledger/deploy/backup.sh /usr/local/bin/homeledger-backup
sudo mkdir -p /srv/backup/homeledger

# 手动跑一次
sudo HOMELEDGER_DATA_DIR=/srv/homeledger/data \
     HOMELEDGER_BACKUP_DIR=/srv/backup/homeledger \
     HOMELEDGER_BACKUP_KEEP_DAYS=14 \
     /usr/local/bin/homeledger-backup
```

加入 cron（每天 03:20）：

```bash
sudo crontab -e
```

```cron
20 3 * * * HOMELEDGER_DATA_DIR=/srv/homeledger/data HOMELEDGER_BACKUP_DIR=/srv/backup/homeledger HOMELEDGER_BACKUP_KEEP_DAYS=14 /usr/local/bin/homeledger-backup
```

脚本**有意不备份** `.secret_key`：它只是会话签名密钥，泄露后可以伪造登录。恢复后
让所有人重新登录一次即可。

### 7.3 异地副本

至少再拷一份到另一台机器或对象存储。备份里可能包含家庭照片和账号邮箱，上传前请
自行加密（例如 `age` / `gpg`），不要直接放进公开网盘。

### 7.4 恢复

优先用应用内「数据与备份 → 恢复」，需要输入 `RESTORE`，且会先自动做一次安全备份。
SQLite 的冷备份包可以在停机后解压回 `/srv/homeledger/data`，再启动容器。

---

## 8. 升级

```bash
cd /opt/homeledger
git pull
docker compose build \
  --build-arg APT_MIRROR=https://mirrors.aliyun.com \
  --build-arg PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple
docker compose up -d
```

迁移在启动时自动执行，幂等。升级前先做一次备份；数据目录是宿主机目录，删容器、
重建镜像都不会丢。

查看日志：

```bash
docker compose logs -f --tail=100 homeledger
```

---

## 9. 常见故障

| 现象 | 原因与处理 |
| --- | --- |
| `docker compose` 报 `HOMELEDGER_SECRET_KEY` 未设置 | `.env` 没写或不在当前目录；`grep HOMELEDGER_SECRET_KEY .env` 检查 |
| 容器起来但 502 | 后端没起或端口不对；`docker compose ps`、`docker compose logs homeledger` |
| 数据目录 permission denied | `chown -R 10001:10001 /srv/homeledger/data`；SELinux 加 `:Z` 或 `chcon` |
| Caddy 证书申请失败 | DNS 未生效 / 80/443 未放行 / 服务器出不了外网；看 `journalctl -u caddy` |
| 上传大图 413 | `HOMELEDGER_MAX_UPLOAD_MB` 与 Caddyfile 的 `max_size` 保持一致 |
| 所有人突然要重新登录 | `HOMELEDGER_SECRET_KEY` 变了，或数据目录被重建；固定密钥 |
| 数据库锁住 | 不要把 SQLite 放在 NFS/SMB 或同步盘；用本机磁盘 |
| 注册人数不涨 | 邀请占位账号不计入；对方完成注册后才 +1 |
| 忘记管理员密码 | 目前没有网页找回；在服务器上用 CLI 另建账号，或恢复备份后处理 |

### 看健康状态

```bash
curl -fsS http://127.0.0.1:8000/api/v1/system/health | python -m json.tool
```

### 看容器资源

```bash
docker stats --no-stream
```

---

## 10. 上线前检查清单

- [ ] CentOS 7.9 已接受 EOL 风险，或已计划迁移
- [ ] 只开放 22/80/443，8000 绑定在 127.0.0.1
- [ ] `HOMELEDGER_SECRET_KEY` 是随机值，`.env` 未提交 git
- [ ] 数据目录在宿主机本地磁盘，uid 10001 可写
- [ ] HTTPS 证书有效，HTTP 自动跳转 HTTPS
- [ ] 第一个管理员账号已创建，密码足够强
- [ ] 家人已按需选择「仅本机 / 加密同步 / 直连」
- [ ] 应用内备份 + 冷备份 + 异地副本至少各验证一次
- [ ] `HOMELEDGER_ALLOW_REGISTRATION` 按需要设置
- [ ] 知道怎么查看注册人数：`/api/v1/system/stats`

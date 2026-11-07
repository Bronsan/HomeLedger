# 联网账号服务（nas.ltyfans.cn）

这份文档只讲**账号服务**：它负责注册、登录验证和用户数量统计，不保存任何物品、
照片或同步数据。用户自己的家庭服务器（数据服务器）仍然按
[DEPLOYMENT-CENTOS-7.9.md](DEPLOYMENT-CENTOS-7.9.md) 独立部署。

| 服务器 | 归属 | 存什么 | 谁维护 |
| --- | --- | --- | --- |
| 数据服务器 | 每个用户自己 | 物品、照片、附件、家庭数据 | 用户自己 |
| 账号服务 | 你（软件方） | 邮箱、密码哈希、显示名、注册时间 | 你 |

客户端安装后第一屏会让人选：

- **本机使用**：不注册账号，直接以 `me@local` 进入，数据只在本机；
- **联网账号**：注册 / 登录账号服务，每次冷启动向账号服务验证一次，
  物品数据仍然留在本机。

> 目前客户端账号表单只接受 QQ 邮箱，但界面上不会提示这一点，填错时只显示
> “邮箱格式不正确”。以后要放开其它邮箱，需要同时改服务端白名单和客户端校验。

---

## 1. 部署账号服务

账号服务就是同一个 HomeLedger 镜像，只是打开 `HOMELEDGER_SERVICE_MODE`。
在服务器上：

```bash
sudo mkdir -p /srv/homeledger-account/data
sudo chown -R 10001:10001 /srv/homeledger-account/data
sudo chcon -Rt svirt_sandbox_file_t /srv/homeledger-account/data
```

把仓库放到 `/opt/homeledger-account`，复制 `.env.example` 为 `.env`，至少设置：

```env
HOMELEDGER_DEPLOYMENT_MODE=cloud
HOMELEDGER_SECRET_KEY=<openssl rand -base64 48 的输出>
HOMELEDGER_SERVICE_MODE=true
HOMELEDGER_EMAIL_DOMAINS=qq.com
HOMELEDGER_ALLOW_REGISTRATION=true
HOMELEDGER_DATA_VOLUME=/srv/homeledger-account/data
HOMELEDGER_DATA_VOLUME_OPTS=:Z
HOMELEDGER_PORT=127.0.0.1:8000
```

`HOMELEDGER_SERVICE_MODE=true` 有两个作用：

1. 注册时只写 `users` 行，不创建家庭、分类或任何物品数据；
2. `HOMELEDGER_EMAIL_DOMAINS` 留空时默认只允许 `qq.com`。

构建并启动：

```bash
cd /opt/homeledger-account
docker compose build \
  --build-arg APT_MIRROR=https://mirrors.aliyun.com \
  --build-arg PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple
docker compose up -d
curl -fsS http://127.0.0.1:8000/api/v1/system/health
```

## 2. 域名与 HTTPS

客户端默认连接 `https://nas.ltyfans.cn`（443）。把域名 A 记录指向这台服务器，
然后用 Caddy 反代 `127.0.0.1:8000`：

```bash
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile
sudo nano /etc/caddy/Caddyfile   # 第一行改成 nas.ltyfans.cn
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

如果账号服务最终不用 443 端口，例如 `https://nas.ltyfans.cn:8443`，需要：

1. 防火墙和云安全组放行该端口；
2. 用 `VITE_SERVICE_BASE_URL=https://nas.ltyfans.cn:8443` 重新构建客户端；
3. 确认 Caddy/Nginx 的证书覆盖该端口。

客户端代码在 `frontend/src/lib/service.ts`，默认值就是 `https://nas.ltyfans.cn`。

## 3. 验证账号服务

注册一个 QQ 邮箱账号：

```bash
curl -fsS -X POST https://nas.ltyfans.cn/api/v1/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","password":"至少8位密码","display_name":"测试"}'
```

返回里应有 `token` 和 `user`，`current_family_id` 为 `null`（账号服务不建家庭）。

非 QQ 邮箱应返回 `400 邮箱格式不正确`：

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://nas.ltyfans.cn/api/v1/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"someone@example.com","password":"至少8位密码","display_name":"测试"}'
```

查看注册人数：

```bash
curl -fsS https://nas.ltyfans.cn/api/v1/system/stats
# {"registered_users": 1}
```

人数只统计能登录的账号，邀请占位账号不计入；接口不返回邮箱、ID 或任何身份信息。

## 4. 数据与隐私边界

账号服务只保存：

- 邮箱（登录标识）
- scrypt 密码哈希（不可逆）
- 显示名（成员列表/问候语用）
- 注册时间、最后登录时间、账号状态

不保存：手机号、真实姓名、住址、定位、通讯录、设备标识、使用行为、物品数据。
审计日志不写 IP / User-Agent；Docker、systemd、Caddy、Nginx 的访问日志均已关闭。

数据库在 `/srv/homeledger-account/data/homeledger.db`。备份方式与
[CentOS 7.9 教程](DEPLOYMENT-CENTOS-7.9.md#7-备份与恢复)相同。

## 5. 后续收费

当前版本只做账号注册、登录验证和人数统计，没有支付逻辑。后续要加订阅/授权时，
建议在账号服务侧增加 `plan` / `expires_at` 字段，并在 `/auth/me` 返回授权状态；
客户端在欢迎页验证通过后读取该字段即可，不需要改动物品数据链路。

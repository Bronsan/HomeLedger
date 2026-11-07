#!/usr/bin/env bash
# 冷备份脚本 —— 不依赖 API 是否在线，适合放进 cron。
#
#   20 3 * * * HOMELEDGER_DATA_DIR=/var/lib/homeledger \
#              HOMELEDGER_BACKUP_DIR=/mnt/backup/homeledger \
#              HOMELEDGER_BACKUP_KEEP_DAYS=14 \
#              /usr/local/bin/homeledger-backup
#
# 为什么不是 `cp homeledger.db`：WAL 模式下最近的提交可能还在 -wal 文件里，
# 直接拷贝主库会丢掉这部分数据。因此优先用 sqlite3 的在线备份 API 取快照，
# 再连同附件一起打包。
set -euo pipefail

DATA_DIR="${HOMELEDGER_DATA_DIR:-/var/lib/homeledger}"
BACKUP_DIR="${HOMELEDGER_BACKUP_DIR:-/backup/homeledger}"
# 兼容老配置里的 HOMELEDGER_KEEP_DAYS
KEEP_DAYS="${HOMELEDGER_BACKUP_KEEP_DAYS:-${HOMELEDGER_KEEP_DAYS:-30}}"
STAMP="$(date +%Y%m%d-%H%M%S)"
TARGET="${BACKUP_DIR}/homeledger-${STAMP}.tar.gz"

if [ ! -d "${DATA_DIR}" ]; then
  echo "数据目录不存在：${DATA_DIR}" >&2
  exit 1
fi
mkdir -p "${BACKUP_DIR}"

STAGE="$(mktemp -d)"
trap 'rm -rf "${STAGE}"' EXIT

# --- 1. 数据库：一致性快照 ----------------------------------------------
DB="${DATA_DIR}/homeledger.db"
if [ -f "${DB}" ]; then
  if command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 "${DB}" ".backup '${STAGE}/homeledger.db'"
  else
    echo "警告：未找到 sqlite3，退化为文件拷贝。已连同 -wal/-shm 一起打包，恢复时 SQLite 会自行重放；但并发写入期间仍可能得到不一致快照，建议安装 sqlite3。" >&2
    cp "${DB}" "${STAGE}/homeledger.db"
    # wal/shm 必须跟着走，否则拷贝出来的主库会缺最近提交。
    for sidecar in "-wal" "-shm"; do
      [ -f "${DB}${sidecar}" ] && cp "${DB}${sidecar}" "${STAGE}/homeledger.db${sidecar}"
    done
  fi
else
  echo "警告：${DB} 不存在，本次仅备份附件" >&2
fi

# --- 2. 附件与安装标识 ---------------------------------------------------
if [ -d "${DATA_DIR}/uploads" ]; then
  cp -a "${DATA_DIR}/uploads" "${STAGE}/uploads"
fi
if [ -f "${DATA_DIR}/.install_id" ]; then
  cp -a "${DATA_DIR}/.install_id" "${STAGE}/.install_id"
fi
# 有意不备份 .secret_key：它只是会话签名密钥，泄露后可伪造任意用户身份。
# 恢复后让所有人重新登录一次，代价远小于把密钥副本散落在备份盘上。

# --- 3. 打包 -------------------------------------------------------------
tar czf "${TARGET}" -C "${STAGE}" .
chmod 600 "${TARGET}"

SIZE="$(du -h "${TARGET}" | cut -f1)"
echo "[$(date '+%F %T')] 备份完成 ${TARGET} (${SIZE})"

# --- 4. 清理过期备份 -----------------------------------------------------
find "${BACKUP_DIR}" -maxdepth 1 -name 'homeledger-*.tar.gz' -type f \
  -mtime "+${KEEP_DAYS}" -print -delete

COUNT="$(find "${BACKUP_DIR}" -maxdepth 1 -name 'homeledger-*.tar.gz' -type f | wc -l | tr -d ' ')"
echo "[$(date '+%F %T')] 保留 ${KEEP_DAYS} 天，当前共 ${COUNT} 份"

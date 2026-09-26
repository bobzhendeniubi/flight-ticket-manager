#!/usr/bin/env bash
# 每日备份 Postgres（ftm 库）→ pg_dump 自定义格式快照（-Fc，自带压缩），保留最近 14 天。
#
# ⚠️ 服务器上只存本机 /opt/ftm/backups，另由本机（Mac）launchd 每天拉回一份（infra/local/）：
#    - 挡得住：误删、跑错迁移、容器重建、`docker compose down`（不带 -v）、整机丢失（靠拉回的那份）
#    - 挡不住：服务器和本机同时丢；本机拉取断了多天没人发现（看门狗只看服务器这份新不新）
#
# 产物：$BACKUP_DIR/ftm_YYYYMMDD_HHMMSS.dump
#   1) 先写 ftm_*.dump.partial：看门狗和本机拉取只认 ftm_*.dump，永远拿不到半截文件；
#   2) 两道校验：pg_restore --list 读目录（文件头完好）+ 整份读一遍写到 /dev/null
#      （经管道导出的 -Fc 目录在文件开头，截断的文件照样列得出目录，只有通读才发现）；
#   3) 都过了才改名成正式文件、判 ok。任一步失败：删 .partial、写原因、非 0 退出，
#      旧快照一份不删（过期清理只在成功之后跑）。
#   导出前先看剩余空间：不够「上一份的 2 倍」（且不少于 BACKUP_MIN_FREE_MB）就不导——
#   07-02 盘写满让 Postgres 连续 PANIC 过，备份自己不能成为写满盘的那一下。
#
# 旧格式 ftm_*.sql.gz（改格式前的快照、refresh-staging-db.sh 顺手导出的）照样按保留天数清理。
# 恢复步骤见文件末尾；完整说明与演练记录见 docs/运维-监控与备份.md。
#
# 用法：bash /opt/ftm/infra/staging/backup-db.sh
# 定时：crontab 每天 03:30（见文件末尾安装说明）。
# 可用环境变量覆盖（本地演练用）：BACKUP_DIR / BACKUP_CONTAINER / BACKUP_RETAIN_DAYS / BACKUP_MIN_FREE_MB
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/opt/ftm/backups}"
CONTAINER="${BACKUP_CONTAINER:-ftm-postgres-prod}"
RETAIN_DAYS="${BACKUP_RETAIN_DAYS:-14}"
MIN_FREE_MB="${BACKUP_MIN_FREE_MB:-2048}"
DB_USER=ftm
DB_NAME=ftm

log() { echo "$(date '+%F %T') [backup] $*"; }
fail() {
  log "FAILED: $*" >&2
  exit 1
}

# 参数里 mtime 最新的那个文件（没有就输出空）
newest_of() {
  local newest="" newest_m=-1 f m
  for f in "$@"; do
    m=$(stat -c %Y -- "$f" 2>/dev/null) || continue
    if [ "$m" -gt "$newest_m" ]; then
      newest=$f
      newest_m=$m
    fi
  done
  printf '%s' "$newest"
}

mkdir -p "$BACKUP_DIR"
TS=$(date +%Y%m%d_%H%M%S)
OUT="$BACKUP_DIR/ftm_${TS}.dump"
TMP="$OUT.partial"
# 任何退出路径都清掉半截文件；成功时它已被改名，这里是空操作
trap 'rm -f -- "$TMP"' EXIT

# ── 0) 空间预检 ──
shopt -s nullglob
existing=("$BACKUP_DIR"/ftm_*.dump "$BACKUP_DIR"/ftm_*.sql.gz)
shopt -u nullglob
need_kb=$((MIN_FREE_MB * 1024))
if [ ${#existing[@]} -gt 0 ]; then
  last=$(newest_of "${existing[@]}")
  if [ -n "$last" ]; then
    last_kb=$(($(stat -c %s -- "$last") / 1024))
    if [ $((last_kb * 2)) -gt "$need_kb" ]; then
      need_kb=$((last_kb * 2))
    fi
  fi
fi
avail_kb=$(df -Pk "$BACKUP_DIR" | awk 'NR == 2 { print $4 }')
if [ "$avail_kb" -lt "$need_kb" ]; then
  fail "磁盘剩余 $((avail_kb / 1024))MB，不足 $((need_kb / 1024))MB（上一份的 2 倍，且不少于 ${MIN_FREE_MB}MB），本次不导出；先清盘（docker 构建缓存 / 旧的手工快照）"
fi

# ── 1) 导出：走容器内本地 socket（trust 认证，无需密码）──
log "开始导出 $CONTAINER/$DB_NAME → $OUT"
if ! docker exec "$CONTAINER" pg_dump -U "$DB_USER" -d "$DB_NAME" -Fc >"$TMP"; then
  fail "pg_dump 退出非 0（容器 $CONTAINER）"
fi
[ -s "$TMP" ] || fail "导出为空"

# ── 2) 校验：读目录 + 整份通读（pg_restore 用容器里那份，宿主机不必装客户端）──
if ! toc=$(docker exec -i "$CONTAINER" pg_restore --list <"$TMP"); then
  fail "pg_restore --list 读不出目录，快照损坏"
fi
data_entries=$(printf '%s\n' "$toc" | grep -c ' TABLE DATA ' || true)
[ "$data_entries" -gt 0 ] || fail "目录里没有任何表数据（TABLE DATA 0 项）"
if ! docker exec -i "$CONTAINER" pg_restore -f /dev/null <"$TMP"; then
  fail "整份通读失败（文件截断或数据块损坏）"
fi

# ── 3) 转正 ──
mv -f -- "$TMP" "$OUT"
log "ok: $OUT（$(du -h "$OUT" | cut -f1)，表数据 $data_entries 项，用时 ${SECONDS}s）"

# ── 4) 清理过期快照（两种格式）+ 异常中断留下的半截文件 ──
find "$BACKUP_DIR" -maxdepth 1 -type f \( -name 'ftm_*.dump' -o -name 'ftm_*.sql.gz' \) \
  -mtime +"$RETAIN_DAYS" -print -delete | sed 's/^/  清理过期: /'
find "$BACKUP_DIR" -maxdepth 1 -type f -name 'ftm_*.partial' -mmin +720 -print -delete |
  sed 's/^/  清理残留: /'

shopt -s nullglob
kept=("$BACKUP_DIR"/ftm_*.dump "$BACKUP_DIR"/ftm_*.sql.gz)
shopt -u nullglob
log "现存快照 ${#kept[@]} 份，共 $(du -ch -- "${kept[@]}" | tail -1 | cut -f1)"

# ── 安装定时任务（一次性，手动跑）──
#   ( crontab -l 2>/dev/null; echo "30 3 * * * bash /opt/ftm/infra/staging/backup-db.sh >> /opt/ftm/backups/backup.log 2>&1" ) | crontab -
#
# ── 恢复到有数据的库（会覆盖现有数据，谨慎；完整步骤见 docs/运维-监控与备份.md）──
#   0) 先挂维护标记，免得看门狗把停掉的 backend 又拉起来：touch /opt/ftm/.watchdog.pause
#   1) 停应用：cd /opt/ftm && docker compose -p ftm -f docker-compose.prod.yml --env-file .env.prod stop backend worker
#   2) 恢复（单事务：中途出错整体回滚，库保持恢复前原样）：
#      docker exec -i ftm-postgres-prod pg_restore --clean --if-exists --no-owner --single-transaction \
#        -U ftm -d ftm < /opt/ftm/backups/ftm_YYYYMMDD_HHMMSS.dump
#   3) 起应用：docker compose -p ftm -f docker-compose.prod.yml --env-file .env.prod start backend worker
#   4) 摘维护标记：rm -f /opt/ftm/.watchdog.pause
#   旧格式 .sql.gz 是纯 SQL，只能灌进清空后的库，做法见文档。

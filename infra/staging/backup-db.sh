#!/usr/bin/env bash
# 每日备份 Postgres（ftm 库）→ 压缩快照，保留最近 14 天。
#
# ⚠️ 仅存本机 /opt/ftm/backups：
#    - 挡得住：误删、跑错迁移、容器重建、`docker compose down`（不带 -v）
#    - 挡不住：整机丢失 / 磁盘坏 / 阿里云到期释放 / `down -v`（连卷删）
#    真实订单上线前，请升级为异地备份（scp 拉到本地 / 传阿里云 OSS）。
#
# 用法：bash /opt/ftm/infra/staging/backup-db.sh
# 定时：crontab 每天 03:30 跑一次（见文件末尾安装说明）。
set -euo pipefail

BACKUP_DIR=/opt/ftm/backups
RETAIN_DAYS=14
CONTAINER=ftm-postgres-prod

mkdir -p "$BACKUP_DIR"
TS=$(date +%Y%m%d_%H%M%S)
OUT="$BACKUP_DIR/ftm_${TS}.sql.gz"

# pg_dump 走容器内本地 socket（trust 认证，无需密码）
docker exec "$CONTAINER" pg_dump -U ftm -d ftm | gzip > "$OUT"

# 空文件视为失败（不能恢复的备份 = 没备份）
if [ ! -s "$OUT" ]; then
  echo "[backup] FAILED: 空快照，已删除" >&2
  rm -f "$OUT"
  exit 1
fi
echo "[backup] ok: $OUT ($(du -h "$OUT" | cut -f1))"

# 清理过期快照
find "$BACKUP_DIR" -name 'ftm_*.sql.gz' -mtime +"$RETAIN_DAYS" -delete
echo "[backup] 现存快照: $(ls -1 "$BACKUP_DIR"/ftm_*.sql.gz 2>/dev/null | wc -l) 份"

# ── 安装定时任务（一次性，手动跑）──
#   ( crontab -l 2>/dev/null; echo "30 3 * * * bash /opt/ftm/infra/staging/backup-db.sh >> /opt/ftm/backups/backup.log 2>&1" ) | crontab -
#
# ── 恢复（把某份快照灌回去；会覆盖现有数据，谨慎）──
#   gunzip -c /opt/ftm/backups/ftm_YYYYMMDD_HHMMSS.sql.gz | docker exec -i ftm-postgres-prod psql -U ftm -d ftm

#!/usr/bin/env bash
# 每日备份图片 blob（护照照片 / 收款凭证的字节）→ /opt/ftm/backups/blobs。
#
# 背景：图片出库后库里只剩 blob:sha256 引用，字节在 docker 命名卷 ftm_blob_data 里；
# pg_dump 不再包含照片，**库备份 + 这份 blob 备份才是一套完整备份**，缺一不可。
#
# 口径：
#   - rsync -a 增量：内容寻址（文件名 = 内容 sha256），已备份过的文件永远不会变，每天只多拷新增的。
#   - **不带 --delete**：blob 永不删除，备份目录也只增不减；就算线上误删了卷，这里还留着。
#   - 排除写到一半的临时文件（*.tmp）和启动自检探针（.probe.*）。
#   - 与 backup-db.sh 一样只存本机；异地（OSS / 拉回本地）另行安排。
#
# 用法：bash /opt/ftm/infra/staging/backup-blobs.sh
# 定时：crontab 每天 03:40（排在 03:30 的 backup-db.sh 之后），见文件末尾安装说明。
set -euo pipefail

VOLUME=${VOLUME:-ftm_blob_data}
BACKUP_DIR=${BACKUP_DIR:-/opt/ftm/backups/blobs}

SRC=$(docker volume inspect -f '{{.Mountpoint}}' "$VOLUME" 2>/dev/null) || {
  echo "[backup-blobs] FAILED: 卷 $VOLUME 不存在（backend 还没用带 blob_data 卷的 compose 起过？）" >&2
  exit 1
}

mkdir -p "$BACKUP_DIR"
rsync -a --exclude='*.tmp' --exclude='.probe.*' "$SRC/" "$BACKUP_DIR/"

echo "[backup-blobs] ok: $BACKUP_DIR · $(find "$BACKUP_DIR" -type f | wc -l) 个文件 · $(du -sh "$BACKUP_DIR" | cut -f1)"

# ── 安装定时任务（一次性，手动跑）──
#   ( crontab -l 2>/dev/null; echo "40 3 * * * bash /opt/ftm/infra/staging/backup-blobs.sh >> /opt/ftm/backups/backup-blobs.log 2>&1" ) | crontab -
#
# ── 恢复（把备份灌回卷；只增不删，不会覆盖掉卷里已有的同名文件——同名即同内容）──
#   rsync -a /opt/ftm/backups/blobs/ "$(docker volume inspect -f '{{.Mountpoint}}' ftm_blob_data)/"
#   chown -R 1001:1001 "$(docker volume inspect -f '{{.Mountpoint}}' ftm_blob_data)"   # 容器内运行用户 ftm = uid 1001

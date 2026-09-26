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
#   - 成功后在备份目录根部写 .last-success 标记（内容是本次汇总）：镜像里的文件保留原始修改时间，
#     看门狗拿它们判「新不新」会误报，所以按 watchdog.env.example 的口径只看这个标记的 mtime。
#     注册到看门狗：/opt/ftm/.watchdog.env 的 BACKUP_TARGETS 加一段
#       附件|/opt/ftm/backups/blobs|.last-success|26|0
#   - 与 backup-db.sh 一样只存本机；异地（OSS / 拉回本地）另行安排。
#
# 用法：bash /opt/ftm/infra/staging/backup-blobs.sh
# 定时：crontab 每天 03:40（排在 03:30 的 backup-db.sh 之后），见文件末尾安装说明。
set -euo pipefail

VOLUME=${VOLUME:-ftm_blob_data}
BACKUP_DIR=${BACKUP_DIR:-/opt/ftm/backups/blobs}

log() { echo "$(date '+%F %T') [backup-blobs] $*"; }

SRC=$(docker volume inspect -f '{{.Mountpoint}}' "$VOLUME" 2>/dev/null) || {
  log "FAILED: 卷 $VOLUME 不存在（backend 还没用带 blob_data 卷的 compose 起过？）" >&2
  exit 1
}

mkdir -p "$BACKUP_DIR"
# 先数卷里的：rsync 期间还可能有新上传落盘，rsync 之后再数会出现「备份 < 卷里」的假失败
src_count=$(find "$SRC" -type f ! -name '*.tmp' ! -name '.probe.*' | wc -l)
if ! rsync -a --exclude='*.tmp' --exclude='.probe.*' --exclude='.last-success' "$SRC/" "$BACKUP_DIR/"; then
  log "FAILED: rsync 退出非 0，未写 .last-success（看门狗第二天会因标记过旧报警）" >&2
  exit 1
fi

# 只增不删：备份里的文件数只会 ≥ rsync 开始前卷里的；反过来说明拷漏了
dst_count=$(find "$BACKUP_DIR" -type f ! -name '.last-success' | wc -l)
if [ "$dst_count" -lt "$src_count" ]; then
  log "FAILED: 备份 $dst_count 个文件 < 卷里 $src_count 个，未写 .last-success" >&2
  exit 1
fi

summary="ok: $(date '+%F %T') · $BACKUP_DIR · $dst_count 个文件（卷里 $src_count）· $(du -sh "$BACKUP_DIR" | cut -f1)"
printf '%s\n' "$summary" >"$BACKUP_DIR/.last-success.partial"
mv -f "$BACKUP_DIR/.last-success.partial" "$BACKUP_DIR/.last-success"
log "$summary"

# ── 安装定时任务（一次性，手动跑）──
#   ( crontab -l 2>/dev/null; echo "40 3 * * * bash /opt/ftm/infra/staging/backup-blobs.sh >> /opt/ftm/backups/backup-blobs.log 2>&1" ) | crontab -
#
# ── 注册到看门狗（一次性，手动改 /opt/ftm/.watchdog.env）──
#   BACKUP_TARGETS='数据库|/opt/ftm/backups|ftm_*.dump,ftm_*.sql.gz|26|50;附件|/opt/ftm/backups/blobs|.last-success|26|0'
#
# ── 恢复（把备份灌回卷；只增不删，不会覆盖掉卷里已有的同名文件——同名即同内容）──
#   rsync -a /opt/ftm/backups/blobs/ "$(docker volume inspect -f '{{.Mountpoint}}' ftm_blob_data)/"
#   chown -R 1001:1001 "$(docker volume inspect -f '{{.Mountpoint}}' ftm_blob_data)"   # 容器内运行用户 ftm = uid 1001

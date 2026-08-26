#!/usr/bin/env bash
# 异地备份：把服务器上的每日 Postgres 快照拉回本机（Mac）。
#
# 服务器侧 cron 每天 03:30 生成 /opt/ftm/backups/ftm_*.sql.gz（保留 14 天）；
# 本脚本由 launchd 每天在本机跑一次（睡眠错过会在唤醒后补跑），rsync 增量拉取，
# 本地保留 30 天。挡住「整机丢失/磁盘坏/阿里云到期释放」这一类服务器侧灾难。
#
# 安装（一次性）：
#   cp infra/local/com.ftm.backup-pull.plist ~/Library/LaunchAgents/
#   launchctl load ~/Library/LaunchAgents/com.ftm.backup-pull.plist
# 手动跑：bash infra/local/pull-backups.sh
set -euo pipefail

REMOTE="root@47.83.249.163"
SSH_KEY="$HOME/.ssh/ftm_staging"
REMOTE_DIR="/opt/ftm/backups"
LOCAL_DIR="$HOME/FTM-Backups"
RETAIN_DAYS=30

mkdir -p "$LOCAL_DIR"

rsync -az --timeout=120 -e "ssh -i $SSH_KEY -o BatchMode=yes" \
  "$REMOTE:$REMOTE_DIR/ftm_*.sql.gz" "$LOCAL_DIR/"

# 最新一份做完整性校验（gzip 能整读 = 没截断；解不开的备份 = 没备份）
LATEST=$(ls -1t "$LOCAL_DIR"/ftm_*.sql.gz 2>/dev/null | head -1)
if [ -z "$LATEST" ] || ! gunzip -t "$LATEST" 2>/dev/null; then
  echo "[backup-pull] FAILED: 最新快照缺失或损坏: ${LATEST:-无}" >&2
  exit 1
fi

find "$LOCAL_DIR" -name 'ftm_*.sql.gz' -mtime +"$RETAIN_DAYS" -delete
echo "[backup-pull] ok: $(basename "$LATEST") ($(du -h "$LATEST" | cut -f1))，本地共 $(ls -1 "$LOCAL_DIR"/ftm_*.sql.gz | wc -l | tr -d ' ') 份"

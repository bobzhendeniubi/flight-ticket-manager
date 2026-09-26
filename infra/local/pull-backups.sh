#!/usr/bin/env bash
# 异地备份：把服务器上最新一份 Postgres 快照拉回本机（Mac）。
#
# 服务器侧 cron 每天 03:30 生成快照（/opt/ftm/backups，纯 SQL 的 .sql.gz 或 pg_dump -Fc 的 .dump，
# 保留 14 天）；本脚本由 launchd 每天跑一次（睡眠错过会在唤醒后补跑），只拉最新一份（断点续传），
# 本地保留 30 天。挡住「整机丢失/磁盘坏/阿里云到期释放」这一类服务器侧灾难。
#
# ⚠️ 别让 launchd 直接执行仓库里的这份：仓库在 ~/Documents 下，macOS 隐私保护（TCC）会拒绝
#    launchd 拉起的 bash 读取它——2026-08-26 起每天报 Operation not permitted，异地备份断了一个月
#    都没人发现。用 install-backup-pull.sh 安装：把脚本拷到 ~/.ftm/bin/ 并生成指向它的 launchd 配置。
#    改了本脚本要重跑一次 install-backup-pull.sh 才生效。
#
# 手动跑：bash infra/local/pull-backups.sh
set -euo pipefail

# launchd 的 PATH 只有系统目录，pg_restore 在 Homebrew 下
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

REMOTE="root@47.83.249.163"
SSH_KEY="$HOME/.ssh/ftm_staging"
REMOTE_DIR="/opt/ftm/backups"
LOCAL_DIR="$HOME/FTM-Backups"
RETAIN_DAYS=30

# 限速（KB/s）：服务器出口带宽白天要留给同事用，北京时间夜里（0-8 点）放开。
# 实测服务器 → 本机约 2-3.5MB/s；1.2GB 的快照夜里约 7 分钟，白天约 40 分钟。
DAY_BWLIMIT_KBPS=500
NIGHT_BWLIMIT_KBPS=3000
BJT_HOUR=$(TZ=Asia/Shanghai date +%H)
if [ "${BJT_HOUR#0}" -lt 8 ]; then BWLIMIT=$NIGHT_BWLIMIT_KBPS; else BWLIMIT=$DAY_BWLIMIT_KBPS; fi

notify_fail() {
  echo "[backup-pull] $(date '+%F %T') FAILED: $1" >&2
  # launchd 任务跑在用户会话里，能弹系统通知——静默失败正是上次断一个月的原因
  osascript -e "display notification \"$1\" with title \"FTM 异地备份失败\"" >/dev/null 2>&1 || true
}
trap 'notify_fail "脚本异常退出（第 $LINENO 行）"' ERR

mkdir -p "$LOCAL_DIR"
# LogLevel=ERROR：压掉服务器不支持后量子密钥交换的告警，免得每天刷满日志
SSH_CMD="ssh -i $SSH_KEY -o BatchMode=yes -o ConnectTimeout=20 -o LogLevel=ERROR"

LATEST_REMOTE=$($SSH_CMD "$REMOTE" \
  "ls -1t $REMOTE_DIR/ftm_*.dump $REMOTE_DIR/ftm_*.sql.gz 2>/dev/null | head -1")
if [ -z "$LATEST_REMOTE" ]; then
  notify_fail "服务器上没找到快照"
  exit 1
fi

echo "[backup-pull] $(date '+%F %T') 拉取 $(basename "$LATEST_REMOTE")（限速 ${BWLIMIT}KB/s）"
rsync -a --partial --timeout=300 --bwlimit="$BWLIMIT" -e "$SSH_CMD" \
  "$REMOTE:$LATEST_REMOTE" "$LOCAL_DIR/"

# 完整性校验：解不开的备份 = 没备份。
# .dump 光 pg_restore --list 不够（截掉 40% 的文件照样列得出目录），要像服务器端备份脚本一样
# 再整份读一遍输出到 /dev/null；-f 只生成 SQL、不连数据库，本机角色权限不影响。
verify_snapshot() {
  case "$1" in
    *.sql.gz) gunzip -t "$1" ;;
    *.dump)   pg_restore --list "$1" >/dev/null && pg_restore -f /dev/null "$1" ;;
    *)        return 1 ;;
  esac
}
LOCAL_FILE="$LOCAL_DIR/$(basename "$LATEST_REMOTE")"
if ! verify_snapshot "$LOCAL_FILE" >/dev/null 2>&1; then
  notify_fail "快照损坏或不完整：$(basename "$LOCAL_FILE")"
  exit 1
fi

# ── 附件（护照照片 / 收款凭证的字节）────────────────────────────────────────────
# 照片出库后库快照里只剩 blob 引用，字节在服务器 /opt/ftm/backups/blobs（backup-blobs.sh 每天镜像）：
# 库快照 + 附件镜像才是一套完整备份。内容寻址、只增不删 → 增量拉、不带 --delete，本地也永不删。
# 服务器上还没有附件备份（照片出库未上线）就跳过，不算失败。
REMOTE_BLOB_DIR="$REMOTE_DIR/blobs"
LOCAL_BLOB_DIR="$LOCAL_DIR/blobs"
BLOB_VERIFY_SAMPLE=20
if $SSH_CMD "$REMOTE" "test -f $REMOTE_BLOB_DIR/.last-success"; then
  mkdir -p "$LOCAL_BLOB_DIR"
  rsync -a --partial --timeout=300 --bwlimit="$BWLIMIT" --exclude='*.tmp' --exclude='.probe.*' \
    -e "$SSH_CMD" "$REMOTE:$REMOTE_BLOB_DIR/" "$LOCAL_BLOB_DIR/"
  remote_count=$($SSH_CMD "$REMOTE" "find $REMOTE_BLOB_DIR -type f ! -name '.*' | wc -l" | tr -d ' ')
  local_count=$(find "$LOCAL_BLOB_DIR" -type f ! -name '.*' | wc -l | tr -d ' ')
  if [ "$local_count" -lt "$remote_count" ]; then
    notify_fail "附件没拉全：本地 $local_count 个 < 服务器 $remote_count 个"
    exit 1
  fi
  # 文件名就是内容的 sha256：抽样重算，对不上 = 拉坏了
  bad=0
  while IFS= read -r f; do
    [ "$(shasum -a 256 "$f" | cut -d' ' -f1)" = "$(basename "$f")" ] || bad=$((bad + 1))
  done < <(find "$LOCAL_BLOB_DIR" -type f ! -name '.*' | sort -R | head -n "$BLOB_VERIFY_SAMPLE")
  if [ "$bad" -gt 0 ]; then
    notify_fail "附件抽样校验有 $bad 个文件内容与哈希不符"
    exit 1
  fi
  echo "[backup-pull] $(date '+%F %T') 附件 ok: $local_count 个文件（服务器 $remote_count）$(du -sh "$LOCAL_BLOB_DIR" | cut -f1)"
else
  echo "[backup-pull] $(date '+%F %T') 服务器还没有附件备份（照片出库未上线），跳过"
fi

find "$LOCAL_DIR" \( -name 'ftm_*.sql.gz' -o -name 'ftm_*.dump' \) -mtime +"$RETAIN_DAYS" -delete
COUNT=$(find "$LOCAL_DIR" \( -name 'ftm_*.sql.gz' -o -name 'ftm_*.dump' \) | wc -l | tr -d ' ')
echo "[backup-pull] $(date '+%F %T') ok: $(basename "$LOCAL_FILE") ($(du -h "$LOCAL_FILE" | cut -f1))，本地共 $COUNT 份"

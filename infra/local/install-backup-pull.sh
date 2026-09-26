#!/usr/bin/env bash
# 安装 / 更新本机异地备份拉取任务（launchd）。改了 pull-backups.sh 后重跑本脚本才生效。
#
# 为什么不直接让 launchd 跑仓库里的脚本：仓库在 ~/Documents 下，受 macOS 隐私保护（TCC），
# launchd 拉起的 bash 读不了（Operation not permitted，2026-08-26 起断了一个月）。
# 这里把脚本拷到 ~/.ftm/bin/，日志写 ~/Library/Logs/（/tmp 重启即清，出了事没处查）。
#
# 用法：bash infra/local/install-backup-pull.sh          安装并注册（按计划时间跑）
#       bash infra/local/install-backup-pull.sh --run    安装后立即触发一次
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
LABEL="com.ftm.backup-pull"
BIN_DIR="$HOME/.ftm/bin"
LOG_FILE="$HOME/Library/Logs/ftm-backup-pull.log"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"

mkdir -p "$BIN_DIR" "$(dirname "$LOG_FILE")" "$(dirname "$PLIST")"
install -m 0755 "$HERE/pull-backups.sh" "$BIN_DIR/pull-backups.sh"
sed -e "s#__SCRIPT__#$BIN_DIR/pull-backups.sh#" -e "s#__LOG_FILE__#$LOG_FILE#g" \
  "$HERE/$LABEL.plist" > "$PLIST"
plutil -lint "$PLIST" >/dev/null

# 重新注册：先卸掉旧的（包括老版本用 launchctl load 装的），再装新的
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
launchctl bootstrap "$DOMAIN" "$PLIST"
echo "✓ 已安装 $BIN_DIR/pull-backups.sh（日志 $LOG_FILE）"

if [ "${1:-}" = "--run" ]; then
  launchctl kickstart "$DOMAIN/$LABEL"
  echo "▶ 已触发一次，看进度：tail -f $LOG_FILE"
fi

#!/usr/bin/env bash
# 服务看门狗：每 5 分钟探一次两套环境的 /healthz。
# 连续失败 → ①记日志 ②尝试自愈（重启对应 backend 容器）③若配置了 WEBHOOK_URL 则推告警。
#
# 通知渠道（可选）：在 /opt/ftm/.watchdog.env 里配 WEBHOOK_URL=<企业微信机器人/钉钉/Slack webhook>，
# 不配也能跑（只自愈+记日志）。日志：/opt/ftm/backups/watchdog.log
#
# 安装（一次性）：
#   ( crontab -l 2>/dev/null; echo "*/5 * * * * bash /opt/ftm/infra/staging/watchdog.sh >> /opt/ftm/backups/watchdog.log 2>&1" ) | crontab -
set -uo pipefail

[ -f /opt/ftm/.watchdog.env ] && . /opt/ftm/.watchdog.env
WEBHOOK_URL="${WEBHOOK_URL:-}"

notify() {
  local msg="$1"
  echo "$(date '+%F %T') $msg"
  if [ -n "$WEBHOOK_URL" ]; then
    curl -s -m 10 -X POST "$WEBHOOK_URL" -H 'Content-Type: application/json' \
      -d "{\"msgtype\":\"text\",\"text\":{\"content\":\"[FTM看门狗] $msg\"}}" >/dev/null || true
  fi
}

check() {
  local name="$1" url="$2" container="$3"
  # 两次探测各 10s 超时，间隔 15s——单次网络抖动不触发
  if curl -sf -m 10 "$url" >/dev/null; then return 0; fi
  sleep 15
  if curl -sf -m 10 "$url" >/dev/null; then return 0; fi

  notify "$name 健康检查失败（$url），尝试重启 $container"
  docker restart "$container" >/dev/null 2>&1
  sleep 30
  if curl -sf -m 10 "$url" >/dev/null; then
    notify "$name 重启后已恢复"
  else
    notify "$name 重启后仍不可用——需要人工介入！"
  fi
}

check "实测" "https://api.citurtravel.com/healthz" "ftm-backend-prod"
check "测试" "https://test-api.citurtravel.com/healthz" "ftm-backend-staging"

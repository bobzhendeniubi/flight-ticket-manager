#!/usr/bin/env bash
# 服务看门狗（cron 每 5 分钟跑一次）：
#   ① 探两套环境 /healthz：连续两次失败 → 重启对应 backend 自愈 → 仍不行就告警
#   ② 磁盘：/ 与 docker 根目录，≥80% 警告、≥90% 严重
#   ③ 备份新鲜度：最新一份 < 26 小时，且不小于上一份的 50%（.dump / .sql.gz 都认；目标可配多个）
#   ④ 容器：unhealthy / 没在运行 / 反复重启；docker 守护进程本身无响应
#
# 告警去重（状态文件 $STATE_DIR/state）：新出现立即推；条件持续时每 ALERT_REPEAT_HOURS（默认 6）
# 小时最多再推一次；恢复时推一次「恢复」；警告升到严重立即推。同一轮的多条合成一条推送，
# 推送失败的内容下一轮补发。
#
# 配置：/opt/ftm/.watchdog.env（模板 infra/staging/watchdog.env.example）。没配 WEBHOOK_URL 也照跑
# （自愈 + 记日志），每天在日志里提示一次「未配置推送」。
# 维护：touch /opt/ftm/.watchdog.pause 暂停探活 / 自愈 / 容器检查（恢复库、重建容器时用；磁盘和
#       备份照查）。挂超过 WATCHDOG_PAUSE_MAX_MINUTES（默认 120）分钟自动失效并告警，防止忘了摘。
# 验证：WATCHDOG_DRY_RUN=1 bash watchdog.sh —— 照常检查并打印每项结果，不重启、不推送；
#       状态记在单独的 state.dry-run，不影响正式那份。
#       WATCHDOG_TEST_PUSH=1 bash watchdog.sh —— 只往群里推一条测试消息，确认机器人配对了。
#
# 日志：cron 把输出追加到 /opt/ftm/backups/watchdog.log；一切正常时不写。
# 安装（一次性）：
#   ( crontab -l 2>/dev/null; echo "*/5 * * * * bash /opt/ftm/infra/staging/watchdog.sh >> /opt/ftm/backups/watchdog.log 2>&1" ) | crontab -
set -uo pipefail

WATCHDOG_ENV_FILE="${WATCHDOG_ENV_FILE:-/opt/ftm/.watchdog.env}"
# shellcheck source=/dev/null
[ -f "$WATCHDOG_ENV_FILE" ] && . "$WATCHDOG_ENV_FILE"

WEBHOOK_URL="${WEBHOOK_URL:-}"
WEBHOOK_KIND="${WEBHOOK_KIND:-wecom}" # wecom（企业微信）| dingtalk（钉钉）
DINGTALK_SECRET="${DINGTALK_SECRET:-}" # 钉钉安全设置选「加签」时填
DRY_RUN="${WATCHDOG_DRY_RUN:-0}"
STATE_DIR="${WATCHDOG_STATE_DIR:-/var/lib/ftm-watchdog}"
PAUSE_FILE="${WATCHDOG_PAUSE_FILE:-/opt/ftm/.watchdog.pause}"
PAUSE_MAX_MINUTES="${WATCHDOG_PAUSE_MAX_MINUTES:-120}"
REPEAT_SECONDS=$((${ALERT_REPEAT_HOURS:-6} * 3600))

# ① 探活目标：名称|URL|自愈时重启的容器，多个用分号隔开
HEALTH_TARGETS="${HEALTH_TARGETS:-实测|https://api.citurtravel.com/healthz|ftm-backend-prod;测试|https://test-api.citurtravel.com/healthz|ftm-backend-staging}"
HEALTH_RETRY_SECONDS="${HEALTH_RETRY_SECONDS:-15}"
HEALTH_RESTART_WAIT_SECONDS="${HEALTH_RESTART_WAIT_SECONDS:-30}"
# ② 磁盘：要看的路径（docker 根目录自动追加，同一个分区只报一次）
DISK_PATHS="${DISK_PATHS:-/}"
DISK_WARN_PCT="${DISK_WARN_PCT:-80}"
DISK_CRIT_PCT="${DISK_CRIT_PCT:-90}"
# ③ 备份目标：名称|目录|文件名匹配（多个用逗号）|最长间隔小时|最小体积比例%（0 = 不比体积），多个用分号
BACKUP_TARGETS="${BACKUP_TARGETS:-数据库|/opt/ftm/backups|ftm_*.dump,ftm_*.sql.gz|26|50}"
BACKUP_SETTLE_SECONDS="${BACKUP_SETTLE_SECONDS:-120}" # 这么久内还在变的文件当作正在写，不算
# ④ 容器：名字以 -staging 结尾的按「警告」报，其余按「严重」
WATCH_CONTAINERS="${WATCH_CONTAINERS:-ftm-postgres-prod ftm-redis-prod ftm-backend-prod ftm-worker-prod ftm-admin-web-prod ftm-sales-web-prod ftm-postgres-staging ftm-redis-staging ftm-backend-staging ftm-worker-staging ftm-admin-web-staging ftm-sales-web-staging}"
RESTART_WINDOW_MINUTES="${RESTART_WINDOW_MINUTES:-60}"
RESTART_ALERT_COUNT="${RESTART_ALERT_COUNT:-3}"
CONTAINER_RECHECK_SECONDS="${CONTAINER_RECHECK_SECONDS:-20}"
DOCKER_TIMEOUT_SECONDS="${DOCKER_TIMEOUT_SECONDS:-20}"

NOW=$(date +%s)
declare -A STATE=()
QUEUE=()
DOCKER_ROOT=""

log() { echo "$(date '+%F %T') $*"; }
# dry-run 时把每项检查结果也打出来，平时静默
vlog() { if [ "$DRY_RUN" = 1 ]; then log "$@"; fi; }

dk() {
  if command -v timeout >/dev/null 2>&1; then
    timeout "$DOCKER_TIMEOUT_SECONDS" docker "$@"
  else
    docker "$@"
  fi
}

human_duration() {
  local s=$1
  if [ "$s" -ge 86400 ]; then
    echo "$((s / 86400)) 天 $((s % 86400 / 3600)) 小时"
  elif [ "$s" -ge 3600 ]; then
    echo "$((s / 3600)) 小时 $((s % 3600 / 60)) 分"
  else
    echo "$((s / 60)) 分钟"
  fi
}

human_size() {
  awk -v b="$1" 'BEGIN {
    split("B K M G T", u, " "); i = 1
    while (b >= 1024 && i < 5) { b /= 1024; i++ }
    fmt = (i == 1) ? "%d%s" : "%.1f%s"; printf fmt, b, u[i]
  }'
}

# ───────────────────────── 状态文件（告警去重）─────────────────────────
setup_state() {
  if ! mkdir -p "$STATE_DIR" 2>/dev/null; then
    log "状态目录 $STATE_DIR 建不了，改用 /tmp/ftm-watchdog"
    STATE_DIR=/tmp/ftm-watchdog
    mkdir -p "$STATE_DIR"
  fi
  STATE_FILE="$STATE_DIR/state"
  [ "$DRY_RUN" = 1 ] && STATE_FILE="$STATE_DIR/state.dry-run"
  OUTBOX_FILE="$STATE_FILE.outbox"
  # 上一轮卡住没跑完（比如 docker 半死）就跳过，免得两轮同时改状态文件
  exec 9>"$STATE_FILE.lock"
  if command -v flock >/dev/null 2>&1 && ! flock -n 9; then
    log "上一轮看门狗还没跑完，本轮跳过"
    exit 0
  fi
  if [ -f "$STATE_FILE" ]; then
    local k v
    while IFS=$'\t' read -r k v; do
      [ -n "$k" ] && STATE["$k"]=$v
    done <"$STATE_FILE"
  fi
}

save_state() {
  local tmp="$STATE_FILE.tmp.$$" k
  if { for k in "${!STATE[@]}"; do printf '%s\t%s\n' "$k" "${STATE[$k]}"; done; } >"$tmp" 2>/dev/null &&
    mv -f "$tmp" "$STATE_FILE" 2>/dev/null; then
    return 0
  fi
  rm -f "$tmp"
  log "状态文件 $STATE_FILE 写不进去（盘满？），本轮告警去重记录没保存"
}

level_rank() {
  case "$1" in
    严重) echo 2 ;;
    警告) echo 1 ;;
    *) echo 0 ;;
  esac
}

notify() {
  log "$1"
  QUEUE+=("$1")
}

# 持续性告警：id 级别 消息。状态 = 「firing 级别 开始时间 上次推送时间」
raise_alert() {
  local id=$1 level=$2 msg=$3 key="alert.$1" st lv since last
  read -r st lv since last <<<"${STATE[$key]:-ok - 0 0}"
  if [ "$st" != firing ]; then
    notify "【$level】$msg"
    STATE[$key]="firing $level $NOW $NOW"
  elif [ "$(level_rank "$level")" -gt "$(level_rank "$lv")" ]; then
    notify "【$level·升级】$msg"
    STATE[$key]="firing $level $since $NOW"
  elif [ $((NOW - last)) -ge "$REPEAT_SECONDS" ]; then
    notify "【$level·已持续 $(human_duration $((NOW - since)))】$msg"
    STATE[$key]="firing $level $since $NOW"
  else
    vlog "持续中（$(human_duration $((NOW - last))) 前推过，未到重复间隔）：$msg"
    STATE[$key]="firing $level $since $last"
  fi
}

# 恢复：id 消息。之前在告警才推「恢复」，否则什么都不做
clear_alert() {
  local key="alert.$1" st lv since last
  read -r st lv since last <<<"${STATE[$key]:-ok - 0 0}"
  if [ "$st" = firing ]; then
    notify "【恢复】$2（此前持续 $(human_duration $((NOW - since)))）"
  fi
  unset 'STATE[$key]'
}

# 一次性事件（如自愈重启成功）：同类在重复间隔内只推一次，其余计数，下次推送时带上
event_notify() {
  local key="event.$1" level=$2 msg=$3 last muted extra=""
  read -r last muted <<<"${STATE[$key]:-0 0}"
  if [ $((NOW - last)) -ge "$REPEAT_SECONDS" ]; then
    [ "$muted" -gt 0 ] && extra="（上次推送后另有 $muted 次同类事件，见日志）"
    notify "【$level】$msg$extra"
    STATE[$key]="$NOW 0"
  else
    log "同类事件 $(human_duration $((NOW - last))) 前推过，本次只记日志：$msg"
    STATE[$key]="$last $((muted + 1))"
  fi
}

# ───────────────────────── 推送 ─────────────────────────
json_escape() {
  local s=$1
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//$'\n'/\\n}
  s=${s//$'\r'/\\r}
  s=${s//$'\t'/\\t}
  printf '%s' "$s"
}

# 钉钉「加签」：HMAC-SHA256(timestamp\nsecret) → base64 → urlencode
dingtalk_sign_query() {
  local ts sign
  ts=$(($(date +%s) * 1000))
  sign=$(printf '%s\n%s' "$ts" "$DINGTALK_SECRET" |
    openssl dgst -sha256 -hmac "$DINGTALK_SECRET" -binary | base64 | tr -d '\n')
  sign=${sign//+/%2B}
  sign=${sign//\//%2F}
  sign=${sign//=/%3D}
  printf 'timestamp=%s&sign=%s' "$ts" "$sign"
}

send_webhook() {
  local content payload url=$WEBHOOK_URL resp
  content=$(json_escape "$1")
  case "$WEBHOOK_KIND" in
    dingtalk)
      payload="{\"msgtype\":\"text\",\"text\":{\"content\":\"$content\"},\"at\":{\"isAtAll\":false}}"
      [ -n "$DINGTALK_SECRET" ] && url="$url&$(dingtalk_sign_query)"
      ;;
    *)
      payload="{\"msgtype\":\"text\",\"text\":{\"content\":\"$content\"}}"
      ;;
  esac
  if ! resp=$(curl -sS -m 10 --retry 2 --retry-delay 3 -X POST "$url" \
    -H 'Content-Type: application/json' -d "$payload" 2>&1); then
    log "推送失败（网络）：$resp"
    return 1
  fi
  case "$resp" in
    *'"errcode":0,'* | *'"errcode":0}'*) return 0 ;;
  esac
  log "推送被机器人拒收：$resp"
  return 1
}

# 按整行截到 limit 字节以内（企业微信 text 上限 2048 字节），免得切坏中文
truncate_lines() {
  local text=$1 limit=$2 out="" line
  if [ "$(printf '%s' "$text" | wc -c)" -le "$limit" ]; then
    printf '%s' "$text"
    return
  fi
  while IFS= read -r line; do
    if [ "$(printf '%s\n%s' "$out" "$line" | wc -c)" -gt $((limit - 80)) ]; then
      out+=$'\n'"……其余见服务器 /opt/ftm/backups/watchdog.log"
      break
    fi
    if [ -z "$out" ]; then out=$line; else out+=$'\n'"$line"; fi
  done <<<"$text"
  printf '%s' "$out"
}

flush_notifications() {
  local lines="" pending="" body
  [ ${#QUEUE[@]} -gt 0 ] && lines=$(printf '%s\n' "${QUEUE[@]}")
  [ -s "$OUTBOX_FILE" ] && pending=$(cat "$OUTBOX_FILE")
  [ -z "$lines" ] && [ -z "$pending" ] && return 0

  # 推送里统一用北京时间（服务器时区不一定是东八区）
  body="[FTM看门狗] ${WATCHDOG_LABEL:-$(hostname)} $(TZ=CST-8 date '+%m-%d %H:%M')（北京时间）"
  [ -n "$lines" ] && body+=$'\n'"$lines"
  [ -n "$pending" ] && body+=$'\n'"—— 补发（之前推送失败）——"$'\n'"$pending"
  body=$(truncate_lines "$body" 2000)

  if [ "$DRY_RUN" = 1 ]; then
    log "[dry-run] 本应推送（未发出）："
    printf '%s\n' "$body"
    return 0
  fi
  [ -n "$WEBHOOK_URL" ] || return 0 # 已逐条写日志；「未配置推送」按天提示
  if send_webhook "$body"; then
    rm -f "$OUTBOX_FILE"
    return 0
  fi
  # 留最近 30 行下轮补发；webhook 长期坏掉也不会无限涨
  { [ -n "$pending" ] && printf '%s\n' "$pending"; [ -n "$lines" ] && printf '%s\n' "$lines"; } |
    tail -n 30 >"$OUTBOX_FILE.tmp" && mv -f "$OUTBOX_FILE.tmp" "$OUTBOX_FILE"
}

remind_missing_webhook() {
  [ -z "$WEBHOOK_URL" ] || return 0
  local today
  today=$(date +%F)
  [ "${STATE[nowebhook.date]:-}" = "$today" ] && return 0
  log "未配置推送：$WATCHDOG_ENV_FILE 里没有 WEBHOOK_URL，告警只写本日志，没人会收到（每天提示一次；模板 infra/staging/watchdog.env.example）"
  STATE[nowebhook.date]=$today
}

# ───────────────────────── 检查项 ─────────────────────────
# 维护标记在且没过期 → 返回 0（本轮跳过探活 / 自愈 / 容器检查）
maintenance_active() {
  if [ ! -e "$PAUSE_FILE" ]; then
    clear_alert pause "维护标记已摘除，探活和自愈照常"
    return 1
  fi
  local age_min=$(((NOW - $(stat -c %Y -- "$PAUSE_FILE")) / 60))
  if [ "$age_min" -lt "$PAUSE_MAX_MINUTES" ]; then
    log "维护中（$PAUSE_FILE 已挂 $age_min 分钟），本轮跳过探活 / 自愈 / 容器检查"
    return 0
  fi
  raise_alert pause 警告 "维护标记 $PAUSE_FILE 已挂 $age_min 分钟（超过 $PAUSE_MAX_MINUTES 分钟自动失效），探活和自愈已恢复；维护做完请删掉它"
  return 1
}

check_docker() {
  if DOCKER_ROOT=$(dk info --format '{{.DockerRootDir}}' 2>/dev/null) && [ -n "$DOCKER_ROOT" ]; then
    clear_alert docker "docker 守护进程恢复响应"
    return 0
  fi
  DOCKER_ROOT=""
  raise_alert docker 严重 "docker 守护进程无响应（docker info ${DOCKER_TIMEOUT_SECONDS} 秒内没返回），容器检查跳过"
  return 1
}

probe() { curl -sf -m 10 -o /dev/null "$1"; }

check_health_target() {
  local name=$1 url=$2 container=$3 id="health:$1"
  # 两次探测间隔一会儿，单次网络抖动不触发
  if probe "$url" || { sleep "$HEALTH_RETRY_SECONDS"; probe "$url"; }; then
    vlog "探活 $name 正常"
    clear_alert "$id" "$name 接口已恢复（$url）"
    return
  fi
  if [ "$DRY_RUN" = 1 ]; then
    raise_alert "$id" 严重 "$name 健康检查连续失败（$url）；[dry-run] 本应重启 $container，未执行"
    return
  fi
  log "$name 健康检查连续失败（$url），重启 $container"
  dk restart "$container" >/dev/null 2>&1 || log "docker restart $container 失败"
  sleep "$HEALTH_RESTART_WAIT_SECONDS"
  if probe "$url"; then
    event_notify "selfheal:$name" 警告 "$name 健康检查失败，已自动重启 $container，重启后恢复"
    clear_alert "$id" "$name 接口已恢复（$url）"
  else
    raise_alert "$id" 严重 "$name 健康检查失败，重启 $container 后仍不可用（$url），需要人工介入"
  fi
}

check_health() {
  local -a entries
  local entry name url container
  IFS=';' read -ra entries <<<"$HEALTH_TARGETS"
  for entry in "${entries[@]}"; do
    [ -n "$entry" ] || continue
    IFS='|' read -r name url container <<<"$entry"
    check_health_target "$name" "$url" "$container"
  done
}

check_disk() {
  local p line avail pct mount seen=" "
  for p in $DISK_PATHS $DOCKER_ROOT; do
    line=$(df -Ph -- "$p" 2>/dev/null | awk 'NR == 2')
    if [ -z "$line" ]; then
      log "磁盘检查：$p 不存在或 df 失败，跳过"
      continue
    fi
    read -r _ _ _ avail pct mount <<<"$line"
    case "$seen" in *" $mount "*) continue ;; esac
    seen+="$mount "
    pct=${pct%\%}
    if [ "$pct" -ge "$DISK_CRIT_PCT" ]; then
      raise_alert "disk:$mount" 严重 "磁盘 $mount 已用 ${pct}%（剩 $avail），写满 Postgres 会 PANIC：先 docker builder prune -f、清旧快照"
    elif [ "$pct" -ge "$DISK_WARN_PCT" ]; then
      raise_alert "disk:$mount" 警告 "磁盘 $mount 已用 ${pct}%（剩 $avail）"
    else
      vlog "磁盘 $mount 已用 ${pct}%（剩 $avail），正常"
      clear_alert "disk:$mount" "磁盘 $mount 回落到 ${pct}%（剩 $avail）"
    fi
  done
}

# 一个备份目标：「名称|目录|匹配,匹配|最长间隔小时|最小体积比例%」
# 新鲜度看全部匹配文件（刚写完的恰恰说明备份在按时跑）；体积比较只看写完超过 BACKUP_SETTLE_SECONDS
# 的文件，免得拿正在写的半截文件去比。附件目录只有一个每天重写的 .last-success：新鲜度若也跳过刚写的
# 文件，重写后那几分钟就会误报「找不到」。
check_backup_target() {
  local name dir patterns max_h min_pct pat f m s seen=" "
  local latest="" latest_m=0 latest_s=0
  local newest="" newest_m=0 newest_s=0 prev="" prev_m=0 prev_s=0
  local -a pats
  IFS='|' read -r name dir patterns max_h min_pct <<<"$1"
  IFS=',' read -ra pats <<<"$patterns"
  shopt -s nullglob
  for pat in "${pats[@]}"; do
    for f in "$dir"/$pat; do
      case "$seen" in *" $f "*) continue ;; esac
      seen+="$f "
      [ -f "$f" ] || continue
      m=$(stat -c %Y -- "$f") && s=$(stat -c %s -- "$f") || continue
      if [ "$m" -gt "$latest_m" ]; then
        latest=$f latest_m=$m latest_s=$s
      fi
      [ $((NOW - m)) -ge "$BACKUP_SETTLE_SECONDS" ] || continue
      if [ "$m" -gt "$newest_m" ]; then
        prev=$newest prev_m=$newest_m prev_s=$newest_s
        newest=$f newest_m=$m newest_s=$s
      elif [ "$m" -gt "$prev_m" ]; then
        prev=$f prev_m=$m prev_s=$s
      fi
    done
  done
  shopt -u nullglob

  if [ -z "$latest" ]; then
    raise_alert "backup-age:$name" 严重 "$name 备份：$dir 下找不到任何 $patterns"
    return
  fi
  local age=$((NOW - latest_m)) base
  base=$(basename "$latest")
  if [ "$age" -gt $((max_h * 3600)) ]; then
    raise_alert "backup-age:$name" 严重 "$name 备份已 $(human_duration "$age") 没更新（上限 $max_h 小时），最新一份 $base：查 backup.log 和 crontab"
  else
    vlog "$name 备份最新 $base（$(human_duration "$age") 前，$(human_size "$latest_s")），正常"
    clear_alert "backup-age:$name" "$name 备份恢复更新：$base"
  fi
  # 体积：写完已稳定的最新两份才比（只有一份刚写完时先不判）
  [ -n "$newest" ] || return
  if [ -n "$prev" ] && [ "${min_pct:-0}" -gt 0 ] && [ $((newest_s * 100)) -lt $((prev_s * min_pct)) ]; then
    raise_alert "backup-size:$name" 警告 "$name 备份最新一份 $(basename "$newest") 只有 $(human_size "$newest_s")，不到上一份 $(basename "$prev")（$(human_size "$prev_s")）的 ${min_pct}%：确认是不是导出不全"
  else
    clear_alert "backup-size:$name" "$name 备份体积恢复正常：$(basename "$newest") $(human_size "$newest_s")"
  fi
}

check_backups() {
  local -a entries
  local entry
  IFS=';' read -ra entries <<<"$BACKUP_TARGETS"
  for entry in "${entries[@]}"; do
    [ -n "$entry" ] && check_backup_target "$entry"
  done
}

inspect_container() {
  # 健康状态用 index 取：关了健康检查的容器（worker）State 里根本没有 Health 键，
  # 写成 .State.Health 模板会直接报错「map has no entry for key」→ 被当成「容器不存在」误报严重告警。
  dk inspect -f '{{.Id}}|{{.State.Status}}|{{.State.Restarting}}|{{.RestartCount}}|{{with index .State "Health"}}{{.Status}}{{end}}|{{.State.ExitCode}}' "$1" 2>/dev/null
}

# inspect 结果 → 问题描述（没问题输出空）
container_problem() {
  local cid status restarting count health code
  IFS='|' read -r cid status restarting count health code <<<"$1"
  if [ -z "$cid" ]; then
    echo "不存在"
  elif [ "$restarting" = true ]; then
    echo "正在反复重启（上次退出码 $code）"
  elif [ "$status" != running ]; then
    echo "没在运行（状态 $status，退出码 $code）"
  elif [ "$health" = unhealthy ]; then
    echo "健康检查 unhealthy"
  fi
}

container_level() {
  case "$1" in
    *-staging) echo 警告 ;;
    *) echo 严重 ;;
  esac
}

# RestartCount 滑动窗口：窗口内自动重启 ≥ RESTART_ALERT_COUNT 次就告警。
# 状态 = 「容器 ID 时间:次数 时间:次数 …」；容器重建（发版）后 ID 变了，从零算。
track_restarts() {
  local c=$1 key="restart.$1" cid status restarting count prev_id samples s kept="" oldest=""
  IFS='|' read -r cid status restarting count _ <<<"$2"
  if [ -z "$cid" ] || [ -z "$count" ]; then
    unset 'STATE[$key]'
    return
  fi
  read -r prev_id samples <<<"${STATE[$key]:-}"
  [ "$prev_id" = "$cid" ] || samples=""
  for s in $samples "$NOW:$count"; do
    [ $((NOW - ${s%%:*})) -le $((RESTART_WINDOW_MINUTES * 60)) ] || continue
    kept+="$s "
    [ -n "$oldest" ] || oldest=${s##*:}
  done
  STATE[$key]="$cid ${kept% }"
  local delta=$((count - oldest))
  if [ "$delta" -ge "$RESTART_ALERT_COUNT" ]; then
    raise_alert "restarts:$c" "$(container_level "$c")" "容器 $c 近 $RESTART_WINDOW_MINUTES 分钟自动重启 $delta 次（累计 $count）：docker logs --tail 100 $c"
  else
    clear_alert "restarts:$c" "容器 $c 不再反复重启"
  fi
}

check_containers() {
  local c info problem
  local -A bad=()
  for c in $WATCH_CONTAINERS; do
    info=$(inspect_container "$c")
    track_restarts "$c" "$info"
    problem=$(container_problem "$info")
    [ -n "$problem" ] && bad[$c]=$problem
  done
  # 发版重建 / 刚崩溃被自动拉起都有几秒的中间态，隔一会儿再看一眼，仍不对才算
  if [ ${#bad[@]} -gt 0 ] && [ "$CONTAINER_RECHECK_SECONDS" -gt 0 ]; then
    sleep "$CONTAINER_RECHECK_SECONDS"
    for c in "${!bad[@]}"; do
      problem=$(container_problem "$(inspect_container "$c")")
      if [ -n "$problem" ]; then bad[$c]=$problem; else unset 'bad[$c]'; fi
    done
  fi
  for c in $WATCH_CONTAINERS; do
    if [ -n "${bad[$c]:-}" ]; then
      raise_alert "container:$c" "$(container_level "$c")" "容器 $c ${bad[$c]}"
    else
      vlog "容器 $c 正常"
      clear_alert "container:$c" "容器 $c 恢复正常"
    fi
  done
}

# ───────────────────────── 主流程 ─────────────────────────
# 试推一条，确认推送通道配对了：WATCHDOG_TEST_PUSH=1 bash watchdog.sh（不做检查、不碰状态）
if [ "${WATCHDOG_TEST_PUSH:-0}" = 1 ]; then
  if [ -z "$WEBHOOK_URL" ]; then
    log "没配 WEBHOOK_URL（$WATCHDOG_ENV_FILE），没法试推"
    exit 1
  fi
  if send_webhook "[FTM看门狗] ${WATCHDOG_LABEL:-$(hostname)} 推送通道测试：收到这条说明看门狗的告警能送到这个群"; then
    log "试推成功"
    exit 0
  fi
  exit 1
fi

setup_state
[ "$DRY_RUN" = 1 ] && log "[dry-run] 只检查不动手：不重启、不推送，状态记在 $STATE_FILE"
remind_missing_webhook
docker_ok=0
check_docker && docker_ok=1
check_disk
check_backups
if ! maintenance_active; then
  check_health
  [ "$docker_ok" = 1 ] && check_containers
fi
flush_notifications
save_state
exit 0

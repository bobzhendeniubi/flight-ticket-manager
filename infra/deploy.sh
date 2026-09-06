#!/usr/bin/env bash
#
# 日常发版 —— 在服务器 47.83.249.163 上跑。
#
#   /opt/ftm/infra/deploy.sh prod            [服务...]   实测环境（同事日常在用，会二次确认）
#   /opt/ftm-staging/infra/deploy.sh staging [服务...]   测试环境（随便折腾）
#
# 不传服务名 = 重建 backend worker admin-web sales-web（不动 postgres/redis，数据不受影响）。
#
# 与 infra/staging/deploy.sh 的区别：那个是**首次开机**的 provisioning
# （装 docker/caddy/防火墙、clone、生成密钥、seed），跑一次就完事；这个是**每次发版**用的。
#
# 两套环境的差异只有三样，其余共用同一份 docker-compose.prod.yml：
#   目录            /opt/ftm      vs  /opt/ftm-staging
#   compose 项目名  ftm           vs  ftm-staging     ← 决定数据卷归属，串了两边数据就混了
#   env 文件        .env.prod     vs  .env.staging
#
# 镜像 tag：backend/worker/sales-web/admin-web 按 git short sha 打 tag（ftm-<svc>:<sha>），
# 部署完额外打一份 :latest。每次部署把 tag/commit 全 sha/耗时/结果追加写到
# <环境目录>/.deploy-history（tab 分隔，一行一条），供将来回滚和镜像清理读取。
# 只保留每环境最近 5 个 tag 的镜像，其余（含每次 build 产生的悬空 <none> 镜像）自动清理，
# 磁盘不会像以前那样越攒越大（2026-08-24 曾清出 38G）。
#
# DRY_RUN=1：只打印将执行的命令，不真的碰 git/docker/网络——本地演练分支逻辑用。
set -euo pipefail

DRY_RUN="${DRY_RUN:-0}"
KEEP_TAGS_COUNT=5
APP_SERVICES=(backend worker admin-web sales-web)

# ── 小工具 ────────────────────────────────────────────────────────────────

# 真正执行一条命令；DRY_RUN=1 时只打印（shell-quote 过，可直接复制运行）。
run() {
  if [ "$DRY_RUN" = "1" ]; then
    printf '[DRY_RUN] +'
    printf ' %q' "$@"
    printf '\n'
  else
    "$@"
  fi
}

# cd 到部署目录；本地 DRY_RUN 演练时目录通常不存在（这台不是服务器），留在原地继续演示分支逻辑。
cd_into_dir() {
  if [ -d "$DIR" ]; then
    cd "$DIR"
  elif [ "$DRY_RUN" = "1" ]; then
    echo "[DRY_RUN] 目录 $DIR 不存在（非服务器环境的本地演练），留在 $(pwd) 继续往下演示"
  else
    echo "✗ 目录 $DIR 不存在" >&2
    exit 1
  fi
}

# 把一条历史记录追加进 <env目录>/.deploy-history（tab 分隔）：
#   时间(UTC) 环境 动作(deploy) IMAGE_TAG commit全sha 耗时秒 结果
append_history() {
  local action="$1" tag="$2" sha="$3" duration="$4" result="$5"
  local line
  line=$(printf '%s\t%s\t%s\t%s\t%s\t%s\t%s' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$ENVIRONMENT" "$action" "$tag" "$sha" "$duration" "$result")
  if [ "$DRY_RUN" = "1" ]; then
    echo "[DRY_RUN] 将追加到 $DIR/.deploy-history： $line"
  else
    echo "$line" >>"$DIR/.deploy-history"
  fi
}

wait_healthy() {
  echo "▶ 等待健康…"
  if [ "$DRY_RUN" = "1" ]; then
    echo "[DRY_RUN] 将轮询 docker compose ps 等 backend healthy（最多 3 分钟）"
    return 0
  fi
  local i
  for i in $(seq 1 60); do
    "${COMPOSE[@]}" ps --format '{{.Service}} {{.Status}}' | grep -q '^backend Up.*healthy' && break
    sleep 3
  done
  "${COMPOSE[@]}" ps --format '  {{.Service}}\t{{.Status}}'
}

# 按「每环境最近 KEEP_TAGS_COUNT 个成功 tag」清理旧镜像；正在跑的容器一律不动。
# 两套环境共用一个 docker 守护进程、镜像名不分环境，所以两份 .deploy-history 都要看，
# 否则清了实测的旧 tag 可能正好是测试环境还在跑、或测试环境将来要回滚用的版本。
prune_images() {
  echo "▶ 清理旧镜像…"
  if [ "$DRY_RUN" = "1" ]; then
    echo "[DRY_RUN] 将按『两套环境各自最近 $KEEP_TAGS_COUNT 个成功 tag ∪ 正在跑的镜像 ∪ latest』清理 ftm-{backend,worker,sales-web,admin-web} 旧 tag，再 docker image prune -f"
    return 0
  fi

  local prod_hist=/opt/ftm/.deploy-history
  local staging_hist=/opt/ftm-staging/.deploy-history
  local keep
  keep=$(
    {
      [ -f "$prod_hist" ] && awk -F'\t' '$7=="success"{print $4}' "$prod_hist" | tail -n "$KEEP_TAGS_COUNT"
      [ -f "$staging_hist" ] && awk -F'\t' '$7=="success"{print $4}' "$staging_hist" | tail -n "$KEEP_TAGS_COUNT"
      # 加 || true：grep 在没有匹配容器时返回非零，pipefail 下会被当成这条语句失败，
      # 顶层 set -e 会因此直接掐掉整个部署脚本——这里「没有匹配」是正常情况，不是错误。
      docker ps --format '{{.Image}}' | grep -E '^ftm-(backend|worker|sales-web|admin-web):' | cut -d: -f2 || true
      echo latest
    } | sort -u
  )

  local svc tag
  for svc in "${APP_SERVICES[@]}"; do
    while read -r tag; do
      [ -z "$tag" ] && continue
      if ! grep -qxF "$tag" <<<"$keep"; then
        docker rmi "ftm-$svc:$tag" >/dev/null 2>&1 || true
      fi
    done < <(docker images "ftm-$svc" --format '{{.Tag}}' 2>/dev/null | sort -u)
  done

  # 兜底：没有任何容器引用的悬空镜像（<none>）——每次 build 都会留一个。
  docker image prune -f 2>&1 | tail -1
}

# ── 部署 ──────────────────────────────────────────────────────────────────

ENVIRONMENT="${1:-}"
shift || true
SERVICES=("$@")
if [ ${#SERVICES[@]} -eq 0 ]; then
  SERVICES=("${APP_SERVICES[@]}")
fi

case "$ENVIRONMENT" in
  prod)
    DIR=/opt/ftm
    PROJECT=ftm
    ENV_FILE=.env.prod
    ;;
  staging)
    DIR=/opt/ftm-staging
    PROJECT=ftm-staging
    ENV_FILE=.env.staging
    ;;
  *)
    echo "用法: $0 <prod|staging> [服务...]" >&2
    exit 2
    ;;
esac

cd_into_dir
if [ ! -f "$ENV_FILE" ]; then
  if [ "$DRY_RUN" = "1" ]; then
    echo "[DRY_RUN] 提示：$DIR/$ENV_FILE 不存在（本地演练可忽略，服务器上必须存在）"
  else
    echo "✗ $DIR/$ENV_FILE 不存在" >&2
    exit 1
  fi
fi

COMPOSE=(docker compose -p "$PROJECT" -f docker-compose.prod.yml --env-file "$ENV_FILE")

echo "▶ 环境 $ENVIRONMENT | 目录 $DIR | 项目 $PROJECT | 分支 $(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"
echo "▶ 服务 ${SERVICES[*]}"

# 实测环境多问一句 —— 推上去同事立刻就看得到
if [ "$ENVIRONMENT" = "prod" ] && [ -t 0 ] && [ "$DRY_RUN" != "1" ]; then
  read -r -p "这是同事正在用的实测环境，确认部署？[y/N] " ans
  case "$ans" in y | Y) ;; *) echo "已取消"; exit 1 ;; esac
fi

t0=$SECONDS

echo "▶ 拉代码…"
run git pull --ff-only

IMAGE_TAG=$(git rev-parse --short HEAD 2>/dev/null || echo dryrun)
commit_sha=$(git rev-parse HEAD 2>/dev/null || echo unknown)
export IMAGE_TAG

echo "▶ 构建并重启…（IMAGE_TAG=$IMAGE_TAG）"
run "${COMPOSE[@]}" up -d --build "${SERVICES[@]}"

echo "▶ 补打 latest 标签…"
for svc in "${SERVICES[@]}"; do
  case "$svc" in
    backend | worker | sales-web | admin-web)
      run docker tag "ftm-$svc:$IMAGE_TAG" "ftm-$svc:latest"
      ;;
  esac
done

wait_healthy

duration=$((SECONDS - t0))
append_history deploy "$IMAGE_TAG" "$commit_sha" "$duration" success

prune_images

df -h / | awk 'NR==2 {print "  磁盘 "$3" 已用 / "$4" 可用 ("$5")"}'

echo "✓ 完成"

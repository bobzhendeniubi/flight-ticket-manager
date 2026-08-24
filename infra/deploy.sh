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
# 部署完自动清悬空镜像：每次 build 都会把上一版镜像变成 <none> 但磁盘还占着，
# backend+worker 各约 1GB，攒几十次就是几十 G（2026-08-24 曾清出 38G）。
set -euo pipefail

ENVIRONMENT="${1:-}"
shift || true
SERVICES=("$@")
if [ ${#SERVICES[@]} -eq 0 ]; then
  SERVICES=(backend worker admin-web sales-web)
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

cd "$DIR"
[ -f "$ENV_FILE" ] || { echo "✗ $DIR/$ENV_FILE 不存在" >&2; exit 1; }

COMPOSE=(docker compose -p "$PROJECT" -f docker-compose.prod.yml --env-file "$ENV_FILE")

echo "▶ 环境 $ENVIRONMENT | 目录 $DIR | 项目 $PROJECT | 分支 $(git rev-parse --abbrev-ref HEAD)"
echo "▶ 服务 ${SERVICES[*]}"

# 实测环境多问一句 —— 推上去同事立刻就看得到
if [ "$ENVIRONMENT" = "prod" ] && [ -t 0 ]; then
  read -r -p "这是同事正在用的实测环境，确认部署？[y/N] " ans
  case "$ans" in y|Y) ;; *) echo "已取消"; exit 1 ;; esac
fi

echo "▶ 拉代码…"
git pull --ff-only

echo "▶ 构建并重启…"
"${COMPOSE[@]}" up -d --build "${SERVICES[@]}"

echo "▶ 等待健康…"
for _ in $(seq 1 60); do
  "${COMPOSE[@]}" ps --format '{{.Service}} {{.Status}}' | grep -q '^backend Up.*healthy' && break
  sleep 3
done
"${COMPOSE[@]}" ps --format '  {{.Service}}\t{{.Status}}'

# 只删没有任何容器引用的镜像；运行中的镜像碰不到。
# 两套环境共用一个 docker 守护进程，这里清的是全机的，不分环境。
echo "▶ 清理悬空镜像…"
docker image prune -f 2>&1 | tail -1
df -h / | awk 'NR==2 {print "  磁盘 "$3" 已用 / "$4" 可用 ("$5")"}'

echo "✓ 完成"

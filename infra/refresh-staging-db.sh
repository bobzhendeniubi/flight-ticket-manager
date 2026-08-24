#!/usr/bin/env bash
#
# 把**实测库整库复制到测试库** —— 让测试环境贴近真实数据形状。
#
#   bash /opt/ftm/infra/refresh-staging-db.sh
#
# 方向是**单向写死的**：ftm-postgres-prod ──► ftm-postgres-staging。
# 源和目标都硬编码、不接参数，就是为了防止哪天手滑把测试垃圾灌进实测库。
# 本脚本对实测库只跑 pg_dump（只读），永远不会写它。
#
# ⚠️ 整库复制**不脱敏**（2026-08-24 拍板）。测试库因此含真实客人的
#    姓名 / 护照号 / 手机 / 邮箱。对应防线在 /opt/ftm-staging/.env.staging：
#    SMTP 和微信必须留空，否则测试环境的提醒引擎会拿真实联系方式往外发。
#    执行前本脚本会校验这一点，配了就拒绝跑。
#
# 每次执行覆盖测试库全部内容（测试数据本来就是一次性的）。
set -euo pipefail

SRC_CONTAINER=ftm-postgres-prod
DST_CONTAINER=ftm-postgres-staging
STAGING_ENV=/opt/ftm-staging/.env.staging
DUMP_DIR=/opt/ftm/backups

for c in "$SRC_CONTAINER" "$DST_CONTAINER"; do
  docker ps --format '{{.Names}}' | grep -qx "$c" || {
    echo "✗ 容器 $c 没在跑" >&2; exit 1; }
done

# ── 发信闸：测试库要装真实联系方式，配了对外通道就等于给客人发垃圾 ──
[ -f "$STAGING_ENV" ] || { echo "✗ $STAGING_ENV 不存在" >&2; exit 1; }
for key in SMTP_HOST WECHAT_APPID WECHAT_MP_APPID; do
  val=$(grep -E "^${key}=" "$STAGING_ENV" | head -1 | cut -d= -f2- || true)
  if [ -n "$val" ]; then
    echo "✗ $STAGING_ENV 里 $key 有值。" >&2
    echo "  测试库即将装入真实客人联系方式，配了对外通道会真发出去。" >&2
    echo "  清空该项再重试。" >&2
    exit 1
  fi
done

echo "▶ 源 $SRC_CONTAINER（只读） → 目标 $DST_CONTAINER（**将被清空覆盖**）"
if [ -t 0 ]; then
  read -r -p "确认用实测数据覆盖测试库？[y/N] " ans
  case "$ans" in y|Y) ;; *) echo "已取消"; exit 1 ;; esac
fi

mkdir -p "$DUMP_DIR"
DUMP="$DUMP_DIR/ftm_$(date +%Y%m%d_%H%M%S).sql.gz"

echo "▶ 导出实测库…"
docker exec "$SRC_CONTAINER" pg_dump -U ftm -d ftm | gzip > "$DUMP"
# 空文件视为失败：灌一个空 dump 会把测试库清成白板还以为成功了
[ -s "$DUMP" ] || { echo "✗ 导出为空，已中止（未动测试库）" >&2; rm -f "$DUMP"; exit 1; }
echo "  $DUMP ($(du -h "$DUMP" | cut -f1))"

echo "▶ 清空测试库…"
docker exec "$DST_CONTAINER" psql -U ftm -d ftm -q \
  -c 'DROP SCHEMA public CASCADE;' -c 'CREATE SCHEMA public;'

echo "▶ 灌入测试库…"
gunzip -c "$DUMP" | docker exec -i "$DST_CONTAINER" psql -U ftm -d ftm -q

echo "▶ 核对行数（只比数量，不看内容）…"
for t in '"Order"' '"Flight"' '"FlightSchedule"' '"User"'; do
  a=$(docker exec "$SRC_CONTAINER" psql -U ftm -d ftm -tAc "select count(*) from $t")
  b=$(docker exec "$DST_CONTAINER" psql -U ftm -d ftm -tAc "select count(*) from $t")
  flag="✅"; [ "$a" = "$b" ] || flag="✗"
  printf '  %s %-18s 实测 %-7s 测试 %s\n' "$flag" "$t" "$a" "$b"
done

echo "✓ 完成。测试环境重启后生效：/opt/ftm-staging/infra/deploy.sh staging"

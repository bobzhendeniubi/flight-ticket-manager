#!/usr/bin/env bash
#
# 发版冒烟 —— 部署后（deploy.sh 会自动跑）或人工单独跑一遍，确认接口真的活着，
# 不是「容器 healthy 但业务全 500」。
#
#   /opt/ftm/infra/smoke.sh prod
#   /opt/ftm-staging/infra/smoke.sh staging
#
# 步骤：/readyz 探活 → 登录拿 token → 10 个只读 GET → 套餐非空则试算一次 → 导出一份表校验是 xlsx。
# 每步打印 OK/FAIL 与耗时；跑完全部步骤再统一判定，只要有一步 FAIL 就以非零退出
# （deploy.sh 据此决定要不要自动回滚）。
#
# 登录用 <env目录>/.env.<env> 里的 SMOKE_EMAIL / SMOKE_PASSWORD（可选两个新变量）：
#   - 都配了：跑完整套（含需要登录的步骤）
#   - 缺一个：只跑 /readyz 探活，打印提示，不算失败
# 建议配一个只读权限够用（能看订单/航班/套餐/报表）的 ADMIN 账号，不要用真人日常账号。
#
# 依赖 curl；JSON 解析优先用 jq，服务器没装则自动回退 python3 -c。
#
# DRY_RUN=1：只打印将发出的请求，不真的调用——本地演练分支逻辑用。
set -uo pipefail # 不用 -e：要跑完全部步骤、汇总后再统一判定退出码

ENVIRONMENT="${1:-}"
case "$ENVIRONMENT" in
  prod)
    DIR=/opt/ftm
    ENV_FILE=.env.prod
    BASE_URL=https://api.citurtravel.com
    ;;
  staging)
    DIR=/opt/ftm-staging
    ENV_FILE=.env.staging
    BASE_URL=https://test-api.citurtravel.com
    ;;
  *)
    echo "用法: $0 <prod|staging>" >&2
    exit 2
    ;;
esac

DRY_RUN="${DRY_RUN:-0}"
FAIL=0
REQ_N=0
TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

# ── 小工具 ────────────────────────────────────────────────────────────────

have_jq() { command -v jq >/dev/null 2>&1; }

# 从 JSON 文件里取一个字段。$1=文件 $2=jq filter $3=python 表达式（对已 load 的 d 求值）。
# 取不到 / 文件为空一律返回空串，不当脚本级错误。
json_get() {
  local file="$1" jqf="$2" pyexpr="$3"
  if have_jq; then
    jq -r "$jqf" "$file" 2>/dev/null
  else
    python3 - "$file" "$pyexpr" <<'PYEOF'
import json, sys
file_path, expr = sys.argv[1], sys.argv[2]
try:
    d = json.load(open(file_path))
except Exception:
    print("")
    sys.exit(0)
try:
    v = eval(expr)
except Exception:
    v = None
print("" if v is None else v)
PYEOF
  fi
}

# 把字符串安全变成一个 JSON 字符串字面量（含引号）——拼请求体用，避免密码带引号/反斜杠时手拼出错。
json_escape() {
  if have_jq; then
    jq -Rn --arg v "$1" '$v'
  else
    python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$1"
  fi
}

# 不 source 整个 env 文件——里面有些值带空格/尖括号（如 SMTP_FROM），source 会被当重定向符炸掉。
# 只精确摘这一行，跟 infra/refresh-staging-db.sh 读 SMTP_HOST 的方式一致。
read_env_var() {
  local key="$1" file="$DIR/$ENV_FILE"
  [ -f "$file" ] || return 0
  grep -E "^${key}=" "$file" | head -1 | cut -d= -f2-
}

# 允许调用方直接 export SMOKE_EMAIL/SMOKE_PASSWORD 覆盖（本地演练用），否则从 env 文件读。
SMOKE_EMAIL="${SMOKE_EMAIL:-$(read_env_var SMOKE_EMAIL)}"
SMOKE_PASSWORD="${SMOKE_PASSWORD:-$(read_env_var SMOKE_PASSWORD)}"

ACCESS_TOKEN=""
LAST_BODY_FILE=""
LAST_HTTP_CODE=""

# 发一个请求。$1=method $2=展示用的步骤名 $3=url $4=JSON body（可省略=不带 body）。
# 打印 OK/FAIL\t步骤名\t耗时或说明；2xx 记 OK，其余记 FAIL 并把 FAIL 计数置 1。
# 每次调用用独立的响应文件（写进 $LAST_BODY_FILE）——后面还有别的请求要发，
# 调用方要复用这次的响应内容（比如登录拿 token、套餐列表拿第一个 id），
# 得在下一次 do_request 调用之前，把 $LAST_BODY_FILE 存到自己的变量里。
do_request() {
  local method="$1" label="$2" url="$3" data="${4:-}"
  REQ_N=$((REQ_N + 1))
  local body_file="$TMP_DIR/resp_${REQ_N}.json"
  : >"$body_file"
  LAST_BODY_FILE="$body_file"

  if [ "$DRY_RUN" = "1" ]; then
    if [ -n "$data" ]; then
      echo "[DRY_RUN] $method $url  body=$(printf '%s' "$data" | head -c 200)"
    else
      echo "[DRY_RUN] $method $url"
    fi
    printf 'OK\t%s\t(dry-run，未真实请求)\n' "$label"
    return 0
  fi

  local -a args=(-sS --max-time 15 -o "$body_file" -w '%{http_code} %{time_total}' -X "$method" "$url")
  if [ -n "$ACCESS_TOKEN" ]; then
    args+=(-H "Authorization: Bearer $ACCESS_TOKEN")
  fi
  if [ -n "$data" ]; then
    args+=(-H "Content-Type: application/json" --data "$data")
  fi

  local out
  if ! out=$(curl "${args[@]}" 2>"$TMP_DIR/err_${REQ_N}"); then
    printf 'FAIL\t%s\tcurl 无法完成请求（%s）\n' "$label" "$(tr '\n' ' ' <"$TMP_DIR/err_${REQ_N}")"
    FAIL=1
    return 1
  fi

  LAST_HTTP_CODE="${out%% *}"
  local t="${out#* }"
  if [[ "$LAST_HTTP_CODE" =~ ^2[0-9][0-9]$ ]]; then
    printf 'OK\t%s\t%ss (HTTP %s)\n' "$label" "$t" "$LAST_HTTP_CODE"
    return 0
  fi
  printf 'FAIL\t%s\tHTTP %s：%s\n' "$label" "$LAST_HTTP_CODE" "$(head -c 300 "$body_file" | tr '\n' ' ')"
  FAIL=1
  return 1
}

# 校验响应体是 xlsx（zip 容器，魔数 'PK' = 0x50 0x4B）。$1=文件路径。
is_xlsx() {
  local magic
  magic=$(head -c 2 "$1" 2>/dev/null | od -An -tx1 | tr -d ' \n')
  [ "$magic" = "504b" ]
}

# ── 0. 探活（不需要登录）──────────────────────────────────────────────────

echo "== 冒烟：$ENVIRONMENT ($BASE_URL) =="
do_request GET "健康探活 /readyz" "$BASE_URL/readyz"

# ── 1. 登录（可选：缺凭证只探活，不算失败）───────────────────────────────

if [ -z "$SMOKE_EMAIL" ] || [ -z "$SMOKE_PASSWORD" ]; then
  echo "ℹ 未在 $DIR/$ENV_FILE 配置 SMOKE_EMAIL / SMOKE_PASSWORD，只跑免登录探活"
  echo
  if [ "$FAIL" -eq 0 ]; then
    echo "✓ 探活通过（未跑需要登录的步骤）"
    exit 0
  fi
  echo "✗ 探活未通过"
  exit 1
fi

login_body=$(printf '{"email":%s,"password":%s}' "$(json_escape "$SMOKE_EMAIL")" "$(json_escape "$SMOKE_PASSWORD")")
if do_request POST "登录 /auth/login" "$BASE_URL/auth/login" "$login_body"; then
  if [ "$DRY_RUN" = "1" ]; then
    ACCESS_TOKEN="dry-run-fake-token"
  else
    ACCESS_TOKEN=$(json_get "$LAST_BODY_FILE" '.tokens.accessToken // empty' "d.get('tokens',{}).get('accessToken')")
    if [ -z "$ACCESS_TOKEN" ]; then
      printf 'FAIL\t登录\t响应里没有 tokens.accessToken\n'
      FAIL=1
    fi
  fi
else
  echo
  echo "✗ 登录失败（HTTP $LAST_HTTP_CODE），后续需要登录的步骤全部跳过"
  exit 1
fi

# ── 2. 10 个只读 GET（挑运营/票务/财务日常都要用的接口，覆盖面比单一探活有意义）──

do_request GET "订单列表 /orders" "$BASE_URL/orders?pageSize=1"
do_request GET "航班列表 /flights" "$BASE_URL/flights"

bundles_body=""
if do_request GET "套餐列表 /products/bundles" "$BASE_URL/products/bundles"; then
  bundles_body="$LAST_BODY_FILE"
fi

do_request GET "酒店列表 /products/hotels" "$BASE_URL/products/hotels"
do_request GET "提醒工单 summary /reminders/work-orders/summary" "$BASE_URL/reminders/work-orders/summary"
do_request GET "经营报表 summary /reports/sales" "$BASE_URL/reports/sales"

# 结算价日历要求 from/to（YYYY-MM-DD）；用 python3 算「今天 ~ 今天+30 天」——
# 不用 `date -d`，BSD date（本地 mac 演练）和 GNU date（服务器）语法不兼容。
today=$(python3 -c "import datetime; print(datetime.date.today().isoformat())" 2>/dev/null || date -u +%Y-%m-%d)
in_30d=$(python3 -c "import datetime; print((datetime.date.today()+datetime.timedelta(days=30)).isoformat())" 2>/dev/null || echo "$today")
do_request GET "结算价日历 /settlement-rates" "$BASE_URL/settlement-rates?from=${today}&to=${in_30d}"

do_request GET "代理列表 /agents" "$BASE_URL/agents"
do_request GET "审计日志 /audit-logs" "$BASE_URL/audit-logs?pageSize=1"
do_request GET "仪表盘 /dashboard/kpi" "$BASE_URL/dashboard/kpi"

# ── 3. 套餐非空则试算一次（POST /orders/quote）────────────────────────────
# BUNDLE 行只需 bundleId——服务端用它重新查库定价（priceAndValidateItems 不信任
# 客户端 unitPrice），这里填 0 也不影响试算是否成功。

first_bundle_id=""
if [ "$DRY_RUN" != "1" ] && [ -n "$bundles_body" ]; then
  first_bundle_id=$(json_get "$bundles_body" '(.bundles // [])[0].id // empty' "(d.get('bundles') or [{}])[0].get('id')")
fi

if [ "$DRY_RUN" = "1" ]; then
  quote_body='{"items":[{"kind":"BUNDLE","description":"发版冒烟试算","quantity":1,"bundleId":"<dry-run>","unitPrice":0}]}'
  do_request POST "试算 /orders/quote" "$BASE_URL/orders/quote" "$quote_body"
elif [ -n "$first_bundle_id" ]; then
  quote_body=$(printf '{"items":[{"kind":"BUNDLE","description":"发版冒烟试算","quantity":1,"bundleId":%s,"unitPrice":0}]}' "$(json_escape "$first_bundle_id")")
  do_request POST "试算 /orders/quote" "$BASE_URL/orders/quote" "$quote_body"
else
  echo "ℹ 套餐列表为空（或取不到 id），跳过试算步骤"
fi

# ── 4. 导出一份表，校验是 xlsx（进单统计导出，字段全选填，最轻的一个）──────

if do_request GET "进单导出 /orders/export/intake" "$BASE_URL/orders/export/intake"; then
  if [ "$DRY_RUN" != "1" ] && ! is_xlsx "$LAST_BODY_FILE"; then
    printf 'FAIL\t进单导出\t响应不是 xlsx（缺 PK 魔数）\n'
    FAIL=1
  fi
fi

# ── 汇总 ──────────────────────────────────────────────────────────────────

echo
if [ "$FAIL" -eq 0 ]; then
  echo "✓ 冒烟全部通过"
  exit 0
fi
echo "✗ 冒烟未全部通过，见上方 FAIL 行"
exit 1

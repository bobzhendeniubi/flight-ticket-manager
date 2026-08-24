# 两套环境

一台机器（`47.83.249.163`）跑两套互不干扰的栈。

| | 实测（同事日常在用） | 测试（随便折腾） |
|---|---|---|
| 目录 | `/opt/ftm` | `/opt/ftm-staging` |
| 分支 | `main` | 任意（默认 main） |
| compose 项目名 | `ftm` | `ftm-staging` |
| env 文件 | `.env.prod` | `.env.staging` |
| 容器名后缀 | `-prod` | `-staging` |
| 后端端口 | `127.0.0.1:4000` | `127.0.0.1:4100` |
| 后台端口 | `127.0.0.1:8080` | `127.0.0.1:8180` |
| 前台端口 | `127.0.0.1:8081` | `127.0.0.1:8181` |
| 域名 | `admin/store/api.citurtravel.com` | `test-admin/test-store/test-api.citurtravel.com` |
| 数据卷 | `ftm_postgres_data` / `ftm_redis_data` | `ftm-staging_postgres_data` / `ftm-staging_redis_data` |

**两套共用同一份 `docker-compose.prod.yml`**，靠 `STACK` + 端口变量 + compose 项目名区分。
`STACK` 默认 `prod`，所以实测那套的命令和容器名跟拆分之前完全一样。

## 发版

```bash
# 实测（会二次确认，同事立刻看得到）
/opt/ftm/infra/deploy.sh prod

# 测试
/opt/ftm-staging/infra/deploy.sh staging

# 只重建部分服务
/opt/ftm-staging/infra/deploy.sh staging backend worker
```

脚本会 `git pull` → 重建 → 等健康 → **清悬空镜像**。最后一步别省：每次 build 都会把
上一版镜像变成 `<none>` 但磁盘还占着，backend+worker 各约 1GB。2026-08-24 曾因此
累积到 38G、磁盘 74%。

## 让测试环境跑别的分支

测试目录是独立 checkout，想验哪个分支就切哪个：

```bash
cd /opt/ftm-staging
git fetch && git checkout <分支>
./infra/deploy.sh staging
```

实测目录**只跑 `main`**，别在 `/opt/ftm` 里切分支。

## 把实测数据拷到测试

```bash
bash /opt/ftm/infra/refresh-staging-db.sh
```

方向单向写死（prod ──► staging），对实测只读。每次覆盖测试库全部内容。

⚠️ **整库复制不脱敏**（2026-08-24 拍板）。测试库因此含真实客人的姓名 / 护照号 /
手机 / 邮箱。防线是 `.env.staging` 里 SMTP 和微信必须留空——否则测试环境的提醒引擎
会拿真实联系方式往外发。脚本执行前会校验，配了就拒绝跑。

想加脱敏，在脚本「灌入」之后插一段 UPDATE 打码即可。

## 两套的密钥必须不同

`JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` 共用的话，测试环境签发的令牌能登实测后台。
`.env.staging` 由 `infra/env.staging.example` 生成，密钥现场随机产生，不抄实测的。

## 域名与 DNS

两套环境的 6 个站点全部指向同一个 IP，靠 Caddy 按域名分流到不同端口。

| 域名 | 反代到 | 环境 |
|---|---|---|
| `admin.citurtravel.com` | `127.0.0.1:8080` | 实测后台 |
| `store.citurtravel.com` | `127.0.0.1:8081` | 实测前台 |
| `api.citurtravel.com` | `127.0.0.1:4000` | 实测接口 |
| `test-admin.citurtravel.com` | `127.0.0.1:8180` | 测试后台 |
| `test-store.citurtravel.com` | `127.0.0.1:8181` | 测试前台 |
| `test-api.citurtravel.com` | `127.0.0.1:4100` | 测试接口 |

另有 `citurtravel.com`（落地页，静态文件 `/opt/ftm/landing`）和 `www`（301 跳主域）。

测试的三个站带 `X-Robots-Tag: noindex, nofollow` —— 测试站被搜索引擎收录会让客人搜进去下真单。
实测站不带。

### DNS 在哪

**阿里云「中国站」账号**（主账号「四川世途旅游股…」），域名 2016 年注册于万网 / net.cn，
NS 是 `vip3/vip4.alidns.com`（企业标准版云解析）。

⚠️ **国际站账号（alibabacloud.com）看不到这个域名。** 2026-08-24 配 DNS 时先登到国际站账号，
Public Zone 和域名列表都是 0 条，白折腾一轮才反应过来是两套独立账号体系。
入口 `dns.console.aliyun.com`，登国际站账号会被强制重定向到 alibabacloud.com。

### 现有解析记录（13 条）

- A 记录 × 8：`@` / `www` / `store` / `api` / `admin` / `test-store` / `test-admin` / `test-api`
  → 全部 `47.83.249.163`，默认线路，TTL 10 分钟
- 邮件 × 5：QQ 企业邮的 `MX`×2、`SPF`(TXT)、`_dmarc`(TXT)、`qqmaila154e864`(CNAME)

**加记录时别碰邮件那 5 条。** 没有用泛解析 `*` —— 有邮件解析在，显式记录更稳，
也避免拼错的子域名被解析到我们服务器上。

### 加记录时的两个坑

1. 阿里云表单的「记录值」输入框上方会浮出帮助提示挡住它，按坐标点击 + 输入经常落空。
   填完务必回看一眼是不是真填进去了。
2. 「解析请求来源」每加完一条会重置成「请选择」，必须重新选「默认 / 默认」，否则校验不过。

### Caddy 签证书

新加域名后 Caddy 自动向 Let's Encrypt 申请，但有个时序坑：

- **DNS 记录加好之前**就 reload 过 Caddy 的话，ACME 会因 NXDOMAIN 失败并进入退避
  （日志里 `retrying_in: 1200`，最长重试 30 天）。
- 此后再 `systemctl reload caddy` **不会立即重试** —— Caddy 报 `config is unchanged`。
  **耐心等它自己到点重试即可**（约 20 分钟），不要为此 `systemctl restart caddy`，
  那会瞬断生产反代。
- ZeroSSL 那条备用签发路径恒报 `caddy_legacy_user_removed`，是 ZeroSSL 自家账号问题，
  不影响 Let's Encrypt 正常签发，可忽略。

改 Caddy 配置的正确姿势（仓库副本是 `infra/staging/Caddyfile.citurtravel`）：

```bash
cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak-$(date +%Y%m%d-%H%M)
cp /opt/ftm/infra/staging/Caddyfile.citurtravel /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile   # 先验，再 reload
systemctl reload caddy
```

reload 后**第一件事是确认实测四个站点还活着**，再看测试站。

## 排错

- `docker compose` **任何**子命令都要带 `--env-file`，否则报 `PAYMENT_MODE is missing`。
- 两套的 compose 命令必须带各自的 `-p`（`ftm` / `ftm-staging`），**项目名串了数据卷就串了**。
- `.env.prod` / `.env.staging` 只在服务器上，不进版本库，切分支和拉代码都不会动它们。
- SSH key 叫 `~/.ssh/ftm_staging`，但那台机器是实测环境——名字是历史遗留，别被误导。

## 查两套各自的状态

```bash
cd /opt/ftm         && docker compose -p ftm         -f docker-compose.prod.yml --env-file .env.prod    ps
cd /opt/ftm-staging && docker compose -p ftm-staging -f docker-compose.prod.yml --env-file .env.staging ps
```

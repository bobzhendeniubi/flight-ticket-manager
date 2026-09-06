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

# 冒烟失败先自己看看，暂时不想自动回滚
/opt/ftm/infra/deploy.sh prod --no-auto-rollback
```

流程：`git pull` → 按 git short sha 打镜像 tag（`ftm-<svc>:<sha>`，同时补一份
`:latest`）构建重启 → 等健康 → **跑 `infra/smoke.sh`** → 冒烟失败就自动
`rollback` 到上一个成功版本（除非传了 `--no-auto-rollback`）→ **清旧镜像**
→ 把这次的 tag / commit 全 sha / 耗时 / 结果追加写进 `<环境目录>/.deploy-history`
（tab 分隔，一行一条；会以未加入版本库的形式留在部署目录里，跟 `backups/` 一样）。

镜像清理只保留**两套环境各自最近 5 个成功 tag**（并集）∪ 正在跑的镜像 ∪ `latest`，
其余 tag 连同每次 build 产生的悬空 `<none>` 镜像一起清掉。别省这一步：以前没有
tag、旧镜像变成 `<none>` 也占着磁盘，backend+worker 各约 1GB，2026-08-24 曾因此
累积到 38G、磁盘 74%。

## 回滚

```bash
# 不传 tag = 回到 .deploy-history 里「上一条成功记录」
/opt/ftm/infra/deploy.sh rollback prod

# 回到指定 tag（.deploy-history 里的 IMAGE_TAG 那一列，也就是 git short sha）
/opt/ftm-staging/infra/deploy.sh rollback staging a1b2c3d
```

回滚只做一件事：把 `docker-compose.prod.yml` 里四个服务的 `IMAGE_TAG` 切到目标
tag 后 `compose up -d`——**不 build、不拉代码、不碰数据库**，几秒钟内切完。

**回滚不回退数据库迁移。** 如果目标 tag 之后有新提交加了
`backend/prisma/migrations/`，回滚脚本会比较当前 HEAD 与目标 tag 对应 commit
的迁移目录差异，发现有差异就直接拒绝并打印出是哪些迁移文件，因为旧代码不一定
认得住新迁移建的列/表/约束——这种情况先确认这些迁移是不是「新增可空列/新增表」
这类不影响旧代码的安全迁移，确认没问题再加 `--force` 跳过检查。**永远不要**
无脑加 `--force`：真正需要撤销一个有破坏性的迁移，得手工写 down 脚本，回滚
命令帮不了这个忙。

## 冒烟

```bash
# deploy.sh 部署健康后会自动跑；也可以单独手动跑一遍
/opt/ftm/infra/smoke.sh prod
```

依次探 `/readyz` → 登录 → 10 个只读接口（订单/航班/套餐/酒店/提醒工单/报表/
结算价日历/代理/审计日志/仪表盘）→ 套餐非空则试算一次 → 导出一份表校验是
xlsx。每步打印 `OK`/`FAIL` 和耗时，任何一步失败整体以非零退出。

登录需要 `.env.prod` / `.env.staging` 里配 `SMOKE_EMAIL` / `SMOKE_PASSWORD`
（两个新变量，`infra/env.staging.example` 已给了空位）——建一个只读权限够用
（能看订单/航班/套餐/报表）的账号，别拿真人日常账号顶上去。两个变量缺一个，
冒烟脚本只跑免登录的 `/readyz` 探活，会打印提示但不算失败。

## 本地演练（DRY_RUN）

`deploy.sh` 和 `smoke.sh` 都支持 `DRY_RUN=1`：只打印会执行的命令/发出的请求，
不真的碰 git / docker / 网络，用来在本地核对分支逻辑对不对。

```bash
DRY_RUN=1 bash infra/deploy.sh prod
DRY_RUN=1 bash infra/deploy.sh rollback staging a1b2c3d
DRY_RUN=1 SMOKE_EMAIL=x@x.com SMOKE_PASSWORD=x bash infra/smoke.sh prod
```

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
- `<环境目录>/.deploy-history` 也只在服务器上（不进版本库，`git status` 会显示成未跟踪文件，
  跟 `backups/` 一样正常），回滚靠它挑「上一条成功」——误删这个文件不影响线上服务，
  但下次 `rollback` 不传 tag 就没法自动挑目标了，得显式传 tag。

## 查两套各自的状态

```bash
cd /opt/ftm         && docker compose -p ftm         -f docker-compose.prod.yml --env-file .env.prod    ps
cd /opt/ftm-staging && docker compose -p ftm-staging -f docker-compose.prod.yml --env-file .env.staging ps
```

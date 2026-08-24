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

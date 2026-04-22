# 世途旅行 · 生产部署指南

## 总览

```
┌──────────────────────────────────────────────────────────────┐
│                      外网 HTTPS (443)                          │
│                 ( Caddy / Nginx / 云 LB 终结 )                  │
└────────────┬────────────────────────┬────────────────────────┘
             │ sales.citur.com        │ admin.citur.com
             ↓                        ↓
      ┌──────────────┐         ┌──────────────┐
      │ sales-web    │         │ admin-web    │
      │ (nginx:80)   │         │ (nginx:80)   │
      └──────┬───────┘         └──────┬───────┘
             │  /api/*                │  /api/*
             └──────────┬─────────────┘
                        ↓
                 ┌──────────────┐      ┌──────────────┐
                 │ backend API  │◀────▶│ worker       │
                 │ (Fastify)    │      │ (BullMQ)     │
                 └──┬──────┬────┘      └──┬───────────┘
                    ↓      ↓              ↓
             ┌──────────┐ ┌──────────┐
             │ postgres │ │ redis    │
             └──────────┘ └──────────┘
```

5 个服务容器 + 2 个数据卷。单机部署可跑在一台 4C8G ECS/VPS 上。

## 本地一键生产验证

```bash
# 1. 准备生产 env
cp docs/env.prod.example .env.prod
vim .env.prod   # 设强密钥

# 2. 构建 + 启动
docker-compose -f docker-compose.prod.yml --env-file .env.prod up -d --build

# 3. 初始化数据（仅首次）
docker exec -it ftm-backend-prod sh -c "npx prisma db seed"

# 4. 验证
curl http://localhost/api/readyz     # sales-web 代理后端
curl http://localhost:8080/api/readyz # admin-web 代理后端
```

访问：
- 前台：http://localhost
- 后台：http://localhost:8080
- 默认账号：admin@ftm.local / Password123!

## 云部署（AWS / 腾讯云）

### 选项 A：单机 ECS（成本最低，适合前 3 家客户）
- 1 台 4C8G Ubuntu 22.04
- 安装 Docker + docker-compose
- 挂载 EBS 给 `postgres_data` / `redis_data`
- 外层用 Caddy 做 HTTPS（自动 Let's Encrypt）

```bash
# Caddyfile 示例
sales.citur.com {
    reverse_proxy localhost:80
}
admin.citur.com {
    reverse_proxy localhost:8080
}
```

### 选项 B：阿里云/腾讯云托管服务（3-5 家客户后）
- **RDS PostgreSQL**（取代 docker postgres）
- **Redis 实例**（取代 docker redis）
- backend / worker 用 **ECS 容器服务** 或 **Serverless** 部署
- 静态前端用 **OSS + CDN**
- **SLB** 做 HTTPS 终结

### 选项 C：Kubernetes（10+ 家客户）
- EKS / ACK / TKE
- Helm chart 托管 backend + worker + 2 前端
- postgres/redis 用云托管
- HPA 水平扩展

## 生产前 checklist

- [ ] 生成强随机密钥：
  ```bash
  openssl rand -base64 48   # JWT_ACCESS_SECRET
  openssl rand -base64 48   # JWT_REFRESH_SECRET
  openssl rand -base64 32   # SANDBOX_WEBHOOK_SECRET
  openssl rand -base64 24   # POSTGRES_PASSWORD
  ```
- [ ] 配置 `CORS_ORIGINS` 为真实域名（不要 *）
- [ ] 切 `PAYMENT_MODE=live`，配 WeChat/Alipay 真实 key
- [ ] 外层 HTTPS（Caddy 或云 LB）
- [ ] DB 备份脚本 + off-site 存储（S3 / COS）
- [ ] 日志收集（CloudWatch / Loki / 阿里云 SLS）
- [ ] 监控告警（CPU / 内存 / DB 连接数 / 错误率）
- [ ] 访问日志启用、保留至少 90 天

## 备份 / 恢复

### 每日自动备份

```bash
# crontab -e  (宿主机)
0 3 * * * docker exec ftm-postgres-prod pg_dump -U ftm ftm | gzip > /opt/ftm-backups/ftm-$(date +\%Y\%m\%d).sql.gz && find /opt/ftm-backups -mtime +30 -delete
```

### 恢复
```bash
zcat /opt/ftm-backups/ftm-20260501.sql.gz | docker exec -i ftm-postgres-prod psql -U ftm ftm
```

### Redis 持久化
已开启 `appendonly yes` + 512MB LRU，重启不丢任务队列。

## 安全检查清单

### 应用层
- [x] helmet + cors 白名单（已配）
- [x] rate-limit 100 req/min（已配）
- [x] JWT 双 token 轮换（access 15min + refresh 7d）
- [x] argon2 密码散列
- [x] Zod 所有输入校验
- [x] Prisma 参数化（无 SQL 注入风险）
- [ ] CSP 策略（sales-web/admin-web nginx.conf 补）
- [ ] 依赖扫描：`npm audit` + Snyk/Dependabot
- [ ] 渗透测试（上线前）

### 基础设施
- [ ] VPC 私网 DB（不暴露 5432 到公网）
- [ ] SSH 仅密钥登录 + fail2ban
- [ ] 定期重启 + patch 更新
- [ ] WAF（云厂商自带）

## 监控指标（TODO）

backend 应暴露 `/metrics` (Prometheus 格式)。关键指标：

- `http_requests_total{method,route,status}`
- `http_request_duration_seconds_bucket`
- `orders_created_total`
- `payments_succeeded_total`
- `fulfillment_tasks_pending`
- `fulfillment_tasks_failed_total`
- `db_connections_active`
- `bullmq_jobs_active{queue}`

## 回滚方案

发版后发现严重 bug：
1. `docker-compose -f docker-compose.prod.yml pull previous-tag` 或 `git checkout <prev>`
2. `docker-compose -f docker-compose.prod.yml up -d --force-recreate backend worker`
3. 如果是 DB migration 问题：先 `npx prisma migrate resolve --rolled-back <migration_name>`，再跑回滚脚本

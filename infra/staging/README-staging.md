# 阿里云香港 1-2 周 Staging 部署 · 实操指南

> 让公司同事 / 测试团队 1-2 周访问的 staging 环境。
> 已经买好阿里云轻量服务器（4C8G 香港，公网 IP `47.83.249.163`）。

## 总览

```
                    Cloudflare 免费层（DNS + WAF + DDoS）
                           ↓
                    阿里云香港轻量 4C8G
                    ┌─────────────────────────┐
                    │ Caddy 自动 HTTPS         │ ← Let's Encrypt
                    │ ufw: 22/80/443           │
                    │ fail2ban: SSH brute      │
                    │  ↓                       │
                    │ docker compose:          │
                    │   sales-web (80)         │
                    │   admin-web (8080)       │
                    │   backend   (4000)       │
                    │   worker    (BullMQ)     │
                    │   postgres  (内网)       │
                    │   redis     (内网)       │
                    └─────────────────────────┘
```

---

## ⏱️ 完整流程（30 分钟搞定）

### 第 1 步：SSH 上服务器（5 秒）

```bash
ssh root@47.83.249.163
# 输刚才在阿里云控制台设的密码
# 第一次会问 yes/no — 输 yes
```

进系统看到 `[root@iZ... ~]#` 就是成功。

### 第 2 步：跑一键部署脚本（10-15 分钟）

直接复制这一行粘贴到服务器 shell：

```bash
curl -fsSL https://raw.githubusercontent.com/bobzhendeniubi/flight-ticket-manager/feat/m2-agent-hierarchy-flights/infra/staging/deploy.sh | bash
```

脚本会自动做：
1. 系统更新 + 装基础工具
2. 装 Docker + Caddy + ufw + fail2ban
3. 配防火墙（22/80/443）
4. clone 项目到 `/opt/ftm`
5. 生成 `/opt/ftm/.env.prod`（强随机密钥）
6. `docker compose build + up` 全栈起来
7. `prisma db seed` 灌 demo 数据
8. 启用自动安全补丁

完成后看到：
```
[deploy] ✅ 部署完成
本机公网 IP：47.83.249.163
```

可以测一下：
```bash
curl http://localhost/api/readyz
# 期望返回 {"status":"ok",...}
```

### 第 3 步：买域名 + 配 DNS（10 分钟）

#### 选项 A：Cloudflare Registrar（推荐，便宜）

1. 注册 Cloudflare 账号：https://dash.cloudflare.com/sign-up
2. 买域名：https://dash.cloudflare.com/?to=/:account/registrar — 成本价（`.com` ¥75/年）

#### 加 3 条 A 记录

在 Cloudflare DNS 控制台 → Add record：

| Type | Name | Content | Proxy status |
|------|------|---------|--------------|
| A | sales | `47.83.249.163` | 🟠 Proxied（橙云）|
| A | admin | `47.83.249.163` | 🟠 Proxied |
| A | api | `47.83.249.163` | 🟠 Proxied |

> "🟠 Proxied" = 流量走 Cloudflare CDN/WAF，不是直连阿里云。
> 这是免费 DDoS + WAF 防护的关键。

### 第 4 步：配 Caddy 自动 HTTPS（2 分钟）

```bash
cp /opt/ftm/infra/staging/Caddyfile.example /etc/caddy/Caddyfile
sed -i 's/your-domain.com/真域名.com/g' /etc/caddy/Caddyfile
systemctl restart caddy
```

> 等 30-60 秒 Caddy 自动签 Let's Encrypt 证书。

### 第 5 步：改 .env.prod 用真域名（1 分钟）

```bash
vim /opt/ftm/.env.prod
# 把 CORS_ORIGINS 和 APP_PUBLIC_URL 改成你的真域名

cd /opt/ftm
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --force-recreate backend worker
```

### 第 6 步（可选但推荐）：SSH 加固

#### 先把 SSH 公钥拷到服务器

在你 Mac 上：

```bash
ls ~/.ssh/id_ed25519.pub || ssh-keygen -t ed25519 -C "你的邮箱"
ssh-copy-id root@47.83.249.163
ssh root@47.83.249.163 "echo 'key 登录 OK'"
```

#### 跑加固脚本

```bash
ssh root@47.83.249.163 "bash /opt/ftm/infra/staging/harden.sh"
```

完成后密码登录被禁，只能用 SSH key。
出问题可走阿里云控制台「远程连接」VNC 恢复。

### 第 7 步：Cloudflare 加 WAF 规则（5 分钟，可选）

进 Cloudflare 域名 → Security → WAF → Custom rules → Create rule：

| 规则 | 表达式 | 动作 |
|---|---|---|
| 限速 | `(http.request.uri.path eq "/")` | Rate limit 100/10s |
| 阻止扫描 | `(http.request.uri.path matches "(?i)\\.(php\\|env\\|git)$\\|wp-admin\\|xmlrpc")` | Block |
| 阻止 No-UA | `(http.user_agent eq "")` | Challenge |
| Admin 白名单 | `(http.host eq "admin.真域名.com" and not ip.src in {你的公司IP})` | Block |

---

## ✅ 验收清单

- [ ] `https://sales.真域名.com` 打开看到首页
- [ ] `https://admin.真域名.com` 打开能登录（admin@ftm.local / Password123!）
- [ ] `curl https://api.真域名.com/readyz` 返回 200
- [ ] 浏览器锁标志 🔒 + Cloudflare 证书
- [ ] `ssh root@47.83.249.163` 用 key 自动登（密码登录被禁）
- [ ] `fail2ban-client status sshd` 显示 jail 启用

---

## 💸 成本

| 项 | 金额 | 备注 |
|---|---:|---|
| 阿里云轻量 4C8G 香港 | **¥230** | 1 个月 ($32) |
| 域名 `.com` Cloudflare | **¥75** | 一次性 / 年 |
| Cloudflare 免费层 | ¥0 | DNS + WAF + DDoS |
| Let's Encrypt 证书 | ¥0 | Caddy 自动 |
| **总计** | **~¥305** | 跑 1 个月 |

---

## 🧹 测试结束后清理

阿里云控制台 → 轻量应用服务器 → 实例 → 退订 / 不续费即可。
1 个月到期日服务器自动释放，数据销毁。

---

## 🆘 故障排查

| 症状 | 解决 |
|---|---|
| `curl http://localhost/api/readyz` 502 | `docker logs ftm-backend-prod` 看错误 |
| Caddy 证书没签下来 | DNS 需要几分钟生效；80 端口被防火墙挡 |
| `docker exec ... seed` 报错 | seed 已跑过；表里有数据就忽略 |
| SSH 进不去 | 阿里云控制台「远程连接」VNC 恢复 sshd_config |

---

## 🔁 日常运维

更新代码：
```bash
ssh root@47.83.249.163
cd /opt/ftm && git pull && docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build
```

查日志：
```bash
docker logs -f ftm-backend-prod
docker logs -f ftm-worker-prod
journalctl -u caddy -f
```

进数据库：
```bash
docker exec -it ftm-postgres-prod psql -U ftm -d ftm
```

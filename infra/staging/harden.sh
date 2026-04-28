#!/usr/bin/env bash
# SSH 安全加固脚本
#
# ⚠️ 跑这个之前确保你的 SSH 公钥已经放在 ~/.ssh/authorized_keys 里！
#    否则会把自己锁在外面（密码登录被禁用）。
#
# 用法：
#   1. 在你 Mac 上：cat ~/.ssh/id_ed25519.pub  # 没有就先 ssh-keygen -t ed25519
#   2. ssh-copy-id root@<服务器IP>            # 把公钥拷过去
#   3. 测试 ssh root@<服务器IP> 不需要密码能登 → 通过才跑这个脚本
#   4. ssh root@<服务器IP> bash /opt/ftm/infra/staging/harden.sh
#
# 这个脚本做的事：
#   1. 禁用 SSH 密码登录（仅密钥）
#   2. 禁用 root 密码登录（root 仍可用 key）
#   3. 重启 sshd
#   4. 验证（如果还能 ssh 进来，就成功了）
set -euo pipefail

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'
log()  { echo -e "${GREEN}[harden] $*${NC}"; }
warn() { echo -e "${YELLOW}[harden] $*${NC}"; }
fail() { echo -e "${RED}[harden] $*${NC}"; exit 1; }

[ "$EUID" -eq 0 ] || fail "请用 root 跑"

# ── 先检查 root 有没有 authorized_keys ──────────────────────────
if [ ! -s "/root/.ssh/authorized_keys" ]; then
  fail "/root/.ssh/authorized_keys 是空的或不存在！
        先在你的 Mac 上跑：ssh-copy-id root@<服务器IP>
        确认 SSH key 登录工作之后，再跑这个脚本。"
fi

log "✅ 检测到 SSH 公钥已配置"

# ── 备份 sshd_config ─────────────────────────────────────────────
cp /etc/ssh/sshd_config /etc/ssh/sshd_config.bak.$(date +%s)

# ── 应用加固 ─────────────────────────────────────────────────────
log "禁用密码登录 + root 密码登录"
sed -i 's/^#*PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sed -i 's/^#*PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config
sed -i 's/^#*ChallengeResponseAuthentication.*/ChallengeResponseAuthentication no/' /etc/ssh/sshd_config
sed -i 's/^#*UsePAM.*/UsePAM yes/' /etc/ssh/sshd_config

# ── 测试配置语法 ─────────────────────────────────────────────────
sshd -t || fail "sshd_config 语法错误！未重启。已备份原配置到 /etc/ssh/sshd_config.bak.*"

# ── 重启 sshd ────────────────────────────────────────────────────
log "重启 sshd"
systemctl restart sshd
log "═══════════════════════════════════════════════"
log "✅ SSH 加固完成"
log "═══════════════════════════════════════════════"
echo ""
echo "现在密码登录已禁用。从你的 Mac 测试："
echo "   ssh root@$(hostname -I | awk '{print $1}')   # 应该自动用 key 进，不需要密码"
echo ""
echo "如果不能进 → 别慌，阿里云控制台「远程连接」一直可用，"
echo "  进去 cp /etc/ssh/sshd_config.bak.<timestamp> /etc/ssh/sshd_config && systemctl restart sshd"

# ───────────────────────────────────────────────────────────────
# 世途旅行 Backend — 多阶段构建
# 阶段 1: deps 装依赖（含 devDeps 供 build 用）
# 阶段 2: builder 编译 TS → dist/
# 阶段 3: runner 只包含生产 deps + dist/，体积最小
# 可切换 entrypoint：
#   CMD ["node","dist/index.js"]         → API server（默认）
#   CMD ["node","dist/queues/worker.js"] → BullMQ worker
# ───────────────────────────────────────────────────────────────
ARG NODE_VERSION=22-alpine

# ── Stage 1: deps ──
FROM node:${NODE_VERSION} AS deps
WORKDIR /app
# 复制 workspace root package 和 backend 的 package.json 做精确安装
COPY package.json package-lock.json ./
COPY backend/package.json ./backend/
COPY backend/prisma ./backend/prisma
# 装根 workspace（backend 的子依赖会被打到 node_modules/）
RUN npm ci --workspace=@ftm/backend --include-workspace-root && \
    cd backend && npx prisma generate

# ── Stage 2: builder ──
FROM node:${NODE_VERSION} AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/backend/node_modules ./backend/node_modules
COPY backend ./backend
COPY tsconfig.base.json ./
WORKDIR /app/backend
RUN npm run build

# ── Stage 3: runner（生产 only）──
FROM node:${NODE_VERSION} AS runner
# 小工具 + 非 root 用户
RUN apk add --no-cache tini curl && \
    addgroup -g 1001 ftm && \
    adduser -D -u 1001 -G ftm ftm
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=4000

COPY --from=builder /app/backend/dist ./dist
COPY --from=builder /app/backend/node_modules ./node_modules
COPY --from=builder /app/backend/prisma ./prisma
COPY backend/package.json ./package.json

USER ftm
EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS http://localhost:4000/readyz || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]

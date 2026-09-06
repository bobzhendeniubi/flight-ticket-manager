ARG NODE_VERSION=22-alpine

FROM node:${NODE_VERSION} AS builder
WORKDIR /app
RUN apk add --no-cache openssl
COPY package.json package-lock.json ./
# 契约包（@ftm/contracts）是 backend 的 workspace 依赖：manifest 要先进来，
# npm ci 才会把 node_modules/@ftm/contracts 这条 symlink 建出来。
COPY packages/contracts/package.json ./packages/contracts/
COPY backend/package.json ./backend/
COPY backend/prisma ./backend/prisma
RUN npm ci --workspace=@ftm/backend --workspace=@ftm/contracts --include-workspace-root
RUN cd backend && npx prisma generate
COPY tsconfig.base.json ./
# 先编契约包再编后端：后端 tsconfig 里有指向它的项目引用，dist 不在就编不过。
COPY packages ./packages
RUN npm run build --workspace=@ftm/contracts
COPY backend ./backend
RUN cd backend && npm run build

FROM node:${NODE_VERSION} AS runner
RUN apk add --no-cache tini curl openssl font-noto-cjk &&     addgroup -g 1001 ftm && adduser -D -u 1001 -G ftm ftm
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=4000
COPY --from=builder /app/backend/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
# node_modules/@ftm/contracts 是指向 ../../packages/contracts 的 workspace symlink，
# 运行时真要去那儿加载 dist —— 不把目标一起带进 runner，这条链接就是断的，
# 启动时 ERR_MODULE_NOT_FOUND。
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/backend/prisma ./prisma
COPY --from=builder /app/backend/package.json ./package.json
RUN chown -R ftm:ftm /app
USER ftm
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD curl -fsS http://localhost:4000/readyz || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]

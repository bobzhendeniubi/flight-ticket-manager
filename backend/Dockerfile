ARG NODE_VERSION=22-alpine

FROM node:${NODE_VERSION} AS builder
WORKDIR /app
RUN apk add --no-cache openssl
COPY package.json package-lock.json ./
COPY backend/package.json ./backend/
COPY backend/prisma ./backend/prisma
RUN npm ci --workspace=@ftm/backend --include-workspace-root
RUN cd backend && npx prisma generate
COPY backend ./backend
COPY tsconfig.base.json ./
RUN cd backend && npm run build
# C-28：生产镜像不该带 devDependencies（tsc/eslint/vitest 等构建期工具，运行时用不到，
# 只会增加体积和攻击面）。构建产物已经落盘，这里原地裁掉 devDependencies 再拷给 runner；
# prisma generate 的产物（node_modules/.prisma、node_modules/@prisma/client）是生产依赖，不受影响。
# mkdir 是防呆：npm workspaces 偶尔会把某个包解析到 backend/node_modules 而不是提升到根
# node_modules（比如这次 @fastify/jwt 10.x 就没被提升），下面 runner 阶段两处 node_modules
# 都要拷，否则线上会缺模块；先保证目录一定存在，runner 的 COPY 才不会因为它不存在而报错。
RUN npm prune --omit=dev --workspace=@ftm/backend --include-workspace-root \
    && mkdir -p backend/node_modules

FROM node:${NODE_VERSION} AS runner
RUN apk add --no-cache tini curl openssl font-noto-cjk &&     addgroup -g 1001 ftm && adduser -D -u 1001 -G ftm ftm
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=4000
COPY --from=builder /app/backend/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/backend/node_modules ./node_modules
COPY --from=builder /app/backend/prisma ./prisma
COPY --from=builder /app/backend/package.json ./package.json
RUN chown -R ftm:ftm /app
USER ftm
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD curl -fsS http://localhost:4000/readyz || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]

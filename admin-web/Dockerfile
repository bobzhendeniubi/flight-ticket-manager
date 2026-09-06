# 世途旅行 admin-web —— 运营/管理员端
ARG NODE_VERSION=22-alpine

FROM node:${NODE_VERSION} AS builder
WORKDIR /app
COPY package.json package-lock.json ./
# 契约包（@ftm/contracts）是 admin-web 的 workspace 依赖：manifest 要先进来，
# npm ci 才会把 node_modules/@ftm/contracts 这条 symlink 建出来。
COPY packages/contracts/package.json ./packages/contracts/
COPY admin-web/package.json ./admin-web/
RUN npm ci --workspace=@ftm/admin-web --workspace=@ftm/contracts --include-workspace-root
COPY tsconfig.base.json ./
# 先编契约包：admin-web 的 tsc -b 有指向它的项目引用，dist 不在就编不过。
COPY packages ./packages
RUN npm run build --workspace=@ftm/contracts
COPY admin-web ./admin-web
ARG VITE_API_BASE=/api
ENV VITE_API_BASE=$VITE_API_BASE
WORKDIR /app/admin-web
RUN npm run build

FROM nginx:1.27-alpine AS runner
RUN rm -rf /usr/share/nginx/html/*
COPY --from=builder /app/admin-web/dist /usr/share/nginx/html
COPY admin-web/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -qO- http://127.0.0.1/ >/dev/null || exit 1

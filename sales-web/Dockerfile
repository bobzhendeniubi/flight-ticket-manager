# 世途旅行 sales-web —— 客户/代理端
# 多阶段：builder 用 Node 编译，runner 用 nginx 静态托管
ARG NODE_VERSION=22-alpine

FROM node:${NODE_VERSION} AS builder
WORKDIR /app
COPY package.json package-lock.json ./
# 契约包（@ftm/contracts）是 sales-web 的 workspace 依赖：manifest 要先进来，
# npm ci 才会把 node_modules/@ftm/contracts 这条 symlink 建出来。
COPY packages/contracts/package.json ./packages/contracts/
COPY sales-web/package.json ./sales-web/
RUN npm ci --workspace=@ftm/sales-web --workspace=@ftm/contracts --include-workspace-root
COPY tsconfig.base.json ./
# 先编契约包：sales-web 的 tsc -b 有指向它的项目引用，dist 不在就编不过。
COPY packages ./packages
RUN npm run build --workspace=@ftm/contracts
COPY sales-web ./sales-web
# 允许构建时注入 API base URL
ARG VITE_API_BASE=/api
ENV VITE_API_BASE=$VITE_API_BASE
WORKDIR /app/sales-web
RUN npm run build

FROM nginx:1.27-alpine AS runner
RUN rm -rf /usr/share/nginx/html/*
COPY --from=builder /app/sales-web/dist /usr/share/nginx/html
COPY sales-web/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -qO- http://127.0.0.1/ >/dev/null || exit 1

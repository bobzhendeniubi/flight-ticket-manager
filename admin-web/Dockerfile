# 世途旅行 admin-web —— 运营/管理员端
ARG NODE_VERSION=22-alpine

FROM node:${NODE_VERSION} AS builder
WORKDIR /app
COPY package.json package-lock.json ./
COPY admin-web/package.json ./admin-web/
RUN npm ci --workspace=@ftm/admin-web --include-workspace-root
COPY admin-web ./admin-web
COPY tsconfig.base.json ./
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

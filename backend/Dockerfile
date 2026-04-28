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

FROM node:${NODE_VERSION} AS runner
RUN apk add --no-cache tini curl openssl &&     addgroup -g 1001 ftm && adduser -D -u 1001 -G ftm ftm
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=4000
COPY --from=builder /app/backend/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/backend/prisma ./prisma
COPY --from=builder /app/backend/package.json ./package.json
RUN chown -R ftm:ftm /app
USER ftm
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD curl -fsS http://localhost:4000/readyz || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]

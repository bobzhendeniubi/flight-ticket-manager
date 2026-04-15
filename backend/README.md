# @ftm/backend

Fastify + TypeScript + Prisma API for the Flight Ticket Manager platform.

## Local development

Prereqs: Node 20+, Docker, npm.

```bash
# From the monorepo root:
npm install
docker compose up -d postgres redis
cp backend/.env.example backend/.env
# edit backend/.env if you want custom JWT secrets (defaults work for dev)

cd backend
npx prisma migrate dev          # apply schema migrations
npm run prisma:seed             # create admin/customer/agent + sample flights
npm run dev                     # start on http://localhost:4000
```

Dev credentials from the seed:

| Role     | Email                | Password        |
|----------|----------------------|-----------------|
| ADMIN    | `admin@ftm.local`    | `Password123!`  |
| CUSTOMER | `customer@ftm.local` | `Password123!`  |
| AGENT    | `agent@ftm.local`    | `Password123!`  |

## Routes (M1 Foundation)

| Method | Path             | Auth    | Description                              |
|--------|------------------|---------|------------------------------------------|
| GET    | `/`              | -       | Service info                             |
| GET    | `/healthz`       | -       | Liveness                                 |
| GET    | `/readyz`        | -       | Readiness (checks Postgres + Redis)      |
| POST   | `/auth/register` | -       | Email/password registration              |
| POST   | `/auth/login`    | -       | Email/password login                     |
| POST   | `/auth/refresh`  | -       | Rotate refresh token → new access token  |
| POST   | `/auth/logout`   | -       | Revoke refresh token                     |
| GET    | `/users/me`      | Bearer  | Current authenticated user               |

WeChat OAuth is stubbed — env vars exist but the endpoint is not yet implemented (blocked on open question #19: WeChat service account).

## Scripts

```bash
npm run dev                 # tsx watch
npm run build               # tsc to dist/
npm start                   # run compiled dist/
npm run typecheck           # tsc --noEmit
npm run prisma:migrate      # create + apply migration (dev)
npm run prisma:generate     # regenerate Prisma client
npm run prisma:studio       # open Prisma Studio
npm run prisma:seed         # run prisma/seed.ts
```

## Project layout

```
backend/
├── prisma/
│   ├── schema.prisma        # Multi-domain schema (M1 #1)
│   └── seed.ts
└── src/
    ├── index.ts             # Entrypoint (signal handling, listen)
    ├── app.ts               # Fastify build — plugins, routes
    ├── config/env.ts        # Zod-validated env
    ├── db/
    │   ├── prisma.ts
    │   └── redis.ts
    ├── lib/
    │   ├── errors.ts        # AppError + subclasses
    │   ├── password.ts      # argon2id
    │   └── tokens.ts        # opaque refresh token + sha256
    ├── plugins/
    │   ├── auth.ts          # JWT verify + requireRole RBAC
    │   └── error-handler.ts # Maps AppError/ZodError → HTTP
    └── modules/
        ├── auth/            # register, login, refresh, logout
        ├── users/           # /me
        └── health/          # /healthz, /readyz
```

## Architecture notes

- **Passwords**: argon2id with 19 MiB memoryCost, timeCost=2. Re-benchmark on prod hardware.
- **Access tokens**: JWT HS256 signed with `JWT_ACCESS_SECRET`, 1h TTL by default.
- **Refresh tokens**: opaque 48-byte base64url, stored as sha256 hash in `RefreshToken`. Rotated on every `/auth/refresh` (old token revoked, new one issued).
- **Rate limiting**: Redis-backed, 100 req/min per `ip:path`. Tighten auth-route limits before prod.
- **Prisma**: Decimal columns for monetary values (CNY, 2 dp). Source of truth for inventory lives here; Redis is a cache.
- **OpenSearch** is referenced in PRD §12.3 but commented out in `docker-compose.yml` until flight/hotel search lands in M2.

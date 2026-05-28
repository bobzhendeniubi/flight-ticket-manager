# Flight Ticket Manager / 机票预订管理系统

A full-stack travel booking platform — WeChat Mini-Program + responsive web sales portal + desktop admin panel.

## What This System Does

Customers book customized flights, hotels, airport transfers, visa services, and bundled packages. Internal staff manage inventory, orders, and agents through a web admin panel. A rule-based dynamic pricing engine applies ABCD date-tier and cabin multipliers.

## Repository Structure

```
flight-ticket-manager/
├── docs/                   # PRD, architecture, user manual, test guides
├── sales-web/              # React + Vite web app (customer-facing, desktop + mobile)
├── miniprogram/            # WeChat Mini-Program (Taro/React, shares logic with sales-web)
├── admin-web/              # React + Vite + Tailwind admin panel (desktop, staff/agent)
├── backend/                # API server (Node.js Fastify) + Prisma + BullMQ worker
├── ml-pricing/             # placeholder — pricing is currently rule-based in backend/
├── infra/                  # Docker Compose deployment (infra/staging)
└── scripts/                # ops / deploy helper scripts
```

## User Roles

| Role | Surface | Capabilities |
|------|---------|-------------|
| Guest / Customer | sales-web, mini-program | Search, book, pay, view orders |
| Agent | sales-web, mini-program, admin-web | Customer features + team/sub-agents, commission reconciliation, prepayment, order/customer management (no cost/finance) |
| Staff / Ops | admin-web | Order processing, ticketing, inventory management |
| Admin | admin-web | Full access including pricing, agent management, reporting |

## Product Catalog

- **Flights** — self-managed, own flight numbers and schedules
- **Hotels** — room-type inventory and pricing
- **Airport Transfers** — vehicle types, pickup logic, pricing
- **Visas** — document upload, progress tracking, delivery
- **Bundles** — all-inclusive packages (e.g. Da Nang) with room-sharing allocation

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Sales Web | React 18 + Vite, Tailwind CSS, Zustand, react-i18next |
| Mini-Program | Taro (React) |
| Admin Web | React 18 + Vite, Tailwind CSS |
| Backend API | Node.js (Fastify 5), Zod validation, Pino logging |
| ORM / DB | Prisma 5 → PostgreSQL (self-hosted, Docker) |
| Cache / Sessions / Queue | Redis (ioredis) + BullMQ worker |
| Auth | JWT access/refresh tokens, argon2 password hashing |
| Search | PostgreSQL queries (no dedicated search engine) |
| File Storage | Data-URL in PostgreSQL (passport photos, payment proofs); object storage not yet wired |
| Dynamic Pricing | Rule-based ABCD date tiers + cabin multipliers (ML pipeline not built) |
| Excel Export | ExcelJS (PNR + finance reconciliation) |
| OCR | tesseract.js (in-browser, client-side); server-side OCR planned |
| AI Assistant | OpenAI-compatible SDK (DeepSeek), offline mock fallback |
| Infrastructure | Docker Compose (backend / worker / postgres / redis / sales-web / admin-web); staging on Alibaba Cloud HK |

## Documentation

- [PRD — Product Requirements](docs/PRD.md)
- [System Architecture](docs/architecture.md)
- [Deployment Guide](docs/DEPLOYMENT.md)
- [使用手册 — User Manual (中文)](docs/使用手册.md)
- [功能清单 — Feature List & Launch Timeline (中文)](docs/功能清单.md)
- [测试指南 — Beta Test Guides (中文)](docs/测试指南-操作测试.md)
- [Open Questions Tracker](docs/open-questions.md)
- [Backend README](backend/README.md)
- [Sales-web README](sales-web/README.md)

## Quick start (M1 Foundation)

```bash
# One-time
npm install                          # installs all workspaces
docker compose up -d postgres redis  # local Postgres + Redis
cp backend/.env.example backend/.env

cd backend
npx prisma migrate dev               # apply schema
npm run prisma:seed                  # admin/customer/agent + sample flights

# Two terminals:
cd backend && npm run dev            # :4000
cd sales-web && npm run dev          # :5173 (proxies /api → :4000)
```

Log in at http://localhost:5173/login with `admin@ftm.local` / `Password123!`.

## Development Phases

| Milestone | Scope |
|-----------|-------|
| M1 — Foundation | DB schema, auth, API skeleton, Docker baseline |
| M2 — Sales MVP | Flight search → order → pay (web + mini-program), OCR |
| M3 — Product Expansion | Hotels, transfers, visas |
| M4 — Admin Panel | Order mgmt, inventory, agent reconciliation |
| M5 — Dynamic Pricing | Rule-based ABCD date tiers + cabin multipliers, admin UI (ML deferred) |
| M6 — Polish & Launch | Testing, security audit, CI/CD, go-live |

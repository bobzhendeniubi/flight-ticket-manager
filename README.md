# Flight Ticket Manager / 机票预订管理系统

A full-stack travel booking platform — WeChat Mini-Program + responsive web sales portal + desktop admin panel.

## What This System Does

Customers book customized flights, hotels, airport transfers, and visa services. Internal staff manage inventory, orders, and agents through a web admin panel. An ML-powered dynamic pricing engine manages ABCD-tier pricing and seasonality.

## Repository Structure

```
flight-ticket-manager/
├── docs/                   # PRD, architecture, API design, DB schema
├── sales-web/              # React responsive web app (customer-facing, desktop + mobile)
├── miniprogram/            # WeChat Mini-Program (Taro/React, shares logic with sales-web)
├── admin-web/              # React + Ant Design admin panel (desktop, staff only)
├── backend/                # API server (Node.js Fastify or Python FastAPI)
├── ml-pricing/             # Python dynamic pricing ML module
└── infra/                  # AWS CDK / Terraform infrastructure as code
```

## User Roles

| Role | Surface | Capabilities |
|------|---------|-------------|
| Guest / Customer | sales-web, mini-program | Search, book, pay, view orders |
| Agent | sales-web, mini-program | Same as customer + view all own orders, commission reconciliation, prepayment offset |
| Staff / Ops | admin-web | Order processing, ticketing, inventory management |
| Admin | admin-web | Full access including pricing, agent management, reporting |

## Product Catalog

- **Flights** — self-managed, own flight numbers and schedules
- **Hotels** — room inventory with PMS integration
- **Airport Transfers** — vehicle types, pickup logic, pricing
- **Visas** — document upload, progress tracking, delivery

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Sales Web | React + Vite, Tailwind CSS |
| Mini-Program | Taro (React) |
| Admin Web | React + Ant Design Pro |
| Backend API | Node.js (Fastify) |
| Transactional DB | PostgreSQL (AWS RDS) |
| Cache / Sessions | Redis (AWS ElastiCache) |
| Search | Elasticsearch (AWS OpenSearch) |
| File Storage | AWS S3 |
| Dynamic Pricing ML | Python (scikit-learn, Prophet) |
| Infrastructure | AWS (ECS, RDS, ElastiCache, CloudFront, S3) |
| OCR | Tesseract → AWS Textract (v2) |

## Documentation

- [PRD — Product Requirements](docs/PRD.md)
- [System Architecture](docs/architecture.md)
- [Open Questions Tracker](docs/open-questions.md)

## Development Phases

| Milestone | Scope |
|-----------|-------|
| M1 — Foundation | DB schema, auth, API skeleton, AWS baseline |
| M2 — Sales MVP | Flight search → order → pay (web + mini-program), OCR |
| M3 — Product Expansion | Hotels, transfers, visas |
| M4 — Admin Panel | Order mgmt, inventory, agent reconciliation |
| M5 — Dynamic Pricing | ML pipeline, ABCD tiers, admin UI |
| M6 — Polish & Launch | Testing, security audit, CI/CD, go-live |

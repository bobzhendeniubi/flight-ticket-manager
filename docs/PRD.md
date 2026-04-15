# Product Requirements Document
# Flight Ticket Manager / 机票预订管理系统

**Version:** 0.2 (refined)
**Last updated:** 2026-04-14
**Status:** Draft — open questions tracked in [open-questions.md](open-questions.md)

---

## Table of Contents
1. [Project Overview](#1-project-overview)
2. [User Roles & Permissions](#2-user-roles--permissions)
3. [Sales Surfaces](#3-sales-surfaces)
4. [Product Catalog](#4-product-catalog)
5. [Order & Booking Flow](#5-order--booking-flow)
6. [Payment & Reconciliation](#6-payment--reconciliation)
7. [Admin Web Panel](#7-admin-web-panel)
8. [Dynamic Pricing Module](#8-dynamic-pricing-module)
9. [Agent Portal](#9-agent-portal)
10. [Authentication & Authorization](#10-authentication--authorization)
11. [Backend Processing & Delivery](#11-backend-processing--delivery)
12. [Multi-Database Architecture](#12-multi-database-architecture)
13. [AWS Deployment Architecture](#13-aws-deployment-architecture)
14. [Non-Functional Requirements](#14-non-functional-requirements)
15. [Exception Handling](#15-exception-handling)
16. [Extension Features (Post-MVP)](#16-extension-features-post-mvp)

---

## 1. Project Overview

A customized travel booking platform serving customers and travel agents. The company operates its own flight routes (own flight numbers and schedules — no GDS dependency) and sells bundled travel products including flights, hotels, airport transfers, and visas.

### System Components

| Component | Description | Audience |
|-----------|-------------|----------|
| `sales-web` | Responsive React web app (desktop + mobile browser) | Customers, Agents |
| `miniprogram` | WeChat Mini-Program (Taro/React, shares business logic) | Customers, Agents |
| `admin-web` | React + Ant Design desktop web admin panel | Staff, Ops, Admin |
| `backend` | Node.js (Fastify) REST API + WebSocket for real-time updates | All surfaces |
| `ml-pricing` | Python ML service for dynamic pricing (ABCD tiers + seasonality) | Internal |
| `infra` | AWS CDK infrastructure as code | DevOps |

---

## 2. User Roles & Permissions

### Role Definitions

**Guest / Customer**
- Self-registered via WeChat OAuth or email
- Can search, book, and pay for all product types
- Can view and manage own orders
- Can save passenger profiles for quick re-use

**Agent (代理人)**
- Registered by admin; receives login credentials
- Can book on behalf of clients
- Has a prepayment balance account with the company
- Can offset payment against prepayment balance
- Can view commission earnings and request settlements
- Can share itineraries with clients via SMS/WeChat

**Staff / Ops (票务人员 / 运营)**
- Admin-web only
- Processes orders: ticketing, hotel confirmation, transfer arrangement, visa submission
- Uploads e-tickets (ETKT) and PNR codes to orders
- Cannot modify pricing or agent accounts

**Admin (管理员)**
- Full access to admin-web
- Manages product catalog (flights, hotels, transfers, visas)
- Manages agent accounts and prepayment balances
- Configures dynamic pricing tiers
- Views all reports and financial data

---

## 3. Sales Surfaces

### 3.1 Sales Web App (`sales-web`)

- React + Vite, Tailwind CSS
- Responsive: fully functional on desktop browser and mobile browser
- Shares core booking logic with the mini-program via a shared library
- Accessible at company domain (e.g., `book.example.com`)

### 3.2 WeChat Mini-Program (`miniprogram`)

- Built with Taro (React-compatible cross-platform framework)
- Runs inside WeChat on iOS and Android (12.0+ / 8.0+)
- Adapts to 320px–480px screen widths
- Supports dark mode
- Uses WeChat OAuth for login (no separate registration needed)

### 3.3 Shared UI Behavior (Both Surfaces)

**Homepage / Search Page**
- Trip type toggle: one-way / round-trip / multi-city
- Origin/destination selector:
  - Pinyin initial search (e.g., type "BJ" → Beijing)
  - Recent search history (local cache)
  - Field state preserved on page exit/return (crash recovery)
- Date picker: dual-calendar, shows next 30 days by default
- Passenger selector: adults / children / infants count
- Main search CTA button
- Tab navigation below search: Flights | Hotels | Transfers | Visas

**Flight List Page**
- Card layout per flight:
  - Airline logo + flight number
  - Departure/arrival airport (with terminal)
  - Departure/arrival time (with date-change indicator + timezone note)
  - Flight duration
  - On-time rate badge
  - Adult price / child price / total with taxes
  - "Real-time pricing" label
  - "Select" button (with low-stock warning when seats < 10)
- Filter panel: departure time range, arrival time range, cabin class, number of stops
- _(Post-MVP: 7-day low price trend chart — see open-questions #4)_

**Hotel Cards (horizontal scroll)**
- Hotel name, star rating, user score
- Distance from airport / city center
- Lowest price today (with "Today's Special" tag if applicable)

**Visa Entry Card**
- Destination visa processing time
- Base price
- "Express processing" option

---

## 4. Product Catalog

### 4.1 Flights

- **Self-managed inventory** — no GDS. Company operates own routes with own flight numbers and schedules.
- Admin creates/manages flights in admin-web: route, schedule, aircraft type, seat classes, base capacity
- Seat inventory tracked in Redis (real-time) + PostgreSQL (source of truth)
- Pricing set via Dynamic Pricing Module (see Section 8)
- Supports cabin classes: Economy / Business / First
- Supports special service requests (SSR): special meals, wheelchair, infant bassinet — selectable at order time

### 4.2 Hotels

- Admin manages hotel catalog: name, location, star rating, room types, photos
- Room inventory: manual management in admin-web with optional PMS import template
- _(See open-questions #18 on PMS integration)_
- Alerts when remaining rooms < 3

### 4.3 Airport Transfers

- Admin manages vehicle catalog: type, capacity, base price, routes served
- Customer selects: pickup location, dropoff location, date/time, vehicle type
- Confirmation sent to customer after staff assigns driver
- _(Full spec needed before M3 — see open-questions #6)_

### 4.4 Visas

- Admin manages visa products by destination country: required documents, processing time, price, express surcharge
- Customer uploads: passport photo, passport scan, additional documents
- OCR auto-populates fields from passport scan (Tesseract → AWS Textract in v2)
- Staff tracks progress: received → submitted to embassy → approved → delivered
- Delivery: electronic (email) or physical (courier with tracking)

---

## 5. Order & Booking Flow

### 5.1 Passenger Information Entry

- Supports 1–9 passengers per order
- Fields per passenger:
  - Full name (as on travel document)
  - Document type: ID card (居民身份证) / Passport
  - Document number (with format validation)
  - Date of birth
  - Nationality
  - Passenger type: Adult / Child / Infant
- **OCR passport scan**: camera capture or upload → Tesseract extracts name, DOB, nationality, passport number, expiry → auto-fills fields (user can edit)
- Saved passenger profiles: user can store frequent travelers for 1-tap re-fill
- SSR selection per passenger: meal preference, wheelchair, infant bassinet

### 5.2 Contact Information

- Primary contact name, phone number, email
- Phone verified via SMS OTP

### 5.3 Add-On Selection

- Checkboxes for: Hotel, Airport Transfer, Visa
- Each add-on opens an inline configuration panel
- Price summary updates in real-time as selections change

### 5.4 Price Breakdown Display

| Line Item | Notes |
|-----------|-------|
| Flight — adult × N | Per-seat price × count |
| Flight — child × N | Per-seat price × count |
| Airport construction fee | Per passenger |
| Fuel surcharge | Per passenger |
| Insurance (optional) | Selectable add-on |
| Hotel | If selected |
| Transfer | If selected |
| Visa | If selected |
| Coupon discount | If applied |
| Transfer (airport car) | Bundle default for some packages |
| **Total (CNY)** | In digits + Chinese capitals (大写金额) |

### 5.5 Agreement Confirmation

- Required checkboxes (cannot proceed without): Service Agreement, Privacy Policy, Refund & Change Rules
- Tap to open full text in modal

### 5.6 Order State Machine

```
DRAFT → PENDING_PAYMENT → PAYMENT_TIMEOUT (→ CANCELLED)
                        → PAID → PROCESSING → TICKETED → COMPLETED
                                            → REFUND_REQUESTED → REFUNDED
                                            → CHANGE_REQUESTED → CHANGED
```

- Draft: saved in Redis, 24-hour TTL
- Payment window: 15-minute countdown timer; auto-cancel + seat release on expiry
- Processing: staff receives notification and begins ticketing/confirmation

---

## 6. Payment & Reconciliation

### 6.1 Payment Methods

| Method | Notes |
|--------|-------|
| WeChat Pay | Primary; requires verified merchant account |
| Alipay | Secondary |
| Bank card (quick pay) | Via payment gateway |
| Agent prepayment offset | Deducts from agent's prepayment balance (virtual) |

- Display channel-specific promotions (e.g., "WeChat Pay random discount")
- Payment status webhook from payment gateway triggers order state transition

### 6.2 Agent Prepayment Offset

- Agents have a prepayment balance deposited with the company
- At checkout, agent can choose "Offset with prepayment balance" for full or partial payment
- The system deducts from agent's balance in PostgreSQL atomically (transaction-safe)
- _(See open-questions #3 on approval workflow)_

### 6.3 Commission Reconciliation

- Company configures commission % per product type per agent (in admin-web)
- Commission is accrued when order reaches `COMPLETED` state
- Agent views commission statement in agent portal
- Agent requests settlement; admin reviews and approves; payout is recorded
- _(See open-questions #2 for commission % rules)_

### 6.4 Payment Result Page

**Success:**
- Order number, itinerary summary, e-ticket number
- Buttons: View Order Details | Share Itinerary (SMS + WeChat) | Back to Home

**Failure:**
- Error message
- Buttons: Retry Payment | Contact Support

---

## 7. Admin Web Panel

Desktop-only web application. React + Ant Design Pro.

### 7.1 Dashboard / Home

- Summary cards: today's new orders, revenue, pending actions (orders requiring ticketing)
- Notifications feed (visible to all staff): system alerts, inventory warnings, delivery failures
- Quick navigation links

### 7.2 Order Management

- Table view: searchable, filterable by status/date/product/agent
- Order detail view:
  - Full passenger list
  - Product details (flight, hotel, transfer, visa)
  - Payment info (method, amount, transaction ID)
  - Timeline of status changes
- Actions per order (role-permissioned):
  - Upload PNR / ETKT (staff)
  - Mark hotel confirmed / transfer assigned / visa submitted
  - Trigger re-delivery of confirmation (email/SMS/WeChat)
  - Initiate refund / change workflow
  - Manual override of order status (admin only)

### 7.3 Product Management

**Flights**
- CRUD: create/edit/deactivate routes and schedules
- Manage seat classes and base capacity per flight
- View seat availability calendar

**Hotels**
- CRUD: hotel catalog, room types, photos, amenity tags
- Adjust room inventory per date (manual or import via template)

**Transfers**
- CRUD: vehicle types, routes, pricing

**Visas**
- CRUD: destination countries, required docs checklist, prices, processing time

### 7.4 Inventory Dashboard

- Flight seat availability: calendar heatmap view
- Hotel room availability: grid per date per room type
- Low-inventory alerts: seats < 20 → warning; rooms < 3 → warning
- Alert delivery: SMS + WeChat service notification to configurable recipients

### 7.5 Agent Management

- Create/edit agent accounts
- Set commission rates per product type
- View and adjust prepayment balance (top-up / deduct)
- View agent order history and commission statement
- Approve/reject commission settlement requests

### 7.6 Notifications Center

- View all outbound notifications (SMS, email, WeChat) with delivery status
- Manual re-trigger for failed deliveries
- Configure alert recipients (for inventory warnings, system errors)

### 7.7 Reports (Admin only)

- Revenue by period / product type / agent
- Booking volume trends
- Refund/change rate by route
- Agent commission summary

---

## 8. Dynamic Pricing Module

### 8.1 ABCD Tier Model

Each flight has a configurable price tier structure. Admin defines thresholds and multipliers:

| Tier | Trigger Condition (example) | Price Rule |
|------|----------------------------|-----------|
| A | Seats remaining > 70%, > 30 days out | Base price × 1.0 |
| B | Seats remaining 40–70% or 15–30 days out | Base price × 1.15 |
| C | Seats remaining 20–40% or 7–15 days out | Base price × 1.30 |
| D | Seats remaining < 20% or < 7 days out (peak) | Base price × 1.50 |

_(Exact thresholds and multipliers to be defined — see open-questions #16)_

Admin can manually override any flight's current tier in admin-web.

### 8.2 ML Pricing Model

- **Time-series / seasonality component**: Facebook Prophet model trained on historical booking volume and price data. Outputs demand multiplier per route × date combination.
- **Gradient boosting model**: Features include days-to-departure, load factor, day-of-week, holiday flags, competitor signals (if available). Outputs recommended price.
- Models retrained weekly (batch job on AWS).
- **Fallback**: if ML service unavailable, revert to rule-based ABCD tier only.

### 8.3 Pricing API

- `GET /pricing/{flight_id}?date={date}&cabin={cabin}` → returns current tier + price
- Result cached in Redis with 15-minute TTL
- On cache miss: compute from ML service + tier rules → store in Redis
- Price shown to customer has a "real-time pricing" label and refreshes every 15 minutes during session

### 8.4 Admin Pricing UI

- Per-flight pricing configuration: base price, tier thresholds, multipliers
- Current tier indicator per flight with manual override button
- Price history chart: 30-day price trend per flight
- Batch pricing update: upload CSV to update base prices for multiple flights

---

## 9. Agent Portal

Accessible via same sales-web / mini-program as customers, with additional tabs unlocked by agent role.

### 9.1 My Orders Tab

- List of all orders placed by this agent
- Filter by status, date, product type
- Export to Excel/CSV

### 9.2 Prepayment Balance Tab

- Current balance (CNY)
- Transaction history: top-ups + deductions
- Statement download (PDF)

### 9.3 Commission Tab

- Accrued commission (pending settlement)
- Settled commission history
- Settlement request button (triggers admin review workflow)
- Commission detail: per order breakdown

### 9.4 Share Itinerary

- On payment success page: "Share to client" button
- Generates a summary card (flight info, hotel, pickup time) shared via:
  - WeChat (mini-program card or message)
  - SMS (plain text summary with order reference)

---

## 10. Authentication & Authorization

### 10.1 Customer Login (sales-web + mini-program)

- **WeChat OAuth**: click "Login with WeChat" → get openid → create or find user record → issue JWT
- **Email/password** (sales-web only): registration + email verification link
- JWT access token (1-hour TTL) + refresh token (30-day TTL)

### 10.2 Admin / Agent / Staff Login

- Email + password only (admin-web and sales-web agent tab)
- Admin-web protected behind separate subdomain (e.g., `admin.example.com`)
- JWT with role claim: `admin` | `staff` | `agent`
- Session invalidated on password change

### 10.3 Security

- HTTPS everywhere
- Passport scan files stored in S3 with AES-256 server-side encryption (SSE-KMS)
- Sensitive operations require re-authentication (e.g., agent withdrawal request, admin balance adjustment) _(see open-questions #10)_
- Anti-duplicate-submit: idempotency key on order creation
- RBAC enforced at API layer, not just UI
- Rate limiting on auth endpoints (Redis-based)

---

## 11. Backend Processing & Delivery

### 11.1 Ticketing Workflow

1. Order reaches `PAID` state → system sends SMS notification to ticketing staff
2. Staff opens order in admin-web → books seat with airline system → obtains PNR
3. Staff uploads PNR + ETKT to order record
4. System automatically notifies customer:
   - WeChat service message
   - Email with e-ticket attached
   - SMS with ticket number and PNR
5. Customer can download e-ticket from order detail page in mini-program/web

### 11.2 Hotel Confirmation Workflow

1. Order with hotel reaches `PAID` → staff notified
2. Staff confirms room reservation → marks hotel as confirmed in admin-web
3. Customer receives confirmation notification

### 11.3 Transfer Workflow

1. Transfer booking → staff assigns driver/vehicle
2. Customer receives pickup details (time, vehicle, driver contact)
3. Day-before reminder notification sent automatically

### 11.4 Visa Processing Workflow

1. Customer uploads documents → staff reviews completeness
2. Staff submits to visa center → status updated: submitted
3. Key milestone notifications: submission confirmed, interview scheduled (if needed), approved, dispatched
4. Electronic visa: auto-sent to email
5. Physical visa: courier tracking number added to order; customer can track

### 11.5 Refund & Change Handling

- Customer requests refund/change from order detail page
- System calculates fee based on cabin class + days to departure rules (configurable per product)
- Staff reviews and processes in admin-web
- Refund issued back via original payment channel
- Change: new itinerary re-sent to customer

### 11.6 Delivery Failure Handling

- All notification sends are retried up to 3 times
- Failed deliveries appear in admin Notifications Center for manual re-trigger
- Customer service can manually push any notification from order detail

---

## 12. Multi-Database Architecture

### 12.1 PostgreSQL (AWS RDS, Multi-AZ)

Primary transactional store. Key tables:

| Schema | Tables |
|--------|--------|
| `users` | users, auth_tokens, saved_passengers |
| `agents` | agents, prepayment_transactions, commission_rules, commission_records |
| `products` | flights, flight_schedules, hotels, hotel_rooms, transfers, visas |
| `inventory` | flight_seat_classes, hotel_room_dates (source of truth, Redis is cache) |
| `orders` | orders, order_items, passengers, order_status_events |
| `payments` | payments, refunds |
| `notifications` | notification_log |
| `pricing` | pricing_configs, tier_overrides, price_history |

### 12.2 Redis (AWS ElastiCache, Cluster Mode)

| Key Pattern | TTL | Contents |
|-------------|-----|----------|
| `session:{user_id}` | 1h | JWT session data |
| `price:{flight_id}:{date}:{cabin}` | 15 min | Current price + tier |
| `inventory:seats:{flight_id}:{date}:{class}` | 0 (real-time) | Available seat count |
| `inventory:rooms:{hotel_id}:{date}:{type}` | 5 min | Available room count |
| `draft:{draft_order_id}` | 24h | Draft order JSON |
| `rate_limit:{ip}:{endpoint}` | 1 min | Request count |
| `idempotency:{key}` | 24h | Order creation dedup |

### 12.3 Elasticsearch / AWS OpenSearch

- `flights` index: searchable by route, date, price range, cabin, stops
- `hotels` index: searchable by location, star rating, price, amenities
- Synced from PostgreSQL via CDC (Change Data Capture) or scheduled job

### 12.4 AWS S3

| Bucket / Prefix | Contents | Encryption |
|----------------|----------|-----------|
| `uploads/passports/` | Passport scans (delete after order complete + 90 days) | SSE-KMS |
| `tickets/etickets/` | Generated e-ticket PDFs | SSE-S3 |
| `tickets/itineraries/` | Itinerary documents | SSE-S3 |
| `static/` | Product photos, hotel images | Public via CloudFront |

---

## 13. AWS Deployment Architecture

| Service | Usage |
|---------|-------|
| ECS Fargate | All containerized services (API, OCR, ML, notifications) |
| RDS PostgreSQL | Multi-AZ, automated backups (7-day retention) |
| ElastiCache Redis | Session + cache cluster |
| OpenSearch | Flight and hotel search |
| S3 | File storage + static assets |
| CloudFront | CDN for static assets + sales-web SPA |
| WAF | DDoS protection, rate limiting at edge |
| ECR | Container image registry |
| CodePipeline | CI/CD: build → test → staging → production |
| CloudWatch | Logs, metrics, alarms (paging on P0 errors) |
| SES | Transactional email |
| Secrets Manager | DB credentials, payment API keys |

**Regions:** Primary region TBD based on compliance review _(see open-questions #25)_

---

## 14. Non-Functional Requirements

### Performance

| Metric | Target |
|--------|--------|
| Page first load | < 3 seconds |
| Flight search response | < 1.5 seconds |
| Form submit success rate | > 99.5% |
| Payment flow completion | < 10 seconds (normal network) |
| API response time (p90) | < 500ms |
| System availability | > 99.9% |

### Security

- TLS 1.2+ on all endpoints
- Passport data: AES-256 at rest, deleted 90 days post-completion
- RBAC enforced at API layer
- OWASP Top 10 mitigations (SQL injection prevention, XSS protection, CSRF tokens)
- Anti-duplicate-submit (idempotency keys)
- Regular security audits (monthly per original PRD requirement)

### Compatibility

| Platform | Version |
|----------|---------|
| iOS (mini-program) | 12.0+ |
| Android (mini-program) | 8.0+ |
| sales-web browsers | Chrome 90+, Safari 14+, Edge 90+ |
| Admin-web browsers | Chrome 90+, Edge 90+ (desktop only) |
| Screen widths (mini-program) | 320px–480px |
| Dark mode | Mini-program: supported; sales-web: supported |

---

## 15. Exception Handling

| Scenario | Behavior |
|----------|---------|
| Network error | Show retry button; preserve all filled form data in local cache |
| Low inventory warning | Real-time "seats running out" badge when seats < 10 |
| Out of stock | Block selection; suggest nearest available flight |
| Price change at submit | Modal shows old vs. new price; user must confirm to proceed |
| Document validation error | Inline field error with specific message (e.g., "Passport number format invalid") |
| Payment timeout (15 min) | Auto-cancel order, release seat reservation, send notification, offer re-booking link |
| Delivery failure | Auto-retry × 3; escalate to admin Notifications Center for manual re-trigger |
| ML service unavailable | Graceful fallback to rule-based ABCD tier pricing |
| System maintenance | Maintenance page with customer service contact |

---

## 16. Extension Features (Post-MVP)

These are confirmed future features — **not** in scope for initial launch:

1. **Member loyalty / points system** — earn points per booking, redeem against future orders
2. **Coupon & discount codes** — admin issues codes with rules (per user, per product, expiry); pushed to user accounts
3. **Customer chatbot** — FAQ-first bot with optional live agent handoff _(spec TBD — see open-questions #7)_
4. **Multi-language (中/EN)** — i18n across sales-web and mini-program
5. **Flight status push notifications** — real-time departure/delay alerts
6. **Enterprise client API** — B2B integration for corporate travel managers
7. **Travel insurance** — integrated insurance products at checkout
8. **AWS Textract OCR upgrade** — replace Tesseract with higher-accuracy AWS managed OCR

---

_This document supersedes the original Chinese PRD "机票预订小程序开发需求说明.docx". All original requirements are incorporated; items marked 待定 in the original are tracked in [open-questions.md](open-questions.md)._

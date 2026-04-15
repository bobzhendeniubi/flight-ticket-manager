# System Architecture

## High-Level Overview

```mermaid
graph TB
    subgraph "Customer Surfaces"
        WEB[Sales Web App<br/>React Responsive]
        MP[WeChat Mini-Program<br/>Taro/React]
    end

    subgraph "Staff Surface"
        ADMIN[Admin Web Panel<br/>React + Ant Design Pro]
    end

    subgraph "Backend Services"
        API[API Server<br/>Node.js Fastify]
        OCR[OCR Service<br/>Tesseract / AWS Textract]
        ML[Pricing ML Service<br/>Python / FastAPI]
        NOTIFY[Notification Service<br/>SMS + WeChat + Email]
    end

    subgraph "Data Stores"
        PG[(PostgreSQL<br/>Transactional DB)]
        REDIS[(Redis<br/>Cache + Sessions)]
        ES[(Elasticsearch<br/>Flight Search Index)]
        S3[(AWS S3<br/>Files + E-tickets)]
    end

    subgraph "External Services"
        WXPAY[WeChat Pay]
        ALIPAY[Alipay]
        SMS[SMS Gateway]
        WECHAT[WeChat API]
    end

    WEB --> API
    MP --> API
    ADMIN --> API
    API --> PG
    API --> REDIS
    API --> ES
    API --> S3
    API --> OCR
    API --> ML
    API --> NOTIFY
    API --> WXPAY
    API --> ALIPAY
    NOTIFY --> SMS
    NOTIFY --> WECHAT
```

## Database Architecture

We use multiple databases — each optimized for its workload.

```mermaid
graph LR
    subgraph "PostgreSQL (RDS)"
        ORDERS[orders]
        PASSENGERS[passengers]
        FLIGHTS[flights / schedules]
        HOTELS[hotels / rooms]
        TRANSFERS[transfers]
        VISAS[visas]
        AGENTS[agents]
        USERS[users]
        TRANSACTIONS[transactions]
        COMMISSIONS[commissions]
    end

    subgraph "Redis (ElastiCache)"
        SESSIONS[user sessions]
        PRICE_CACHE[flight price cache<br/>15-min TTL]
        INVENTORY[seat/room inventory<br/>real-time]
        RATE_LIMIT[rate limiting]
        DRAFT_ORDERS[draft orders<br/>24h TTL]
    end

    subgraph "Elasticsearch (OpenSearch)"
        FLIGHT_IDX[flight search index]
        HOTEL_IDX[hotel search index]
    end

    subgraph "S3"
        ETICKETS[e-tickets / PDFs]
        PASSPORTS[passport scans<br/>encrypted]
        ITINERARIES[itinerary documents]
    end
```

## AWS Deployment Architecture

```mermaid
graph TB
    subgraph "Edge"
        CF[CloudFront CDN]
        WAF[AWS WAF]
    end

    subgraph "Compute - ECS Fargate"
        API_SVC[API Service]
        OCR_SVC[OCR Service]
        ML_SVC[ML Pricing Service]
        NOTIFY_SVC[Notification Service]
    end

    subgraph "Data"
        RDS[RDS PostgreSQL<br/>Multi-AZ]
        ELASTICACHE[ElastiCache Redis<br/>Cluster Mode]
        OPENSEARCH[OpenSearch<br/>Flight/Hotel Index]
        S3_BUCKET[S3 Buckets<br/>Files + Static Assets]
    end

    subgraph "DevOps"
        ECR[ECR Container Registry]
        CODEPIPELINE[CodePipeline CI/CD]
        CLOUDWATCH[CloudWatch Logs + Alarms]
    end

    CF --> WAF
    WAF --> API_SVC
    API_SVC --> RDS
    API_SVC --> ELASTICACHE
    API_SVC --> OPENSEARCH
    API_SVC --> S3_BUCKET
    API_SVC --> OCR_SVC
    API_SVC --> ML_SVC
    API_SVC --> NOTIFY_SVC
```

## Authentication & Authorization Flow

```mermaid
sequenceDiagram
    participant C as Customer (Web/MP)
    participant A as Admin/Agent
    participant API as API Server
    participant WX as WeChat OAuth
    participant JWT as JWT Service

    Note over C,WX: Customer Login (WeChat OAuth)
    C->>WX: WeChat login request
    WX-->>C: Authorization code
    C->>API: POST /auth/wechat {code}
    API->>WX: Exchange code for openid
    WX-->>API: openid + user info
    API->>JWT: Generate JWT
    JWT-->>API: access_token + refresh_token
    API-->>C: Tokens

    Note over A,JWT: Admin/Agent Login (Email + Password)
    A->>API: POST /auth/login {email, password}
    API->>JWT: Verify credentials, check RBAC role
    JWT-->>API: access_token (role-scoped)
    API-->>A: Tokens
```

## Order Flow

```mermaid
sequenceDiagram
    participant U as User
    participant API as API
    participant PG as PostgreSQL
    participant REDIS as Redis
    participant PAY as Payment Gateway
    participant NOTIFY as Notifications

    U->>API: Search flights
    API->>REDIS: Check price cache
    REDIS-->>API: Cached prices (or miss → query PG)
    API-->>U: Flight list + prices

    U->>API: Create draft order
    API->>REDIS: Store draft (24h TTL)
    API-->>U: draft_order_id

    U->>API: Submit order + payment
    API->>REDIS: Lock seats (inventory -1)
    API->>PAY: Initiate payment
    PAY-->>API: Payment result
    API->>PG: Create confirmed order
    API->>NOTIFY: Send confirmation SMS/email/WeChat
    API-->>U: Order confirmed + e-ticket

    Note over API,NOTIFY: If payment times out (15 min)
    API->>REDIS: Release seat lock
    API->>PG: Mark order cancelled
    API->>NOTIFY: Send cancellation notice
```

## Dynamic Pricing ML Architecture

```mermaid
graph LR
    subgraph "Data Inputs"
        HIST[Historical booking data]
        SEASON[Seasonality signals]
        COMP[Load factor / remaining seats]
        MANUAL[Manual ABCD tier overrides]
    end

    subgraph "ML Pipeline"
        PROPHET[Prophet<br/>Time-series seasonality]
        TS[Gradient Boosting<br/>Price prediction]
        TIER[ABCD Tier Engine<br/>Rule-based capping]
    end

    subgraph "Output"
        PRICE_API[Pricing API<br/>GET /pricing/{flight_id}]
        ADMIN_UI[Admin Override UI]
        CACHE[Redis price cache<br/>15-min TTL]
    end

    HIST --> PROPHET
    HIST --> TS
    SEASON --> PROPHET
    COMP --> TS
    PROPHET --> TIER
    TS --> TIER
    MANUAL --> TIER
    TIER --> PRICE_API
    TIER --> ADMIN_UI
    PRICE_API --> CACHE
```

## RBAC Permission Matrix

| Resource | Guest | Agent | Staff/Ops | Admin |
|----------|-------|-------|-----------|-------|
| Search & browse products | R | R | R | R |
| Place order | W | W | - | - |
| View own orders | R | R | R | R |
| View all orders | - | Own only | R | R |
| Process/ticket orders | - | - | W | W |
| Manage flight inventory | - | - | W | W |
| Manage hotel/transfer/visa | - | - | W | W |
| Agent accounts & prepayment | - | Own balance | - | W |
| Commission reports | - | Own | - | R |
| Dynamic pricing config | - | - | - | W |
| User/role management | - | - | - | W |
| System settings | - | - | - | W |

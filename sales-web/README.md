# @ftm/sales-web

Customer + agent-facing web app (React + Vite + Tailwind). Shares business logic with the WeChat mini-program (via Taro, wired in M2+).

## Local development

```bash
# From the monorepo root:
npm install
docker compose up -d postgres redis

# Terminal 1 — backend
cd backend && npm run dev                  # http://localhost:4000

# Terminal 2 — web
cd sales-web && npm run dev                # http://localhost:5173
```

Vite proxies `/api/*` → `http://localhost:4000`, so the web app calls relative URLs like `/api/auth/login`.

## Scripts

```bash
npm run dev         # Vite dev server
npm run build       # Production build (tsc -b && vite build)
npm run preview     # Serve the production build locally
npm run typecheck   # tsc -b --noEmit
```

## What's here (M1 Foundation)

- Auth flow: register / login / sign-out wired to the backend
- Protected `/me` profile page
- Persistent session via Zustand + `localStorage`
- Tailwind design tokens: `brand` color, `.btn-primary`, `.input`, `.card`

## What's coming (M2+)

- Flight search (PRD §3.3)
- Passenger info + OCR passport scanning (PRD §5.1)
- Order summary + checkout with WeChat Pay / Alipay (PRD §6)
- Agent portal: prepayment balance, commission reconciliation (PRD §9)

## Project layout

```
sales-web/
├── index.html
├── vite.config.ts         # /api proxy → :4000
├── tailwind.config.js
└── src/
    ├── main.tsx
    ├── App.tsx            # Router + route guards
    ├── components/
    │   └── Layout.tsx     # Header + footer shell
    ├── pages/
    │   ├── HomePage.tsx
    │   ├── LoginPage.tsx
    │   ├── RegisterPage.tsx
    │   └── ProfilePage.tsx
    ├── lib/
    │   └── api.ts         # Typed fetch wrapper, ApiError
    ├── stores/
    │   └── auth.ts        # Zustand store w/ persist middleware
    └── styles/
        └── index.css      # Tailwind entry + component classes
```

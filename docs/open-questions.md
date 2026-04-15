# Open Questions Tracker

Items marked `待定` or flagged in the original PRD, plus new gaps identified during design.

Status: `open` | `decided` | `blocked`

---

## Business & Product

| # | Question | Status | Owner | Decision / Notes |
|---|----------|--------|-------|-----------------|
| 1 | Should agents use the same sales-web/mini-program as customers, or have a separate agent-only portal? | open | Product | Leaning toward same app, agent role unlocks extra tabs (orders, reconciliation) |
| 2 | Commission rules: what % per product type? Fixed or variable? When does it settle? | open | Business | Need commission schedule document |
| 3 | Prepayment offset: who approves a deduction from agent balance? Is there an approval workflow? | open | Business | Need to define reconciliation SOP |
| 4 | Price trend chart (near 7-day low price curve) — is this in scope for MVP? | open | Product | Original PRD marked 待定 |
| 5 | Hotel and visa add-ons: are these booked together with flight in one checkout, or separate orders? | open | Product | Affects order data model significantly |
| 6 | Airport transfer: what vehicle types? How is pickup confirmed (driver app, SMS)? | open | Product | Full spec needed before M3 |
| 7 | Customer chatbot (Section 十 in original PRD): what scope? FAQ only, or live handoff to agent? | open | Product | Completely unspecified |
| 8 | Multi-language: Chinese + English — is this needed for MVP or post-launch? | open | Product | Original PRD Section 八 lists it as "扩展功能预留" |
| 9 | Member loyalty/points system: MVP or later? | open | Product | Listed as extension, likely post-launch |
| 10 | What counts as a "sensitive operation" requiring 2FA? (Original PRD Section 五 left this unclear) | open | Security | Suggestions: password change, large payment, agent balance withdrawal |

---

## Technical

| # | Question | Status | Owner | Decision / Notes |
|---|----------|--------|-------|-----------------|
| 11 | Payment gateway: WeChat Pay and Alipay require business registration/merchant accounts. Who handles this? | open | Business | Needed before M2 |
| 12 | SMS provider: which vendor? (Aliyun SMS, Twilio, etc.) | open | Infra | |
| 13 | Email service: AWS SES, SendGrid, or other? | open | Infra | |
| 14 | OCR passport: which fields to extract? (Name, DOB, nationality, passport number, expiry) — confirm full list | open | Product | |
| 15 | Passport scans stored on S3: encryption key management — KMS or customer-managed? | open | Security | |
| 16 | What is the ABCD tier definition? (e.g., A = base price, B = +15%, C = +30%, D = peak surcharge?) | open | Business | Needs pricing team input before M5 |
| 17 | ML training data: do we have historical booking + pricing data to train on at launch? | open | Data | If not, ABCD tier rules-only for MVP |
| 18 | Hotel PMS integration: which PMS vendor? Or do staff manage hotel inventory manually in admin? | open | Business | Manual management is simpler for MVP |
| 19 | WeChat service account for notifications: is a verified service account already set up? | open | Business | Required for order notifications |
| 20 | Domain and SSL: what domain name to use? | open | Business | |

---

## Design & UX

| # | Question | Status | Owner | Decision / Notes |
|---|----------|--------|-------|-----------------|
| 21 | Is there a Figma/design system to follow, or do we define the design from scratch? | open | Design | No design assets exist yet |
| 22 | Dark mode: required for mini-program MVP or post-launch? | open | Product | Original PRD Section 六 lists it as compatibility requirement |
| 23 | Share itinerary (agent → customer via SMS/WeChat): what does the shared page look like? | open | Design | Mentioned in original PRD Section 四 |

---

## Compliance & Legal

| # | Question | Status | Owner | Decision / Notes |
|---|----------|--------|-------|-----------------|
| 24 | WeChat Mini-Program category: travel service requires real-name business license. Is this ready? | open | Legal | Required before mini-program can go live |
| 25 | Data residency: customer passport data — any legal requirement to store in China vs. AWS international? | open | Legal | Critical for AWS region decision |
| 26 | Privacy policy and service agreement: who drafts these? | open | Legal | Required for mini-program store approval |

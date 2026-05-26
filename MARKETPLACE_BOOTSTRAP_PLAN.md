# Trust-First Local Services Marketplace Bootstrap Plan

This project is a local services marketplace inspired by the customer/provider flow of Armut.com, but it should not copy Armut's economics or product assumptions blindly. The key differentiation is provider-friendly lead economics: providers should not lose offer credits for invalid, unverified, duplicated, low-quality, or non-responsive leads.

The MVP should start narrow, with a small number of categories and data-driven request forms. Category-specific questions must be stored as configurable data, not hardcoded per category.

## 1. Recommended Monorepo Folder Structure

```txt
.
├── apps
│   ├── api
│   │   ├── src
│   │   │   ├── app.module.ts
│   │   │   ├── main.ts
│   │   │   ├── modules
│   │   │   │   ├── auth
│   │   │   │   ├── users
│   │   │   │   ├── service-categories
│   │   │   │   ├── service-request-questions
│   │   │   │   ├── service-requests
│   │   │   │   ├── phone-verification
│   │   │   │   ├── provider-profiles
│   │   │   │   ├── offers
│   │   │   │   ├── offer-credit-ledger
│   │   │   │   ├── lead-quality
│   │   │   │   └── admin-moderation
│   │   │   ├── prisma
│   │   │   └── common
│   │   │       ├── decorators
│   │   │       ├── guards
│   │   │       ├── pipes
│   │   │       └── types
│   │   ├── test
│   │   └── package.json
│   ├── web
│   │   ├── app
│   │   ├── components
│   │   ├── lib
│   │   └── package.json
│   └── admin
│       ├── app
│       ├── components
│       ├── lib
│       └── package.json
├── packages
│   ├── config
│   ├── eslint-config
│   ├── tsconfig
│   ├── ui
│   └── shared
│       ├── src
│       │   ├── enums
│       │   ├── dto
│       │   └── validation
│       └── package.json
├── prisma
│   ├── schema.prisma
│   ├── migrations
│   └── seed.ts
├── docker
│   └── postgres
├── docker-compose.yml
├── package.json
├── pnpm-workspace.yaml
├── turbo.json
├── .env.example
└── README.md
```

Recommended package ownership:

- `apps/api`: all domain logic, Prisma access, auth, moderation, offer economics.
- `apps/web`: public customer and provider-facing web experience.
- `apps/admin`: internal moderation and marketplace operations.
- `packages/shared`: shared enums, DTO shapes, Zod schemas, and TypeScript utility types.
- `packages/ui`: reusable UI primitives only when duplication appears across `web` and `admin`.
- `prisma`: single source of truth for database schema, migrations, and seed data.

## 2. Initial Prisma Schema Draft

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

enum UserRole {
  CUSTOMER
  PROVIDER
  ADMIN
}

enum PhoneVerificationStatus {
  PENDING
  VERIFIED
  FAILED
  EXPIRED
}

enum ServiceRequestStatus {
  DRAFT
  AWAITING_PHONE_VERIFICATION
  OPEN
  PAUSED
  MATCHED
  COMPLETED
  CANCELLED
  REJECTED
}

enum QuestionType {
  TEXT
  TEXTAREA
  NUMBER
  SINGLE_SELECT
  MULTI_SELECT
  BOOLEAN
  DATE
}

enum OfferStatus {
  SENT
  VIEWED
  ACCEPTED
  DECLINED
  WITHDRAWN
  EXPIRED
}

enum OfferCreditTransactionType {
  PURCHASE
  SPEND
  REFUND
  ADJUSTMENT
}

enum OfferCreditTransactionReason {
  OFFER_SENT
  INVALID_LEAD_REFUND
  UNVERIFIED_LEAD_REFUND
  DUPLICATE_LEAD_REFUND
  NON_RESPONSIVE_LEAD_REFUND
  ADMIN_ADJUSTMENT
  CREDIT_PURCHASE
}

enum LeadQualitySignalType {
  PHONE_VERIFIED
  COMPLETE_ANSWERS
  VALID_LOCATION
  DUPLICATE_REQUEST
  SPAM_PATTERN
  CUSTOMER_RESPONSIVENESS
  ADMIN_REVIEW
}

enum ModerationStatus {
  PENDING
  APPROVED
  REJECTED
  FLAGGED
}

model User {
  id           String    @id @default(cuid())
  email        String?   @unique
  phone        String?   @unique
  passwordHash String?
  role         UserRole
  createdAt    DateTime  @default(now())
  updatedAt    DateTime  @updatedAt
  deletedAt    DateTime?

  customerRequests ServiceRequest[] @relation("CustomerRequests")
  providerProfile  ProviderProfile?
  adminActions     AdminModerationAction[] @relation("AdminActions")

  @@index([role])
  @@index([phone])
}

model ServiceCategory {
  id          String    @id @default(cuid())
  slug        String    @unique
  name        String
  description String?
  isActive    Boolean   @default(true)
  sortOrder   Int       @default(0)
  createdAt   DateTime  @default(now())
  updatedAt   DateTime  @updatedAt
  deletedAt   DateTime?

  questions       ServiceRequestQuestion[]
  requests        ServiceRequest[]
  providerServices ProviderServiceCategory[]

  @@index([isActive, sortOrder])
}

model ServiceRequestQuestion {
  id          String       @id @default(cuid())
  categoryId  String
  key         String
  label       String
  helpText    String?
  type        QuestionType
  isRequired  Boolean      @default(false)
  options     Json?
  validation  Json?
  sortOrder   Int          @default(0)
  isActive    Boolean      @default(true)
  createdAt   DateTime     @default(now())
  updatedAt   DateTime     @updatedAt
  deletedAt   DateTime?

  category ServiceCategory @relation(fields: [categoryId], references: [id])
  answers  ServiceRequestAnswer[]

  @@unique([categoryId, key])
  @@index([categoryId, isActive, sortOrder])
}

model ServiceRequest {
  id                      String               @id @default(cuid())
  customerId              String
  categoryId              String
  status                  ServiceRequestStatus @default(DRAFT)
  title                   String?
  description             String?
  city                    String?
  district                String?
  addressText             String?
  phoneVerificationStatus PhoneVerificationStatus @default(PENDING)
  phoneVerifiedAt         DateTime?
  visibleToProvidersAt    DateTime?
  expiresAt               DateTime?
  moderationStatus        ModerationStatus     @default(PENDING)
  createdAt               DateTime             @default(now())
  updatedAt               DateTime             @updatedAt
  deletedAt               DateTime?

  customer         User                  @relation("CustomerRequests", fields: [customerId], references: [id])
  category         ServiceCategory       @relation(fields: [categoryId], references: [id])
  answers          ServiceRequestAnswer[]
  phoneVerifications PhoneVerification[]
  offers           Offer[]
  leadQualityScore LeadQualityScore?
  moderationActions AdminModerationAction[]

  @@index([categoryId, status])
  @@index([customerId, createdAt])
  @@index([status, visibleToProvidersAt])
  @@index([phoneVerificationStatus])
}

model ServiceRequestAnswer {
  id               String   @id @default(cuid())
  serviceRequestId String
  questionId       String
  value            Json
  createdAt        DateTime @default(now())
  updatedAt        DateTime @updatedAt

  serviceRequest ServiceRequest         @relation(fields: [serviceRequestId], references: [id])
  question       ServiceRequestQuestion @relation(fields: [questionId], references: [id])

  @@unique([serviceRequestId, questionId])
  @@index([questionId])
}

model PhoneVerification {
  id               String                  @id @default(cuid())
  serviceRequestId String?
  userId           String?
  phone            String
  status           PhoneVerificationStatus @default(PENDING)
  provider         String                  @default("placeholder")
  codeHash         String?
  attempts         Int                     @default(0)
  expiresAt        DateTime?
  verifiedAt       DateTime?
  createdAt        DateTime                @default(now())
  updatedAt        DateTime                @updatedAt

  serviceRequest ServiceRequest? @relation(fields: [serviceRequestId], references: [id])

  @@index([phone, status])
  @@index([serviceRequestId])
  @@index([userId])
}

model ProviderProfile {
  id          String    @id @default(cuid())
  userId      String    @unique
  displayName String
  bio         String?
  companyName String?
  taxNumber  String?
  isVerified Boolean   @default(false)
  isActive    Boolean   @default(true)
  createdAt   DateTime  @default(now())
  updatedAt   DateTime  @updatedAt
  deletedAt   DateTime?

  user              User                      @relation(fields: [userId], references: [id])
  serviceCategories ProviderServiceCategory[]
  serviceAreas      ProviderServiceArea[]
  offers            Offer[]
  creditTransactions OfferCreditTransaction[]

  @@index([isActive, isVerified])
}

model ProviderServiceCategory {
  id                String   @id @default(cuid())
  providerProfileId String
  categoryId         String
  createdAt          DateTime @default(now())

  providerProfile ProviderProfile @relation(fields: [providerProfileId], references: [id])
  category        ServiceCategory @relation(fields: [categoryId], references: [id])

  @@unique([providerProfileId, categoryId])
  @@index([categoryId])
}

model ProviderServiceArea {
  id                String   @id @default(cuid())
  providerProfileId String
  city              String
  district          String?
  createdAt         DateTime @default(now())

  providerProfile ProviderProfile @relation(fields: [providerProfileId], references: [id])

  @@unique([providerProfileId, city, district])
  @@index([city, district])
}

model Offer {
  id                String      @id @default(cuid())
  serviceRequestId  String
  providerProfileId String
  status            OfferStatus @default(SENT)
  message           String
  priceAmount       Decimal?    @db.Decimal(12, 2)
  currency          String      @default("TRY")
  creditCost        Int         @default(1)
  sentAt            DateTime    @default(now())
  viewedAt          DateTime?
  createdAt         DateTime    @default(now())
  updatedAt         DateTime    @updatedAt
  deletedAt         DateTime?

  serviceRequest     ServiceRequest           @relation(fields: [serviceRequestId], references: [id])
  providerProfile    ProviderProfile          @relation(fields: [providerProfileId], references: [id])
  creditTransactions OfferCreditTransaction[]

  @@unique([serviceRequestId, providerProfileId])
  @@index([providerProfileId, status])
  @@index([serviceRequestId, status])
}

model OfferCreditTransaction {
  id                String                       @id @default(cuid())
  providerProfileId String
  offerId           String?
  type              OfferCreditTransactionType
  reason            OfferCreditTransactionReason
  amount            Int
  balanceAfter      Int
  note              String?
  metadata          Json?
  createdAt         DateTime                     @default(now())

  providerProfile ProviderProfile @relation(fields: [providerProfileId], references: [id])
  offer           Offer?          @relation(fields: [offerId], references: [id])

  @@index([providerProfileId, createdAt])
  @@index([offerId])
  @@index([type, reason])
}

model LeadQualityScore {
  id               String   @id @default(cuid())
  serviceRequestId String   @unique
  score            Int
  version          Int      @default(1)
  summary          String?
  calculatedAt     DateTime @default(now())
  createdAt        DateTime @default(now())
  updatedAt        DateTime @updatedAt

  serviceRequest ServiceRequest      @relation(fields: [serviceRequestId], references: [id])
  signals        LeadQualitySignal[]

  @@index([score])
}

model LeadQualitySignal {
  id                 String                @id @default(cuid())
  leadQualityScoreId  String
  type               LeadQualitySignalType
  weight             Int
  value              Json?
  createdAt          DateTime              @default(now())

  leadQualityScore LeadQualityScore @relation(fields: [leadQualityScoreId], references: [id])

  @@index([leadQualityScoreId, type])
}

model AdminModerationAction {
  id               String           @id @default(cuid())
  serviceRequestId String?
  adminUserId      String
  fromStatus       ModerationStatus?
  toStatus         ModerationStatus
  reason           String?
  metadata         Json?
  createdAt        DateTime         @default(now())

  serviceRequest ServiceRequest? @relation(fields: [serviceRequestId], references: [id])
  adminUser      User            @relation("AdminActions", fields: [adminUserId], references: [id])

  @@index([serviceRequestId])
  @@index([adminUserId, createdAt])
}
```

Schema notes:

- `ServiceRequestQuestion` and `ServiceRequestAnswer` make request forms dynamic per category.
- `ServiceRequest.status = OPEN` should only be allowed after phone verification passes.
- `LeadQualityScore` is its own domain model, not a transient field on `ServiceRequest`.
- `OfferCreditTransaction` is append-only. Credit balance is derived from the ledger or stored in a future `ProviderCreditBalance` projection if needed.
- Refunds are positive `REFUND` transactions, spends are negative `SPEND` transactions.
- Soft-delete fields are included where public/domain records may need to be hidden without destructive deletion.

## 3. API Module Breakdown

Initial NestJS modules:

- `AuthModule`: registration, login, password hashing, JWT/session strategy, role guards.
- `UsersModule`: user profile lookup and internal user helpers.
- `ServiceCategoriesModule`: public category list, admin category CRUD later.
- `ServiceRequestQuestionsModule`: dynamic question definitions by category.
- `ServiceRequestsModule`: customer request draft/create/submit flow, answer validation, visibility rules.
- `PhoneVerificationModule`: placeholder provider abstraction, issue code, verify code, mark request as verified.
- `ProviderProfilesModule`: provider profile, service categories, service areas.
- `OffersModule`: provider sends offers, customer views offers, status transitions.
- `OfferCreditLedgerModule`: append-only credit spend/refund/purchase/adjustment operations.
- `LeadQualityModule`: score calculation, signal storage, recalculation hooks.
- `AdminModerationModule`: moderation queues, approve/reject/flag requests, credit refund decisions.
- `PrismaModule`: database client lifecycle.
- `ConfigModule`: environment config and validation.

Suggested internal boundaries:

- `OffersModule` should ask `OfferCreditLedgerModule` to spend credits. It should not mutate ledger rows directly.
- `ServiceRequestsModule` should ask `LeadQualityModule` to calculate scores when a verified request becomes visible.
- `PhoneVerificationModule` should own verification state transitions and emit a domain event or service callback when verification succeeds.
- `AdminModerationModule` should call domain services instead of patching rows directly.

## 4. Public Web Route Structure

```txt
apps/web/app
├── page.tsx
├── categories
│   ├── page.tsx
│   └── [categorySlug]
│       └── page.tsx
├── request
│   ├── new
│   │   └── [categorySlug]
│   │       └── page.tsx
│   ├── verify-phone
│   │   └── page.tsx
│   └── [requestId]
│       ├── page.tsx
│       └── offers
│           └── page.tsx
├── provider
│   ├── page.tsx
│   ├── signup
│   │   └── page.tsx
│   ├── profile
│   │   └── page.tsx
│   ├── leads
│   │   ├── page.tsx
│   │   └── [requestId]
│   │       └── page.tsx
│   ├── offers
│   │   └── page.tsx
│   └── credits
│       └── page.tsx
├── login
│   └── page.tsx
└── account
    └── page.tsx
```

MVP public web focus:

- Customer can choose a category.
- Customer sees dynamic questions loaded from the API.
- Customer submits a request into `AWAITING_PHONE_VERIFICATION`.
- Phone verification placeholder marks the request verified in development.
- Verified request becomes visible to matching providers.
- Provider can see open requests in their service categories and areas.
- Provider can send an offer and consume credits through the ledger.

## 5. Admin Route Structure

```txt
apps/admin/app
├── page.tsx
├── login
│   └── page.tsx
├── service-requests
│   ├── page.tsx
│   └── [requestId]
│       └── page.tsx
├── categories
│   ├── page.tsx
│   └── [categoryId]
│       └── page.tsx
├── questions
│   ├── page.tsx
│   └── [questionId]
│       └── page.tsx
├── providers
│   ├── page.tsx
│   └── [providerProfileId]
│       └── page.tsx
├── offers
│   └── page.tsx
├── credit-ledger
│   └── page.tsx
└── moderation
    ├── page.tsx
    └── [requestId]
        └── page.tsx
```

MVP admin focus:

- Review newly verified service requests.
- See lead quality score and signals.
- Approve, reject, or flag requests.
- Review provider profiles.
- Inspect offer credit transactions.
- Issue manual credit adjustments or refunds in later phases.

## 6. Phase-by-Phase Implementation Plan

### Phase 0: Product and Technical Bootstrap

Goal: create a clean monorepo foundation without implementing marketplace behavior.

Deliverables:

- Monorepo tooling with `pnpm` workspaces and Turbo.
- `apps/api`, `apps/web`, and `apps/admin` scaffolded.
- Shared TypeScript, ESLint, Prettier, and environment validation setup.
- Docker Compose for PostgreSQL.
- Initial Prisma schema and migration.
- Seed script for initial MVP categories and dynamic questions.
- Basic health endpoints and app shells.

Do not build offer logic, scoring logic, payments, SMS integration, or full admin workflows in this phase.

### Phase 1: Auth and Category Foundation

Goal: allow users and providers to exist, and expose service categories/questions.

Deliverables:

- Customer/provider/admin roles.
- Auth endpoints.
- Public category listing.
- Category detail with question definitions.
- Seeded categories and question definitions.
- Admin read-only category/question screens.

### Phase 2: Customer Service Request Creation

Goal: create service requests using dynamic category questions.

Deliverables:

- Dynamic form rendering in `apps/web`.
- Request draft/create/submit endpoints.
- Server-side validation based on `ServiceRequestQuestion`.
- Request status transition to `AWAITING_PHONE_VERIFICATION`.
- Placeholder phone verification flow.
- Verified requests move to `OPEN`.

### Phase 3: Provider Profiles and Matching Surface

Goal: let providers define what they serve and where.

Deliverables:

- Provider profile management.
- Provider service categories.
- Provider service areas.
- Provider lead list filtered by category, area, request status, and moderation status.
- Basic provider dashboard.

### Phase 4: Offers and Credit Ledger

Goal: providers can send offers with transparent credit spending.

Deliverables:

- Offer creation.
- One offer per provider per request.
- Credit spend transaction when an offer is sent.
- Credit balance calculation.
- Customer offer list.
- Provider offer history.

### Phase 5: Lead Quality Scoring

Goal: visible leads carry explainable quality scoring.

Deliverables:

- Scoring service with versioned algorithm.
- Signals for phone verification, answer completeness, location validity, duplicate suspicion, spam indicators, and responsiveness.
- Score shown to providers and admins.
- Score recalculation hooks.

### Phase 6: Admin Moderation and Refund Rules

Goal: protect provider economics through moderation and ledger corrections.

Deliverables:

- Moderation queue.
- Approve/reject/flag request actions.
- Manual refund flow.
- Invalid/unverified/duplicate/non-responsive lead reason codes.
- Audit trail via `AdminModerationAction`.

### Phase 7: Production Integrations

Goal: replace placeholders with real operational services.

Deliverables:

- Real SMS provider integration.
- Email notifications.
- Observability.
- Rate limiting.
- Backoffice reporting.
- Payment/credit purchase integration if needed.

## 7. First Implementation Task List: Project Bootstrap Only

The first implementation pass should stop after foundation is working.

1. Initialize repository metadata.
   - `package.json`
   - `pnpm-workspace.yaml`
   - `turbo.json`
   - `.gitignore`
   - `.env.example`

2. Create monorepo packages.
   - `packages/tsconfig`
   - `packages/eslint-config`
   - `packages/config`
   - `packages/shared`
   - Optional empty `packages/ui`

3. Scaffold `apps/api`.
   - NestJS app skeleton.
   - `HealthModule`.
   - `PrismaModule`.
   - `ConfigModule`.
   - No business endpoints yet beyond health and maybe category read smoke tests.

4. Scaffold `apps/web`.
   - Next.js app shell.
   - Home page.
   - Placeholder category selection page.
   - API client utility.

5. Scaffold `apps/admin`.
   - Next.js app shell.
   - Admin dashboard placeholder.
   - Placeholder moderation page.

6. Add database foundation.
   - `docker-compose.yml` with PostgreSQL.
   - `prisma/schema.prisma`.
   - Initial additive migration.
   - `prisma/seed.ts`.
   - Seed command wired in `package.json`.

7. Seed initial MVP categories and questions.
   - `home-cleaning`
   - `moving`
   - `painting`
   - `plumbing`
   - `private-lesson`

8. Add development scripts.
   - `pnpm dev`
   - `pnpm dev:api`
   - `pnpm dev:web`
   - `pnpm dev:admin`
   - `pnpm db:generate`
   - `pnpm db:migrate`
   - `pnpm db:seed`
   - `pnpm lint`
   - `pnpm typecheck`

9. Add bootstrap verification.
   - API health endpoint returns OK.
   - Web app renders.
   - Admin app renders.
   - Prisma client generates.
   - Seed inserts categories and questions idempotently.

## Seed Strategy

Seed data must be idempotent and small. Use stable slugs and question keys so repeated seeds update existing records instead of creating duplicates.

Initial categories:

- `home-cleaning`: house cleaning requests.
- `moving`: home or office moving requests.
- `painting`: interior painting requests.
- `plumbing`: plumbing repair requests.
- `private-lesson`: private tutoring or coaching requests.

Example seeded questions:

```ts
export const seedCategories = [
  {
    slug: "home-cleaning",
    name: "Home Cleaning",
    questions: [
      { key: "home_size", label: "How large is the home?", type: "SINGLE_SELECT", required: true, options: ["1+1", "2+1", "3+1", "4+1 or larger"] },
      { key: "cleaning_type", label: "What type of cleaning do you need?", type: "SINGLE_SELECT", required: true, options: ["Standard", "Deep cleaning", "Move-in / move-out"] },
      { key: "preferred_date", label: "Preferred service date", type: "DATE", required: false }
    ]
  },
  {
    slug: "moving",
    name: "Moving",
    questions: [
      { key: "from_district", label: "Pickup district", type: "TEXT", required: true },
      { key: "to_district", label: "Delivery district", type: "TEXT", required: true },
      { key: "has_elevator", label: "Is there an elevator?", type: "BOOLEAN", required: false }
    ]
  },
  {
    slug: "painting",
    name: "Painting",
    questions: [
      { key: "room_count", label: "How many rooms will be painted?", type: "NUMBER", required: true },
      { key: "paint_included", label: "Should the provider include paint?", type: "BOOLEAN", required: false }
    ]
  },
  {
    slug: "plumbing",
    name: "Plumbing",
    questions: [
      { key: "issue_type", label: "What is the plumbing issue?", type: "SINGLE_SELECT", required: true, options: ["Leak", "Clog", "Installation", "Other"] },
      { key: "urgency", label: "How urgent is it?", type: "SINGLE_SELECT", required: true, options: ["Today", "This week", "Flexible"] }
    ]
  },
  {
    slug: "private-lesson",
    name: "Private Lesson",
    questions: [
      { key: "subject", label: "Which subject or skill?", type: "TEXT", required: true },
      { key: "lesson_format", label: "Preferred lesson format", type: "SINGLE_SELECT", required: true, options: ["Online", "In person", "Either"] }
    ]
  }
];
```

Seed rules:

- Use `upsert` by category `slug`.
- Use `upsert` by `[categoryId, key]` for questions.
- Never delete categories or questions during seed.
- If a seeded question is retired, set `isActive = false` in a later explicit seed change.
- Keep seed data representative, not exhaustive.

## Bootstrap Guardrails

- No `migrate reset`.
- No database drops.
- No destructive migrations.
- No hardcoded category forms in React components.
- No offer-credit spending before phone verification and visibility rules exist.
- No production SMS dependency during bootstrap.
- Keep all economics changes append-only through the credit ledger.

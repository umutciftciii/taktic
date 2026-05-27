# TakTic

TakTic is a local services marketplace foundation. Phase 0 is intentionally limited to technical bootstrap: monorepo setup, thin app shells, PostgreSQL, Prisma, and seed data for service categories and dynamic request questions.

## Ports

- Public web: `http://localhost:3000`
- API: `http://localhost:3001`
- Admin: `http://localhost:3002`
- PostgreSQL: `localhost:5433` by default

## Local Setup

1. Install the Node version from `.nvmrc`.
2. Install dependencies:

```bash
pnpm install
```

3. Copy environment variables:

```bash
cp .env.example .env
```

4. Start PostgreSQL:

```bash
docker compose up -d postgres
```

5. Generate Prisma Client:

```bash
pnpm db:generate
```

6. Create the initial local migration:

```bash
pnpm db:migrate --name init
```

7. Seed local categories and questions:

```bash
pnpm db:seed
```

8. Start all apps:

```bash
pnpm dev
```

## Useful Commands

```bash
pnpm dev
pnpm build
pnpm lint
pnpm typecheck
pnpm db:generate
pnpm db:migrate
pnpm db:seed
pnpm db:studio
```

There are intentionally no destructive database scripts. Do not use `prisma migrate reset`, forced resets, or database drops for normal development.

## Local Auth

Seeding creates a local development admin if it does not already exist:

- Email: `admin@taktic.local`
- Password: `ChangeMe123!`
- Role: `SUPER_ADMIN`

Authentication uses an HTTP-only cookie session named `taktic_session` by default. The seed does not overwrite an existing admin password.

## Local Ops

Refund scan automation is disabled by default. The scheduled worker is optional and uses the same execution logic as the admin refund scan endpoint, so it preserves the same eligibility checks, transactions, and idempotency behavior.

To enable it locally:

```bash
REFUND_SCHEDULER_ENABLED=true
```

Relevant environment variables:

- `REFUND_SCHEDULER_ENABLED=false`
- `REFUND_SCHEDULER_CRON=0 * * * *`
- `REFUND_SCAN_OLDER_THAN_HOURS=48`
- `REFUND_SCAN_LIMIT=100`

The scheduler only runs full refunds for the existing not-viewed offer policy. It does not perform partial refunds.

## Phase 0 Scope

Included:

- pnpm and Turbo monorepo
- Thin NestJS API shell with `/health`
- Thin Next.js web and admin shells
- Docker Compose PostgreSQL
- Root Prisma schema
- Idempotent local/dev seed data
- Shared TypeScript configs
- Minimal shared package

Excluded:

- Auth
- Provider profiles
- Customer service requests
- Offers and offer credits
- Lead quality scoring
- Phone verification
- Admin CRUD
- Payments
- Moderation workflows

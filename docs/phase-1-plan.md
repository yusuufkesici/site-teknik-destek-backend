# Faz 1 Plan Özeti — İskelet + Veri Modeli

> Tam plan: `.claude/plans` altında onaylanan "Faz 1" planı. Bu dosya, o planın
> kısa özetidir; kaynak önceliği açısından CLAUDE.md ve
> `docs/implementation-overrides.md`'nin altında, ayrıntılı planın ise
> özetidir.

## Kapsam

Bu faz yalnız **iskelet + veri modeli**dir: NestJS proje kurulumu, strict
TypeScript, ESLint/Prettier, ConfigModule + Zod env validation, Prisma 7 +
PostgreSQL driver adapter (`prisma.config.ts`), düzeltilmiş `schema.prisma`,
özel PostgreSQL migration'ları, `PrismaModule`/`PrismaService`, production
Dockerfile, development `docker-compose.yml`, `.dockerignore`, `.env.example`,
health liveness/readiness, global exception filter, request ID, structured
JSON logging, Helmet, CORS allowlist, global `ValidationPipe`, `main.ts` /
`AppModule` bootstrap.

Auth/OTP/JWT, users, memberships, facilities, tickets, assignments,
materials, attachments, contracts, billing, notifications, audit domain
servisleri ve seed verisi bu fazda **oluşturulmadı**.

## architecture.md'yi geçersiz kılan override kararları

- Docker taban imajı: `node:20-alpine` yerine `node:24-alpine`.
- Prisma generator: `prisma-client-js` yerine güncel `prisma-client` +
  açık `output` dizini.
- DB bağlantı URL'si `schema.prisma` içinde değil, `prisma.config.ts`
  içinde (`@prisma/adapter-pg` ile).
- Tüm "an" ifade eden `DateTime` alanlarına açık `@db.Timestamptz(6)`;
  yalnız `Contract.startDate/endDate` ve `ContractInvoice`'ın 4 takvim
  alanı `@db.Date` kalır.
- Zod env şeması override §11'deki **tam** liste + yalnız parse edilmiş
  nesne üzerinden koşullu doğrulama (`process.env` doğrudan okunmaz).
- `assignments (id, ticket_id)` non-partial unique + `ticket_attachments
  (assignment_id, ticket_id)` → `assignments (id, ticket_id)` composite FK
  (override §4), mimari Bölüm 6'nın SQL'ine ek olarak.

## Faz 1 dışında bırakılanlar

Auth/OTP/JWT/refresh-token, Users/Memberships/Facilities, Tickets/
Assignments/Materials, Attachments/StorageProvider, SmsProvider,
Contracts/Billing, Notifications/Audit/Outbox, seed verisi, RBAC guard'ları,
Swagger, Jest test altyapısı, PrismaService soft-delete middleware/extension.

Ayrıntılı gerekçe ve tasarım kararları için onaylanmış Faz 1 planına
bakınız.

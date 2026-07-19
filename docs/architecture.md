# Site Teknik Destek Sistemi — Backend Mimari Tasarımı

B2B SaaS · Modüler Monolit · NestJS + PostgreSQL + Prisma

---

## Belge Statüsü

Bu belge projenin **başlangıç mimari tasarımıdır** ve tarihsel referans olarak
korunmaktadır. Faz 1–8 uygulaması sırasında bazı kararlar değişmiştir.

- Güncel kaynak otoritesi sırası: kullanıcının mevcut görev mesajı →
  `docs/implementation-overrides.md` → onaylanmış faz planı → bu belge →
  mevcut kaynak kod (`CLAUDE.md` ile aynı sıra).
- Uygulama ile bu belge arasındaki bilinen farkların bağlayıcı listesi:
  **Bölüm 17: Uygulama Sonrası Mimari Revizyon (Faz 1–8)**.
- Farkın geçerli olduğu bölümlerde kısa bir "Uygulama notu (Faz 9)" kutusu
  bulunur; kutu, tarihsel metni silmeden güncel gerçekliği işaret eder.

---

## Bölüm 1: Mimari Karar Özeti

### Neden NestJS?

- **Modül sistemi** modüler monolit hedefiyle birebir örtüşür: her domain (tickets, assignments, contracts…) kendi `Module` sınırı içinde yaşar; ileride bir modülün ayrı servise taşınması, modülün dışa açtığı service interface'lerinin bir HTTP/queue client ile değiştirilmesinden ibarettir.
- **Guard / Interceptor / Pipe zinciri**, çok katmanlı yetkilendirme (JWT → Rol → Site kapsamı → Kaynak sahipliği) için doğal bir yerleşim sunar.
- DI container sayesinde `SmsProvider`, `StorageProvider` gibi adapter'lar interface token'ları üzerinden enjekte edilir; MockSmsProvider ↔ ExternalSmsProvider geçişi tek satırlık provider değişikliğidir.
- Swagger, ConfigModule, class-validator entegrasyonları birinci sınıf vatandaştır.

### Neden Prisma?

- **Tip güvenliği**: strict TypeScript ile şema → client tipi üretimi, `any` sızıntısını engeller.
- **Migration disiplini**: şema tek kaynak; PostgreSQL'e özgü partial unique index ve exclusion constraint'ler ham SQL migration olarak aynı migration zincirine eklenir (Bölüm 6).
- `prisma.$transaction` (interactive transaction) ile atama değiştirme, OTP tüketme gibi çok adımlı işlemler tek transaction'da, gerektiğinde `SELECT ... FOR UPDATE` ham sorgularıyla birlikte yürütülür.
- Not: Prisma'nın desteklemediği kısıtlar (partial index, EXCLUDE, CHECK) bilinçli olarak SQL migration'a taşınmıştır; "Prisma her şeyi çözer" varsayımı yapılmamıştır.

### Neden modüler monolit?

- Ekip küçük, domain sınırları henüz oturuyor; mikroservis ağ/deploy/observability maliyeti MVP'de gereksiz.
- Tenant izolasyonu, transaction bütünlüğü (ticket + history + outbox tek transaction) monolitte trivially doğru; dağıtık sistemde saga gerektirir.
- Ayrışma hazırlığı: modüller arası iletişim **yalnızca public service arayüzleri ve outbox event'leri** üzerinden yapılır; bir modül başka modülün repository'sine veya Prisma modeline doğrudan dokunmaz.

### Tenant izolasyonu nasıl sağlanıyor?

Dört savunma hattı (defense in depth):

1. **Veri modeli**: ticket, assignment, contract, attachment gibi tüm operasyonel tablolarda denormalize `siteId` kolonu bulunur; her sorgu `siteId` filtresiyle çalışır.
2. **Guard katmanı**: `SiteScopeGuard` isteğin hedef site'ını, kullanıcının **veritabanındaki** aktif `site_memberships` kayıtlarıyla karşılaştırır. JWT'deki iddialara güvenilmez, `params/body`'den gelen `siteId` asla otorite kabul edilmez.
3. **Policy katmanı**: her service, işlemden önce kaynak bazlı policy'yi (ör. `TicketAuthorizationPolicy.canRead`) çağırır. Controller decorator'ı atlanmış olsa bile service kendi başına reddeder.
4. **Repository katmanı**: liste sorguları `siteId` parametresini **zorunlu** alır; parametresiz "tümünü getir" metodu yalnızca OPERATIONS'a özel repository metodlarında ve açıkça isimlendirilmiş olarak (`findAllAcrossSitesForOperations`) bulunur.

### Ana güvenlik sınırları

| Sınır | Mekanizma |
|---|---|
| Kimlik | SMS OTP (HMAC-SHA256 hash, TTL 3-5 dk, deneme limiti), parola yok |
| Oturum | 15 dk access JWT + rotasyonlu refresh token (yalnızca hash saklanır, reuse detection) |
| Tenant | siteId denormalizasyonu + SiteScopeGuard + repository zorunlu filtre |
| Kaynak (IDOR) | Policy sınıfları: sahiplik/atama/üyelik DB'den doğrulanır |
| Durum bütünlüğü | Ticket state machine + rol bazlı geçiş matrisi, DB'de history |
| Eşzamanlılık | Partial unique index, row lock (`FOR UPDATE`), exclusion constraint |
| Veri sızıntısı | OTP/token/SMS içeriği loglanmaz, generic auth cevapları, private storage + signed URL |
| Denetim | audit_logs (before/after JSONB, maskelenmiş PII) + outbox_events |

---

## Bölüm 2: Varsayımlar

Soru sormak yerine aşağıdaki makul teknik varsayımlar yapılmıştır:

1. **Tek şirket, çok site**: OPERATIONS ve TECHNICIAN platform sahibinin personelidir, site'a değil şirkete bağlıdır. Bu yüzden teknisyenin site üyeliği yoktur; erişimi yalnızca assignment üzerinden gelir.
2. **Facility'de siteId**: `type = SITE` kayıtlarında `siteId = NULL`'dır; tüm alt kayıtlarda kök site'ın id'si tutulur. (Alternatif olan "SITE kendi id'sini taşır" self-FK insert'ü karmaşıklaştırır.)
3. **Ticket numarası**: kullanıcıya gösterilecek `code` alanı (`TKT-2026-000123`) sequence tabanlı üretilir; UUID iç kimliktir.
4. **REJECTED durumunda ticket**: teknisyen atamayı reddettiğinde ticket `REJECTED` durumuna geçer ve yalnızca OPERATIONS yeniden `ASSIGNED` yapabilir.
5. **SLA**: sözleşmedeki `standardResponseTargetHours` (ve EMERGENCY için sabit config değeri) ticket oluşturulurken `slaTargetAt` alanına hesaplanıp yazılır; SLA ihlal job'ı MVP dışıdır.
6. **Para birimi**: MVP'de `TRY` varsayılan, alan yine de tutulur.
7. **Saat dilimi**: DB tamamen UTC (`timestamptz`), sunum katmanı Europe/Istanbul dönüşümünü client'a bırakır.
8. **Pagination**: liste endpoint'lerinde **cursor pagination** (createdAt + id) tercih edilmiştir; gerekçe Bölüm 11'de.
9. **Refresh token taşıma**: mobil/web istemciler için body üzerinden taşınır (httpOnly cookie web'e sonradan eklenebilir).
10. **Soft delete kapsamı**: users, facilities, tickets, materials, ticket_attachments soft delete; history/audit/otp/assignment kayıtları hiç silinmez (append-only). Refresh session'lar revoke edilir, periyodik job süresi dolanları fiziksel temizler.
11. **SITE_MANAGER site oluşturamaz**: MVP'de site/blok/daire oluşturma OPERATIONS'a aittir; site manager yalnızca sakin yönetir. (İş kuralı 5.1 "sistem yöneticisi veya yetkili site yöneticisi" diyor; güvenli taraf seçildi, ileride policy ile genişletilebilir.)
12. **Deneme/onboarding OTP purpose'u**: `PHONE_VERIFICATION` telefon değişikliği akışı için rezerve edilmiştir, MVP'de yalnızca `LOGIN` aktif kullanılır.

---

## Bölüm 3: Modüller ve Sorumlulukları

| Modül | Sorumluluk | Dışa açtığı sözleşme |
|---|---|---|
| `auth` | OTP request/verify, JWT üretimi, refresh rotation, logout, `/auth/me` | `AuthService`, guard'lar |
| `users` | Kullanıcı CRUD (serbest kayıt YOK), pasifleştirme, telefon değişikliği | `UsersService`, `UserRepository` |
| `memberships` | site_memberships + resident_unit_assignments yönetimi; **tüm erişim sorularının tek otoritesi** | `MembershipQueryService.hasActiveSiteMembership()`, `hasActiveUnitAssignment()` |
| `facilities` | SITE/BLOCK/UNIT/COMMON_AREA hiyerarşisi, ağaç sorgusu, hiyerarşi doğrulama | `FacilityService`, `FacilityValidator` |
| `tickets` | Ticket yaşam döngüsü, state machine, status history, iptal | `TicketService`, `TicketStateMachine`, `TicketAuthorizationPolicy` |
| `assignments` | Teknisyen atama/yeniden atama, teknisyen durum geçişleri, malzeme kaydı köprüsü | `AssignmentService`, `AssignmentAccessPolicy` |
| `materials` | Malzeme kataloğu + assignment_materials | `MaterialService` |
| `attachments` | Dosya metadata, StorageProvider üzerinden signed URL, MIME/boyut doğrulama | `AttachmentService` |
| `contracts` | Sözleşme yaşam döngüsü, aktif sözleşme çakışma kontrolü | `ContractService` |
| `billing` | contract_invoices, dönem çakışması, durum geçişleri (ISSUED→PAID vs.) | `InvoiceService` |
| `notifications` | Outbox event'lerini kanal bağımsız bildirime çevirir (MVP: SMS + log) | `NotificationDispatcher` |
| `audit` | Merkezi audit yazımı, PII maskeleme | `AuditService.log()` |
| `common` | Guard, decorator, exception filter, pagination, enums, phone-normalizer | — |
| `infrastructure` | PrismaService, StorageProvider impl., SmsProvider impl., OutboxRelay, logger | interface token'ları |

Bağımlılık yönü: `modules → common/infrastructure`; modüller birbirine yalnızca **service interface** üzerinden bağımlıdır (ör. tickets → memberships). Döngüsel bağımlılık yasaktır; ihtiyaç halinde outbox event kullanılır.

---

## Bölüm 4: Veritabanı İlişki Modeli

### Cardinality özeti

```text
users 1 ──── n site_memberships n ──── 1 facilities(SITE)
users 1 ──── n resident_unit_assignments n ──── 1 facilities(UNIT)
facilities 1 ──── n facilities (parentId, self-ref)
facilities(SITE) 1 ──── n facilities (siteId, denormalize kök)

users 1 ──── n tickets (createdBy)
facilities 1 ──── n tickets (facilityId)   |  facilities(SITE) 1 ── n tickets (siteId)
tickets 1 ──── n ticket_status_history
tickets 1 ──── n assignments n ──── 1 users (technician)
assignments 1 ──── n assignment_materials n ──── 1 materials
tickets 1 ──── n ticket_attachments (assignmentId nullable köprü)

facilities(SITE) 1 ──── n contracts 1 ──── n contract_invoices
users 1 ──── n otp_challenges (userId nullable: numara sistemde yoksa da kayıt tutulur)
users 1 ──── n refresh_sessions (replacedByTokenId self-ref → rotation zinciri)
audit_logs / outbox_events: FK'siz-gevşek (entityType+entityId), append-only
```

### Silme davranışları

- `RESTRICT` (varsayılan): operasyonel bütünlüğü koruyan tüm FK'ler — ticket→facility, assignment→ticket, invoice→contract, assignment_material→material. Fiziksel silme zaten soft delete ile engellenir.
- `CASCADE` yalnızca tamamen bağımlı satırlarda: ticket_status_history→ticket, assignment_materials→assignment (pratikte parent hiç silinmediği için teorik).
- `SET NULL`: audit benzeri gevşek referanslar (attachment.assignmentId gibi) yerine nullable FK + RESTRICT tercih edildi; hiçbir FK SET NULL kullanmaz, iz kaybı olmaz.

### Kısıt yerleşimi (DB mi, uygulama mı?)

| Kural | Nerede | Neden |
|---|---|---|
| Blok/daire kodu benzersizliği | **DB**: partial unique `(parent_id, code) WHERE deleted_at IS NULL` | Race condition'a tek güvenli çözüm |
| Ticket başına tek aktif assignment | **DB**: partial unique `(ticket_id) WHERE is_current` + service'te row lock | Çift savunma |
| Aynı site'ta çakışan aktif sözleşme | **DB**: `EXCLUDE USING gist` (btree_gist) + service ön-kontrolü | Tarih aralığı çakışması unique ile ifade edilemez |
| Aynı dönem için ikinci fatura | **DB**: unique `(contract_id, billing_period_start)` | Basit ve kesin |
| SITE.parentId NULL, BLOCK yalnız SITE altında… | **DB**: CHECK (tip-parent alan tutarlılığı) + **uygulama**: parent'ın tipini ve site'ını sorgulayan `FacilityValidator` | CHECK başka satıra bakamaz (parent tipi), bu yüzden hiyerarşi kuralı service'te, alan tutarlılığı CHECK'te |
| Facility parent'ı başka site'a ait olamaz | **Uygulama** (transaction içinde parent okunur) | Cross-row kural |
| quantity > 0, unitPrice ≥ 0, tarih tutarlılığı | **DB CHECK** + DTO validasyonu | Ucuz, kesin |
| E.164 format | **Uygulama** (pipe/normalizer) + DB CHECK `phone ~ '^\+[1-9][0-9]{6,14}$'` | Normalizasyon uygulama işi, format garantisi DB'de |

---

## Bölüm 5: Tam Prisma Şeması

```prisma
// prisma/schema.prisma
// Notlar:
// - Tüm tarihler timestamptz (UTC). Prisma DateTime -> timestamptz(6) varsayılanı korunur.
// - Partial unique index'ler ve CHECK/EXCLUDE kısıtları Bölüm 6'daki SQL migration'dadır.
// - Para: Decimal(12,2). Asla Float kullanılmaz.

generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

// ---------- ENUMS ----------

enum UserRole {
  RESIDENT
  SITE_MANAGER
  OPERATIONS
  TECHNICIAN
}

enum FacilityType {
  SITE
  BLOCK
  UNIT
  COMMON_AREA
}

enum MembershipRole {
  MANAGER   // site yöneticisi üyeliği
  RESIDENT  // sakin üyeliği (unit assignment'a ek olarak site düzeyi görünürlük)
}

enum TicketCategory {
  ELECTRICAL
  PLUMBING
  HVAC
  PUMP
  POOL
  SECURITY_SYSTEM
  GENERAL_MAINTENANCE
  OTHER
}

enum TicketUrgency {
  STANDARD
  URGENT
  EMERGENCY
}

enum TicketStatus {
  OPEN
  TRIAGED
  ASSIGNED
  ACCEPTED
  REJECTED
  EN_ROUTE
  ARRIVED
  IN_PROGRESS
  WAITING_MATERIAL
  COMPLETED
  CLOSED
  CANCELLED
}

enum TicketSource {
  RESIDENT
  SITE_MANAGER
  OPERATIONS
  PHONE_CALL
}

enum AssignmentStatus {
  PENDING
  ACCEPTED
  REJECTED
  ACTIVE
  COMPLETED
  CANCELLED
  REASSIGNED
}

enum SuppliedBy {
  COMPANY
  SITE_MANAGEMENT
  RESIDENT
  TECHNICIAN
  OTHER
}

enum AttachmentType {
  ISSUE
  BEFORE_WORK
  AFTER_WORK
  MATERIAL
  DOCUMENT
  OTHER
}

enum ContractStatus {
  DRAFT
  ACTIVE
  SUSPENDED
  EXPIRED
  TERMINATED
}

enum InvoiceStatus {
  DRAFT
  ISSUED
  PAID
  OVERDUE
  CANCELLED
}

enum PaymentMethod {
  BANK_TRANSFER
  CASH
  MANUAL_OTHER
}

enum OtpPurpose {
  LOGIN
  PHONE_VERIFICATION
}

enum OutboxStatus {
  PENDING
  PROCESSING
  PROCESSED
  FAILED
}

// ---------- MODELS ----------

model User {
  id           String    @id @default(uuid()) @db.Uuid
  // E.164 normalize edilmiş. Global unique: bir numara tek kullanıcı.
  phoneNumber  String    @unique @map("phone_number") @db.VarChar(16)
  firstName    String    @map("first_name") @db.VarChar(100)
  lastName     String    @map("last_name") @db.VarChar(100)
  role         UserRole
  isActive     Boolean   @default(true) @map("is_active")
  // Token invalidation: rol/erişim değişince artırılır, eski JWT'ler düşer.
  tokenVersion Int       @default(0) @map("token_version")
  lastLoginAt  DateTime? @map("last_login_at")
  createdAt    DateTime  @default(now()) @map("created_at")
  updatedAt    DateTime  @updatedAt @map("updated_at")
  // Soft delete: kullanıcı geçmiş ticket/audit kayıtlarında referans olarak kalmalı.
  deletedAt    DateTime? @map("deleted_at")

  siteMemberships     SiteMembership[]
  unitAssignments     ResidentUnitAssignment[]
  otpChallenges       OtpChallenge[]
  refreshSessions     RefreshSession[]
  createdTickets      Ticket[]                 @relation("TicketCreatedBy")
  statusChanges       TicketStatusHistory[]
  technicianJobs      Assignment[]             @relation("AssignmentTechnician")
  assignmentsMade     Assignment[]             @relation("AssignmentAssignedBy")
  materialEntries     AssignmentMaterial[]
  uploadedAttachments TicketAttachment[]
  createdContracts    Contract[]

  @@index([role, isActive])
  @@map("users")
}

model SiteMembership {
  id             String         @id @default(uuid()) @db.Uuid
  userId         String         @map("user_id") @db.Uuid
  siteId         String         @map("site_id") @db.Uuid
  membershipRole MembershipRole @map("membership_role")
  isActive       Boolean        @default(true) @map("is_active")
  startsAt       DateTime       @default(now()) @map("starts_at")
  // Nullable: süresiz üyelik; dolduğunda isActive=false + endsAt set edilir.
  endsAt         DateTime?      @map("ends_at")
  createdAt      DateTime       @default(now()) @map("created_at")
  updatedAt      DateTime       @updatedAt @map("updated_at")

  user User     @relation(fields: [userId], references: [id], onDelete: Restrict)
  site Facility @relation("SiteMembers", fields: [siteId], references: [id], onDelete: Restrict)

  // Partial unique (user_id, site_id, membership_role) WHERE is_active -> Bölüm 6
  @@index([siteId, membershipRole, isActive])
  @@index([userId, isActive])
  @@map("site_memberships")
}

model ResidentUnitAssignment {
  id        String    @id @default(uuid()) @db.Uuid
  userId    String    @map("user_id") @db.Uuid
  unitId    String    @map("unit_id") @db.Uuid
  isPrimary Boolean   @default(true) @map("is_primary")
  isActive  Boolean   @default(true) @map("is_active")
  startsAt  DateTime  @default(now()) @map("starts_at")
  endsAt    DateTime? @map("ends_at") // Nullable: hâlâ oturuyor
  createdAt DateTime  @default(now()) @map("created_at")

  user User     @relation(fields: [userId], references: [id], onDelete: Restrict)
  unit Facility @relation("UnitResidents", fields: [unitId], references: [id], onDelete: Restrict)

  // Partial unique (user_id, unit_id) WHERE is_active -> Bölüm 6
  @@index([unitId, isActive])
  @@index([userId, isActive])
  @@map("resident_unit_assignments")
}

model Facility {
  id       String       @id @default(uuid()) @db.Uuid
  type     FacilityType
  name     String       @db.VarChar(200)
  // Blok/daire kodu ("A", "12"). SITE için de kısa kod tutulur.
  code     String       @db.VarChar(50)
  // Nullable: SITE kayıtlarında parent yoktur (CHECK ile garanti).
  parentId String?      @map("parent_id") @db.Uuid
  // Denormalize kök site. Nullable: yalnızca type=SITE satırlarında NULL (CHECK ile garanti).
  siteId   String?      @map("site_id") @db.Uuid
  isActive Boolean      @default(true) @map("is_active")
  createdAt DateTime    @default(now()) @map("created_at")
  updatedAt DateTime    @updatedAt @map("updated_at")
  deletedAt DateTime?   @map("deleted_at") // Soft delete: ticket geçmişi bozulmasın

  parent   Facility?  @relation("FacilityTree", fields: [parentId], references: [id], onDelete: Restrict)
  children Facility[] @relation("FacilityTree")
  site     Facility?  @relation("SiteDescendants", fields: [siteId], references: [id], onDelete: Restrict)
  descendants Facility[] @relation("SiteDescendants")

  siteMembers      SiteMembership[]         @relation("SiteMembers")
  residents        ResidentUnitAssignment[] @relation("UnitResidents")
  tickets          Ticket[]                 @relation("TicketFacility")
  siteTickets      Ticket[]                 @relation("TicketSite")
  contracts        Contract[]

  // Partial unique (parent_id, code) WHERE deleted_at IS NULL -> Bölüm 6
  @@index([siteId, type])
  @@index([parentId])
  @@map("facilities")
}

model OtpChallenge {
  id            String     @id @default(uuid()) @db.Uuid
  // Nullable: numara sistemde yoksa da rate-limit/audit için kayıt tutulur, kullanıcı ifşa edilmez.
  userId        String?    @map("user_id") @db.Uuid
  phoneNumber   String     @map("phone_number") @db.VarChar(16)
  purpose       OtpPurpose
  codeHash      String     @map("code_hash") @db.VarChar(128) // HMAC-SHA256 hex
  expiresAt     DateTime   @map("expires_at")
  consumedAt    DateTime?  @map("consumed_at")
  invalidatedAt DateTime?  @map("invalidated_at")
  attemptCount  Int        @default(0) @map("attempt_count")
  maxAttempts   Int        @default(5) @map("max_attempts")
  requestedIp   String     @map("requested_ip") @db.VarChar(45)
  userAgent     String?    @map("user_agent") @db.VarChar(400)
  createdAt     DateTime   @default(now()) @map("created_at")

  user User? @relation(fields: [userId], references: [id], onDelete: Restrict)

  @@index([phoneNumber, createdAt(sort: Desc)])
  @@index([expiresAt]) // temizlik job'ı
  @@map("otp_challenges")
}

model RefreshSession {
  id                String    @id @default(uuid()) @db.Uuid
  userId            String    @map("user_id") @db.Uuid
  tokenHash         String    @unique @map("token_hash") @db.VarChar(128)
  deviceId          String?   @map("device_id") @db.VarChar(100) // Nullable: web istemcisi göndermeyebilir
  userAgent         String?   @map("user_agent") @db.VarChar(400)
  ipAddress         String    @map("ip_address") @db.VarChar(45)
  expiresAt         DateTime  @map("expires_at")
  revokedAt         DateTime? @map("revoked_at")
  replacedByTokenId String?   @map("replaced_by_token_id") @db.Uuid // rotation zinciri
  createdAt         DateTime  @default(now()) @map("created_at")
  lastUsedAt        DateTime? @map("last_used_at")

  user       User             @relation(fields: [userId], references: [id], onDelete: Restrict)
  replacedBy RefreshSession?  @relation("RotationChain", fields: [replacedByTokenId], references: [id], onDelete: Restrict)
  replaces   RefreshSession[] @relation("RotationChain")

  @@index([userId, revokedAt])
  @@index([expiresAt])
  @@map("refresh_sessions")
}

model Ticket {
  id                 String         @id @default(uuid()) @db.Uuid
  // İnsan-okur kod: TKT-2026-000123 (sequence + yıl, service üretir)
  code               String         @unique @db.VarChar(20)
  createdByUserId    String         @map("created_by_user_id") @db.Uuid
  siteId             String         @map("site_id") @db.Uuid
  facilityId         String         @map("facility_id") @db.Uuid
  title              String         @db.VarChar(150)
  description        String         @db.VarChar(4000)
  category           TicketCategory
  urgency            TicketUrgency  @default(STANDARD)
  status             TicketStatus   @default(OPEN)
  source             TicketSource
  // Nullable: sözleşmede SLA tanımlı değilse hesaplanamaz.
  slaTargetAt        DateTime?      @map("sla_target_at")
  isRecurring        Boolean        @default(false) @map("is_recurring")
  operationNote      String?        @map("operation_note") @db.VarChar(2000)
  completedAt        DateTime?      @map("completed_at")
  cancelledAt        DateTime?      @map("cancelled_at")
  cancellationReason String?        @map("cancellation_reason") @db.VarChar(1000)
  // Optimistic locking: durum geçişlerinde WHERE version = ? ile güncellenir.
  version            Int            @default(0)
  createdAt          DateTime       @default(now()) @map("created_at")
  updatedAt          DateTime       @updatedAt @map("updated_at")
  deletedAt          DateTime?      @map("deleted_at")

  createdBy    User                  @relation("TicketCreatedBy", fields: [createdByUserId], references: [id], onDelete: Restrict)
  site         Facility              @relation("TicketSite", fields: [siteId], references: [id], onDelete: Restrict)
  facility     Facility              @relation("TicketFacility", fields: [facilityId], references: [id], onDelete: Restrict)
  statusHistory TicketStatusHistory[]
  assignments  Assignment[]
  attachments  TicketAttachment[]

  @@index([siteId, status])
  @@index([createdByUserId, createdAt(sort: Desc)])
  @@index([facilityId, status])
  @@index([status, urgency, createdAt(sort: Desc)]) // operasyon kuyruğu
  @@map("tickets")
}

model TicketStatusHistory {
  id              String        @id @default(uuid()) @db.Uuid
  ticketId        String        @map("ticket_id") @db.Uuid
  // Nullable: ilk kayıt (OPEN) için önceki durum yoktur.
  previousStatus  TicketStatus? @map("previous_status")
  newStatus       TicketStatus  @map("new_status")
  changedByUserId String        @map("changed_by_user_id") @db.Uuid
  reason          String?       @db.VarChar(1000)
  metadata        Json?         @db.JsonB
  createdAt       DateTime      @default(now()) @map("created_at")

  ticket    Ticket @relation(fields: [ticketId], references: [id], onDelete: Cascade)
  changedBy User   @relation(fields: [changedByUserId], references: [id], onDelete: Restrict)

  @@index([ticketId, createdAt])
  @@map("ticket_status_history")
}

model Assignment {
  id               String           @id @default(uuid()) @db.Uuid
  ticketId         String           @map("ticket_id") @db.Uuid
  technicianId     String           @map("technician_id") @db.Uuid
  assignedByUserId String           @map("assigned_by_user_id") @db.Uuid
  assignmentStatus AssignmentStatus @default(PENDING) @map("assignment_status")
  assignedAt       DateTime         @default(now()) @map("assigned_at")
  acceptedAt       DateTime?        @map("accepted_at")
  rejectedAt       DateTime?        @map("rejected_at")
  rejectionReason  String?          @map("rejection_reason") @db.VarChar(1000)
  enRouteAt        DateTime?        @map("en_route_at")
  arrivedAt        DateTime?        @map("arrived_at")
  startedAt        DateTime?        @map("started_at")
  completedAt      DateTime?        @map("completed_at")
  resolutionNote   String?          @map("resolution_note") @db.VarChar(4000)
  isCurrent        Boolean          @default(true) @map("is_current")
  createdAt        DateTime         @default(now()) @map("created_at")
  updatedAt        DateTime         @updatedAt @map("updated_at")

  ticket     Ticket               @relation(fields: [ticketId], references: [id], onDelete: Restrict)
  technician User                 @relation("AssignmentTechnician", fields: [technicianId], references: [id], onDelete: Restrict)
  assignedBy User                 @relation("AssignmentAssignedBy", fields: [assignedByUserId], references: [id], onDelete: Restrict)
  materials  AssignmentMaterial[]
  attachments TicketAttachment[]

  // Partial unique (ticket_id) WHERE is_current -> Bölüm 6
  @@index([technicianId, assignmentStatus])
  @@index([ticketId, isCurrent])
  @@map("assignments")
}

model Material {
  id          String    @id @default(uuid()) @db.Uuid
  name        String    @db.VarChar(200)
  code        String    @unique @db.VarChar(50)
  unit        String    @db.VarChar(20) // adet, metre, kg...
  description String?   @db.VarChar(1000)
  isActive    Boolean   @default(true) @map("is_active")
  createdAt   DateTime  @default(now()) @map("created_at")
  updatedAt   DateTime  @updatedAt @map("updated_at")
  deletedAt   DateTime? @map("deleted_at")

  usages AssignmentMaterial[]

  @@map("materials")
}

model AssignmentMaterial {
  id              String     @id @default(uuid()) @db.Uuid
  assignmentId    String     @map("assignment_id") @db.Uuid
  materialId      String     @map("material_id") @db.Uuid
  quantity        Decimal    @db.Decimal(12, 3) // metre gibi kesirli birimler için 3 hane
  unitPrice       Decimal    @map("unit_price") @db.Decimal(12, 2)
  totalPrice      Decimal    @map("total_price") @db.Decimal(12, 2) // service hesaplar, DB CHECK doğrular
  suppliedBy      SuppliedBy @map("supplied_by")
  note            String?    @db.VarChar(1000)
  createdByUserId String     @map("created_by_user_id") @db.Uuid
  createdAt       DateTime   @default(now()) @map("created_at")

  assignment Assignment @relation(fields: [assignmentId], references: [id], onDelete: Cascade)
  material   Material   @relation(fields: [materialId], references: [id], onDelete: Restrict)
  createdBy  User       @relation(fields: [createdByUserId], references: [id], onDelete: Restrict)

  @@index([assignmentId])
  @@index([materialId])
  @@map("assignment_materials")
}

model TicketAttachment {
  id               String         @id @default(uuid()) @db.Uuid
  ticketId         String         @map("ticket_id") @db.Uuid
  // Nullable: sakin fotoğrafı assignment'a bağlı değildir; teknisyen fotoğrafı bağlıdır.
  assignmentId     String?        @map("assignment_id") @db.Uuid
  uploadedByUserId String         @map("uploaded_by_user_id") @db.Uuid
  attachmentType   AttachmentType @map("attachment_type")
  storageProvider  String         @map("storage_provider") @db.VarChar(30) // LOCAL | S3
  storageKey       String         @map("storage_key") @db.VarChar(500)
  originalFileName String         @map("original_file_name") @db.VarChar(255)
  mimeType         String         @map("mime_type") @db.VarChar(100)
  fileSize         Int            @map("file_size") // byte
  checksum         String         @db.VarChar(64) // SHA-256 hex
  createdAt        DateTime       @default(now()) @map("created_at")
  deletedAt        DateTime?      @map("deleted_at")

  ticket     Ticket      @relation(fields: [ticketId], references: [id], onDelete: Restrict)
  assignment Assignment? @relation(fields: [assignmentId], references: [id], onDelete: Restrict)
  uploadedBy User        @relation(fields: [uploadedByUserId], references: [id], onDelete: Restrict)

  @@index([ticketId])
  @@map("ticket_attachments")
}

model Contract {
  id                          String         @id @default(uuid()) @db.Uuid
  siteId                      String         @map("site_id") @db.Uuid
  contractNumber              String         @unique @map("contract_number") @db.VarChar(50)
  startDate                   DateTime       @map("start_date") @db.Date
  endDate                     DateTime       @map("end_date") @db.Date
  monthlyFee                  Decimal        @map("monthly_fee") @db.Decimal(12, 2)
  currency                    String         @default("TRY") @db.VarChar(3)
  billingDay                  Int            @map("billing_day") // 1-28, CHECK ile
  status                      ContractStatus @default(DRAFT)
  serviceScope                String?        @map("service_scope") @db.VarChar(2000)
  standardResponseTargetHours Int?           @map("standard_response_target_hours") // Nullable: SLA taahhüdü olmayabilir
  emergencyCoverage           Boolean        @default(false) @map("emergency_coverage")
  notes                       String?        @db.VarChar(2000)
  createdByUserId             String         @map("created_by_user_id") @db.Uuid
  createdAt                   DateTime       @default(now()) @map("created_at")
  updatedAt                   DateTime       @updatedAt @map("updated_at")
  terminatedAt                DateTime?      @map("terminated_at")
  terminationReason           String?        @map("termination_reason") @db.VarChar(1000)

  site      Facility          @relation(fields: [siteId], references: [id], onDelete: Restrict)
  createdBy User              @relation(fields: [createdByUserId], references: [id], onDelete: Restrict)
  invoices  ContractInvoice[]

  // EXCLUDE (aktif sözleşmeler için tarih aralığı çakışması) -> Bölüm 6
  @@index([siteId, status])
  @@map("contracts")
}

model ContractInvoice {
  id                 String         @id @default(uuid()) @db.Uuid
  contractId         String         @map("contract_id") @db.Uuid
  invoiceNumber      String         @unique @map("invoice_number") @db.VarChar(50)
  billingPeriodStart DateTime       @map("billing_period_start") @db.Date
  billingPeriodEnd   DateTime       @map("billing_period_end") @db.Date
  issueDate          DateTime       @map("issue_date") @db.Date
  dueDate            DateTime       @map("due_date") @db.Date
  amount             Decimal        @db.Decimal(12, 2)
  currency           String         @default("TRY") @db.VarChar(3)
  status             InvoiceStatus  @default(DRAFT)
  paidAt             DateTime?      @map("paid_at")
  paymentMethod      PaymentMethod? @map("payment_method") // Nullable: ödenmeden bilinmez
  referenceNumber    String?        @map("reference_number") @db.VarChar(100)
  note               String?        @db.VarChar(1000)
  createdAt          DateTime       @default(now()) @map("created_at")
  updatedAt          DateTime       @updatedAt @map("updated_at")

  contract Contract @relation(fields: [contractId], references: [id], onDelete: Restrict)

  @@unique([contractId, billingPeriodStart]) // aynı dönem için ikinci fatura engeli
  @@index([contractId, status])
  @@index([status, dueDate]) // OVERDUE taraması
  @@map("contract_invoices")
}

model AuditLog {
  id          String   @id @default(uuid()) @db.Uuid
  // Nullable: sistem job'ları veya kimliği doğrulanmamış OTP denemeleri.
  actorUserId String?  @map("actor_user_id") @db.Uuid
  action      String   @db.VarChar(100) // örn. TICKET_STATUS_CHANGED
  entityType  String   @map("entity_type") @db.VarChar(50)
  entityId    String   @map("entity_id") @db.Uuid
  siteId      String?  @map("site_id") @db.Uuid // Nullable: user gibi site'sız varlıklar
  beforeData  Json?    @map("before_data") @db.JsonB
  afterData   Json?    @map("after_data") @db.JsonB
  metadata    Json?    @db.JsonB
  ipAddress   String?  @map("ip_address") @db.VarChar(45)
  userAgent   String?  @map("user_agent") @db.VarChar(400)
  createdAt   DateTime @default(now()) @map("created_at")

  // Bilinçli olarak FK YOK: audit append-only'dir, hiçbir silme/kilitlenme
  // audit yazımını engellememelidir; entityType+entityId gevşek referanstır.

  @@index([entityType, entityId])
  @@index([siteId, createdAt(sort: Desc)])
  @@index([actorUserId, createdAt(sort: Desc)])
  @@map("audit_logs")
}

model OutboxEvent {
  id            String       @id @default(uuid()) @db.Uuid
  eventType     String       @map("event_type") @db.VarChar(100) // TicketCreated, TechnicianAssigned...
  aggregateType String       @map("aggregate_type") @db.VarChar(50)
  aggregateId   String       @map("aggregate_id") @db.Uuid
  payload       Json         @db.JsonB
  status        OutboxStatus @default(PENDING)
  attemptCount  Int          @default(0) @map("attempt_count")
  nextAttemptAt DateTime?    @map("next_attempt_at") // exponential backoff
  processedAt   DateTime?    @map("processed_at")
  lastError     String?      @map("last_error") @db.VarChar(2000)
  createdAt     DateTime     @default(now()) @map("created_at")

  @@index([status, nextAttemptAt])
  @@map("outbox_events")
}
```

**Ek model gerekçeleri** (istenen 16 modele ek):
- `OutboxEvent.nextAttemptAt / lastError`: retry mekanizması için gerekli, ayrı model değil alan genişletmesi.
- `Ticket.code` + `Ticket.version`: kullanıcıya okunur numara ve optimistic locking; ayrı model eklenmedi.
- Ek model **eklenmemiştir**; 16 model + enum'lar tüm iş kurallarını karşılar.

> **Uygulama notu (Faz 9):** Faz 7–8 uygulaması bu şemayı genişletti:
> `Contract.expiryNotifiedAt` alanı, `OutboxEvent.failedAt` alanı ve yeni
> `NotificationDelivery` modeli (`notification_deliveries`) eklendi; güncel
> model sayısı 17'dir. Bağlayıcı şema `prisma/schema.prisma`'dadır.
> Bkz. Bölüm 17.

---

## Bölüm 6: PostgreSQL Özel Migration'lar

Prisma migration zincirine `prisma migrate dev --create-only` ile eklenen ham SQL:

```sql
-- migrations/20260710_custom_constraints/migration.sql

-- Exclusion constraint için gerekli uzantı
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- 1) Ticket başına tek aktif assignment
CREATE UNIQUE INDEX uq_assignments_one_current_per_ticket
  ON assignments (ticket_id)
  WHERE is_current = true;

-- 2) Aynı parent altında benzersiz facility kodu (soft delete hariç)
--    Blok kodları site içinde, daire kodları blok içinde benzersiz olur.
CREATE UNIQUE INDEX uq_facilities_parent_code_alive
  ON facilities (parent_id, code)
  WHERE deleted_at IS NULL AND parent_id IS NOT NULL;

-- Kök SITE kodları da kendi aralarında benzersiz olsun
CREATE UNIQUE INDEX uq_facilities_site_code_alive
  ON facilities (code)
  WHERE deleted_at IS NULL AND type = 'SITE';

-- 3) Facility tip-alan tutarlılığı (cross-row olmayan kısım)
ALTER TABLE facilities ADD CONSTRAINT chk_facility_root
  CHECK (
    (type = 'SITE' AND parent_id IS NULL AND site_id IS NULL)
    OR
    (type <> 'SITE' AND parent_id IS NOT NULL AND site_id IS NOT NULL)
  );
-- "BLOCK yalnızca SITE altında", "UNIT yalnızca BLOCK altında",
-- "parent başka site'a ait olamaz" kuralları parent SATIRINA bakmayı
-- gerektirdiğinden FacilityValidator service'inde, transaction içinde
-- parent SELECT ... FOR SHARE ile okunarak uygulanır.

-- 4) Aynı site için tarih aralığı çakışan iki ACTIVE/SUSPENDED sözleşme engeli
ALTER TABLE contracts ADD CONSTRAINT excl_contracts_active_overlap
  EXCLUDE USING gist (
    site_id WITH =,
    daterange(start_date, end_date, '[]') WITH &&
  )
  WHERE (status IN ('ACTIVE', 'SUSPENDED'));

-- 5) Sayısal ve tarihsel bütünlük CHECK'leri
ALTER TABLE assignment_materials ADD CONSTRAINT chk_am_quantity_positive
  CHECK (quantity > 0);
ALTER TABLE assignment_materials ADD CONSTRAINT chk_am_unit_price_nonneg
  CHECK (unit_price >= 0);
ALTER TABLE assignment_materials ADD CONSTRAINT chk_am_total_consistent
  CHECK (total_price = round(quantity * unit_price, 2));

ALTER TABLE contracts ADD CONSTRAINT chk_contract_dates
  CHECK (end_date > start_date);
ALTER TABLE contracts ADD CONSTRAINT chk_contract_billing_day
  CHECK (billing_day BETWEEN 1 AND 28);
ALTER TABLE contracts ADD CONSTRAINT chk_contract_fee_nonneg
  CHECK (monthly_fee >= 0);

ALTER TABLE contract_invoices ADD CONSTRAINT chk_invoice_period
  CHECK (billing_period_end > billing_period_start);
ALTER TABLE contract_invoices ADD CONSTRAINT chk_invoice_amount_nonneg
  CHECK (amount >= 0);

-- Aynı sözleşmede çakışan fatura dönemi engeli (unique start'a ek güvence)
ALTER TABLE contract_invoices ADD CONSTRAINT excl_invoice_period_overlap
  EXCLUDE USING gist (
    contract_id WITH =,
    daterange(billing_period_start, billing_period_end, '[)') WITH &&
  )
  WHERE (status <> 'CANCELLED');

-- 6) E.164 format garantisi
ALTER TABLE users ADD CONSTRAINT chk_users_phone_e164
  CHECK (phone_number ~ '^\+[1-9][0-9]{6,14}$');
ALTER TABLE otp_challenges ADD CONSTRAINT chk_otp_phone_e164
  CHECK (phone_number ~ '^\+[1-9][0-9]{6,14}$');

-- 7) OTP deneme bütünlüğü
ALTER TABLE otp_challenges ADD CONSTRAINT chk_otp_attempts
  CHECK (attempt_count >= 0 AND attempt_count <= max_attempts);

-- 8) Aktif üyelik/oturma tekilliği
CREATE UNIQUE INDEX uq_site_membership_active
  ON site_memberships (user_id, site_id, membership_role)
  WHERE is_active = true;

CREATE UNIQUE INDEX uq_resident_unit_active
  ON resident_unit_assignments (user_id, unit_id)
  WHERE is_active = true;

-- 9) Ticket kodu için sequence
CREATE SEQUENCE IF NOT EXISTS ticket_code_seq;
```

---

## Bölüm 7: Backend Klasör Yapısı

```text
src/
  main.ts                      # bootstrap: helmet, CORS allowlist, global pipe/filter, Swagger (prod'da korumalı)
  app.module.ts

  common/                      # Framework'e yakın, domain bilmez yardımcılar
    decorators/
      roles.decorator.ts       # @Roles(...UserRole)
      current-user.decorator.ts# @CurrentUser() -> AuthenticatedUser
      public.decorator.ts      # @Public() auth bypass işareti
    guards/
      jwt-auth.guard.ts
      roles.guard.ts
      site-scope.guard.ts      # param/body siteId'yi DB üyeliğiyle doğrular
    interceptors/
      request-id.interceptor.ts
      audit-context.interceptor.ts
    filters/
      global-exception.filter.ts  # standart hata zarfı {success:false,error:{code,...}}
    pipes/
      phone-normalize.pipe.ts     # E.164
    enums/                     # Prisma enum'larından türetilen re-export (tek kaynak)
    constants/                 # magic number yasağı: OTP_LENGTH, MAX_FILE_SIZE_BYTES...
    types/                     # AuthenticatedUser, PaginatedResult<T>, DomainError kodları
    utils/
      pagination.util.ts       # cursor encode/decode
      masking.util.ts          # +90*******12 maskeleme

  config/
    configuration.ts           # tipli config factory
    validation.schema.ts       # Zod env şeması (Bölüm 15)

  infrastructure/
    database/
      prisma/
        prisma.module.ts
        prisma.service.ts      # $transaction helper, soft-delete middleware
    storage/
      storage-provider.interface.ts  # token: STORAGE_PROVIDER
      local-storage.provider.ts
      s3-storage.provider.ts
    sms/
      sms-provider.interface.ts      # token: SMS_PROVIDER
      mock-sms.provider.ts
      external-sms.provider.ts       # placeholder (Netgsm/İleti Merkezi vb.)
    logging/
      logger.module.ts               # structured JSON log, requestId korelasyonu
    events/
      outbox.service.ts              # transaction içine event yazan API
      outbox-relay.ts                # @Interval ile PENDING event'leri işler

  modules/
    auth/
      controllers/auth.controller.ts
      dto/ (request-otp.dto.ts, verify-otp.dto.ts, refresh.dto.ts)
      services/ (auth.service.ts, otp.service.ts, token.service.ts)
      guards/ strategies/ repositories/ interfaces/
      auth.module.ts
    users/            # controller/service/repository/dto/mapper/users.module.ts
    memberships/      # MembershipQueryService: tüm "erişimi var mı?" sorularının otoritesi
    facilities/       # FacilityService + FacilityValidator (hiyerarşi kuralları)
    tickets/
      controllers/ dto/ services/
      policies/ticket-authorization.policy.ts
      state/ticket-state-machine.ts
      repositories/ mappers/ tickets.module.ts
    assignments/      # AssignmentService, AssignmentAccessPolicy
    materials/
    attachments/      # AttachmentService (StorageProvider'ı kullanır)
    contracts/
    billing/          # InvoiceService
    notifications/    # NotificationDispatcher (kanal bağımsız)
    audit/            # AuditService

prisma/
  schema.prisma
  migrations/
  seed.ts

test/
  integration/       # Testcontainers PostgreSQL
  e2e/
```

**Modül içi katman sözleşmesi** (her modülde aynı):
- `controller`: HTTP/DTO/Swagger; iş kuralı YOK, Prisma YOK.
- `dto`: class-validator ile giriş doğrulama; **domain modeli değildir**.
- `service`: iş kuralları, transaction orkestrasyonu; policy çağırır.
- `policy`: kaynak bazlı yetki ("bu kullanıcı bu ticket'ı okuyabilir mi?").
- `repository`: tüm Prisma sorguları; `siteId` zorunlu parametre.
- `mapper`: Prisma satırı → response modeli (rol bazlı alan kırpma dahil: teknisyene sakin telefonu dönmez).

---

## Bölüm 8: SMS OTP ve JWT Algoritmaları (Pseudocode)

### 8.1 POST /auth/otp/request

```text
INPUT: { phoneNumber }, ctx: { ip, userAgent }

1  phone = normalizeE164(phoneNumber)            # başarısızsa VALIDATION_ERROR
2  rateLimit.check("otp:phone:" + phone,  max 3 / 10 dk)   # aşımda bile generic yanıt + audit
3  rateLimit.check("otp:ip:" + ctx.ip,    max 10 / 10 dk)
4  cooldown.check(phone, OTP_RESEND_COOLDOWN_SECONDS)

5  user = userRepo.findActiveByPhone(phone)      # deletedAt null, isActive true
6  eligible = user != null
7  IF eligible AND user.role IN (RESIDENT, SITE_MANAGER):
8      eligible = membershipQuery.hasAnyActiveSiteWithActiveContract(user.id)
   # OPERATIONS/TECHNICIAN şirket personeli: sözleşme şartı aranmaz

9  IF NOT eligible:
10     audit.log(action=OTP_REQUEST_REJECTED, metadata={phoneMasked}, actor=null)
11     RETURN 200 { message: "Numara sistemde kayıtlıysa doğrulama kodu gönderildi." }
       # ENUMERATION KORUMASI: var/yok ayrımı sızdırılmaz, süre farkı için sabit gecikme eklenir

12 TRANSACTION:
13     otpRepo.invalidateOpenChallenges(phone)   # consumedAt null olanlara invalidatedAt=now
14     code = crypto.randomInt(0, 999999) 6 haneye padlenir   # ASLA Math.random()
15     codeHash = HMAC_SHA256(OTP_HMAC_SECRET, phone + ":" + code)
16     otpRepo.create({ userId: user.id, phone, purpose: LOGIN, codeHash,
                        expiresAt: now + OTP_EXPIRES_IN_SECONDS,
                        maxAttempts: OTP_MAX_ATTEMPTS, ip, userAgent })
17 END TRANSACTION

18 TRY smsProvider.sendOtp(phone, code)          # adapter; kod HİÇBİR loga yazılmaz
19 CATCH: log(level=error, "sms_send_failed", { challengeId })  # kod içermez
          # retry: outbox'a OtpDeliveryFailed yazılır; kullanıcıya yine generic yanıt
20 audit.log(OTP_REQUESTED, metadata={ phoneMasked })
21 RETURN 200 aynı generic mesaj
```

### 8.2 POST /auth/otp/verify

```text
INPUT: { phoneNumber, code, deviceId? }, ctx: { ip, userAgent }

1  phone = normalizeE164(phoneNumber)
2  rateLimit.check("otp-verify:ip:" + ctx.ip, max 20 / 10 dk)

3  TRANSACTION (isolation: READ COMMITTED yeterli, satır kilidi kullanılır):
4      ch = SELECT * FROM otp_challenges
             WHERE phone_number = phone AND purpose='LOGIN'
               AND consumed_at IS NULL AND invalidated_at IS NULL
               AND expires_at > now()
             ORDER BY created_at DESC LIMIT 1
             FOR UPDATE                      # aynı OTP'nin çift doğrulanmasını engeller
5      IF ch IS NULL: THROW AUTH_INVALID_OTP (generic)
6      IF ch.attemptCount >= ch.maxAttempts:
7          UPDATE ch SET invalidated_at=now(); THROW AUTH_INVALID_OTP
8      incomingHash = HMAC_SHA256(OTP_HMAC_SECRET, phone + ":" + code)
9      IF NOT timingSafeEqual(incomingHash, ch.codeHash):
10         UPDATE ch SET attempt_count = attempt_count + 1
11         audit.log(OTP_VERIFY_FAILED, metadata={phoneMasked})
12         THROW AUTH_INVALID_OTP
13     UPDATE ch SET consumed_at = now()

14     user = userRepo.findActiveByPhoneWithAccess(phone)
15     IF user IS NULL OR NOT user.isActive: THROW AUTH_INVALID_OTP  # generic
16     access  = jwt.sign({ sub:user.id, role:user.role,
                            sessionId: newSessionId, tokenVersion:user.tokenVersion },
                          exp = 15m, secret = JWT_ACCESS_SECRET)
17     rawRefresh = randomBytes(48).base64url
18     refreshRepo.create({ id:newSessionId, userId:user.id,
                            tokenHash: SHA256(REFRESH_PEPPER + rawRefresh),
                            deviceId, userAgent, ip, expiresAt: now + 30d })
19     userRepo.touchLastLogin(user.id)
20     audit.log(OTP_VERIFY_SUCCESS)
21 END TRANSACTION

22 RETURN { accessToken: access, refreshToken: rawRefresh,
            expiresIn: 900, user: { id, role, fullName } }
   # JWT'de telefon, adres, site listesi YOK. Erişim listesi her istekte DB'den doğrulanır.
```

### 8.3 POST /auth/token/refresh (rotation + reuse detection)

```text
INPUT: { refreshToken }

1  hash = SHA256(REFRESH_PEPPER + refreshToken)
2  TRANSACTION:
3      s = SELECT * FROM refresh_sessions WHERE token_hash = hash FOR UPDATE
4      IF s IS NULL: THROW AUTH_INVALID_REFRESH
5      IF s.revokedAt IS NOT NULL:
6          # REUSE DETECTION: rotate edilmiş token tekrar kullanıldı -> çalınma şüphesi
7          refreshRepo.revokeAllForUser(s.userId)
8          audit.log(REFRESH_TOKEN_REUSE_DETECTED, metadata={sessionId:s.id})
9          THROW AUTH_INVALID_REFRESH
10     IF s.expiresAt < now(): THROW AUTH_INVALID_REFRESH
11     user = userRepo.findActiveById(s.userId)
12     IF user IS NULL OR NOT user.isActive: revoke(s); THROW AUTH_INVALID_REFRESH
13     newRaw = randomBytes(48).base64url
14     newSession = refreshRepo.create({ userId, tokenHash:SHA256(pepper+newRaw), ... })
15     UPDATE s SET revoked_at=now(), replaced_by_token_id=newSession.id, last_used_at=now()
16     access = jwt.sign({ sub, role, sessionId:newSession.id, tokenVersion })
17 END TRANSACTION
18 RETURN { accessToken, refreshToken: newRaw }
```

### 8.4 POST /auth/logout

```text
1  hash = SHA256(pepper + body.refreshToken)
2  UPDATE refresh_sessions SET revoked_at=now() WHERE token_hash=hash AND revoked_at IS NULL
3  audit.log(REFRESH_TOKEN_REVOKED)
4  RETURN 204   # token bulunamasa bile 204 (enumeration koruması)
```

### JWT payload

```json
{ "sub": "uuid", "role": "RESIDENT", "sessionId": "uuid", "tokenVersion": 3, "iat": 0, "exp": 0 }
```

`JwtAuthGuard` her istekte `tokenVersion`'ı kullanıcının DB/cache'teki değeriyle karşılaştırır; rol veya erişim değişikliğinde `tokenVersion++` yapılır ve eski access token'lar 15 dk beklemeden düşer.

---

## Bölüm 9: RBAC ve Kaynak Bazlı Yetkilendirme Matrisi

✔ = izinli (kaynak koşuluyla), ✖ = yasak. "Koşul" sütunu policy'nin DB'den doğruladığı ilişkidir.

| İşlem | RESIDENT | SITE_MANAGER | OPERATIONS | TECHNICIAN | Kaynak koşulu |
|---|---|---|---|---|---|
| Ticket oluştur | ✔ | ✔ | ✔ | ✖ | R: aktif unit assignment'ı olan daire; SM: kendi sitesindeki facility |
| Ticket oku | ✔ | ✔ | ✔ | ✔ | R: createdBy=ben; SM: ticket.siteId ∈ yönettiğim siteler; OP: aktif sözleşmeli site; T: bana ait assignment var |
| Ticket listele | ✔ (kendi) | ✔ (site) | ✔ (tümü) | ✔ (atandıklarım) | repository filtresi role göre zorunlu |
| Ticket güncelle (başlık/açıklama) | ✔ (OPEN iken, kendi) | ✔ (site, OPEN/TRIAGED) | ✔ | ✖ | — |
| Ticket iptal | ✔ (kendi, OPEN) | ✔ (site, OPEN/TRIAGED) | ✔ (OPEN/TRIAGED/ASSIGNED) | ✖ | state machine + gerekçe zorunlu |
| Triage / sınıflandırma | ✖ | ✖ | ✔ | ✖ | — |
| Teknisyen atama / değiştirme | ✖ | ✖ | ✔ | ✖ | site aktif sözleşmeli |
| Atama kabul/ret | ✖ | ✖ | ✖ | ✔ | assignment.technicianId=ben, status=PENDING |
| Teknisyen durum geçişleri (EN_ROUTE…COMPLETED) | ✖ | ✖ | ✔ (istisnai) | ✔ | aktif assignment bana ait |
| COMPLETED → CLOSED | ✖ | ✖ | ✔ | ✖ | — |
| COMPLETED → IN_PROGRESS (yeniden aç) | ✖ | ✖ | ✔ (gerekçe zorunlu) | ✖ | — |
| Malzeme ekle | ✖ | ✖ | ✔ | ✔ | T: aktif assignment bana ait |
| Malzeme oku | ✖ | ✔ (site ticket'ları) | ✔ | ✔ (kendi işi) | — |
| Fotoğraf yükle | ✔ (kendi ticket) | ✔ (site ticket) | ✔ | ✔ (kendi assignment) | tip kısıtı: T yalnız BEFORE/AFTER/MATERIAL |
| Fotoğraf görüntüle (signed URL) | ✔ (kendi ticket) | ✔ (site) | ✔ | ✔ (kendi işi) | erişimde ticket policy TEKRAR çalışır |
| Durum geçmişi oku | ✔ (kendi) | ✔ (site) | ✔ | ✔ (kendi işi) | — |
| Sakin ekle / unit eşleştir | ✖ | ✔ (kendi sitesi) | ✔ | ✖ | SM: hedef unit kendi sitesinde |
| Kullanıcı pasifleştir | ✖ | ✔ (kendi sitesinin sakini) | ✔ | ✖ | — |
| Telefon numarası değiştir | ✖ | ✔ (kendi sitesinin sakini) | ✖ (varsayılan) | ✖ | audit zorunlu |
| Site/blok/daire oluştur | ✖ | ✖ | ✔ | ✖ | — |
| Facility ağacı görüntüle | ✖ | ✔ (kendi sitesi) | ✔ | ✖ | — |
| Sözleşme oluştur/güncelle | ✖ | ✖ | ✔ | ✖ | — |
| Sözleşme görüntüle | ✖ | ✔ (kendi sitesi, salt okuma) | ✔ | ✖ | — |
| Fatura oluştur / durum değiştir | ✖ | ✖ | ✔ | ✖ | — |
| Fatura görüntüle | ✖ | ✔ (kendi sitesi) | ✔ | ✖ | — |
| Audit log okuma | ✖ | ✖ | ✔ (site filtresiyle) | ✖ | — |

**Guard zinciri** (sırayla): `JwtAuthGuard → RolesGuard → SiteScopeGuard/TicketAccessGuard/AssignmentAccessGuard` → service içinde policy tekrar çağrılır (guard atlansa bile ikinci hat).

---

## Bölüm 10: Ticket State Machine

### Geçiş tablosu

| Mevcut | Hedef | İzinli roller | Not |
|---|---|---|---|
| OPEN | TRIAGED | OPERATIONS | kategori/aciliyet düzeltilebilir |
| OPEN | CANCELLED | RESIDENT (kendi), SITE_MANAGER (site), OPERATIONS | gerekçe zorunlu |
| TRIAGED | ASSIGNED | OPERATIONS | assignment transaction'ı tetikler |
| TRIAGED | CANCELLED | SITE_MANAGER (site), OPERATIONS | |
| ASSIGNED | ACCEPTED | TECHNICIAN (atanan) | assignment PENDING→ACCEPTED/ACTIVE |
| ASSIGNED | REJECTED | TECHNICIAN (atanan) | rejectionReason zorunlu |
| ASSIGNED | CANCELLED | OPERATIONS | aktif assignment CANCELLED yapılır |
| REJECTED | ASSIGNED | OPERATIONS | yeni assignment oluşturulur |
| ACCEPTED | EN_ROUTE | TECHNICIAN | assignment.enRouteAt |
| EN_ROUTE | ARRIVED | TECHNICIAN | arrivedAt |
| ARRIVED | IN_PROGRESS | TECHNICIAN | startedAt |
| IN_PROGRESS | WAITING_MATERIAL | TECHNICIAN, OPERATIONS | |
| WAITING_MATERIAL | IN_PROGRESS | TECHNICIAN, OPERATIONS | |
| IN_PROGRESS | COMPLETED | TECHNICIAN | resolutionNote önerilir; completedAt |
| COMPLETED | CLOSED | OPERATIONS | |
| COMPLETED | IN_PROGRESS | OPERATIONS | yeniden açma; reason ZORUNLU |

Bunlar dışındaki her geçiş **geçersizdir**.

### Geçersiz geçiş davranışı

```json
HTTP 409
{ "success": false,
  "error": { "code": "TICKET_INVALID_STATUS_TRANSITION",
             "message": "COMPLETED durumundan EN_ROUTE durumuna geçiş yapılamaz.",
             "requestId": "..." } }
```

Yetkili olmayan rol için geçerli geçişte ise `403 TICKET_TRANSITION_FORBIDDEN` döner (varlık sızdırmamak için ticket'a hiç erişimi olmayan kullanıcıya `404 TICKET_NOT_FOUND`).

### Uygulama iskeleti

```typescript
// modules/tickets/state/ticket-state-machine.ts
type TransitionRule = { to: TicketStatus; roles: UserRole[]; requiresReason?: boolean };

const TRANSITIONS: Record<TicketStatus, TransitionRule[]> = {
  OPEN: [
    { to: 'TRIAGED', roles: ['OPERATIONS'] },
    { to: 'CANCELLED', roles: ['RESIDENT', 'SITE_MANAGER', 'OPERATIONS'], requiresReason: true },
  ],
  TRIAGED: [
    { to: 'ASSIGNED', roles: ['OPERATIONS'] },
    { to: 'CANCELLED', roles: ['SITE_MANAGER', 'OPERATIONS'], requiresReason: true },
  ],
  ASSIGNED: [
    { to: 'ACCEPTED', roles: ['TECHNICIAN'] },
    { to: 'REJECTED', roles: ['TECHNICIAN'], requiresReason: true },
    { to: 'CANCELLED', roles: ['OPERATIONS'], requiresReason: true },
  ],
  REJECTED: [{ to: 'ASSIGNED', roles: ['OPERATIONS'] }],
  ACCEPTED: [{ to: 'EN_ROUTE', roles: ['TECHNICIAN'] }],
  EN_ROUTE: [{ to: 'ARRIVED', roles: ['TECHNICIAN'] }],
  ARRIVED: [{ to: 'IN_PROGRESS', roles: ['TECHNICIAN'] }],
  IN_PROGRESS: [
    { to: 'WAITING_MATERIAL', roles: ['TECHNICIAN', 'OPERATIONS'] },
    { to: 'COMPLETED', roles: ['TECHNICIAN'] },
  ],
  WAITING_MATERIAL: [{ to: 'IN_PROGRESS', roles: ['TECHNICIAN', 'OPERATIONS'] }],
  COMPLETED: [
    { to: 'CLOSED', roles: ['OPERATIONS'] },
    { to: 'IN_PROGRESS', roles: ['OPERATIONS'], requiresReason: true }, // yeniden açma
  ],
  CLOSED: [],
  CANCELLED: [],
};

export class TicketStateMachine {
  /** Geçiş kurallarını doğrular; rol dışı sahiplik kontrolü policy'dedir. */
  assertTransition(from: TicketStatus, to: TicketStatus, role: UserRole, reason?: string): void {
    const rule = TRANSITIONS[from]?.find((r) => r.to === to);
    if (!rule) throw new DomainError('TICKET_INVALID_STATUS_TRANSITION', { from, to }, 409);
    if (!rule.roles.includes(role)) throw new DomainError('TICKET_TRANSITION_FORBIDDEN', { from, to }, 403);
    if (rule.requiresReason && !reason?.trim())
      throw new DomainError('TICKET_TRANSITION_REASON_REQUIRED', { from, to }, 422);
  }
}
```

---

## Bölüm 11: REST API Listesi

Genel kurallar:
- Base path: `/api/v1`. Tüm cevaplar `{ success, data | error }` zarfındadır.
- **Pagination**: cursor tabanlı (`?cursor=...&limit=20`). Gerekçe: ticket listeleri sürekli büyür ve yeni kayıt eklenirken offset kayması yaşanır; cursor (createdAt DESC, id) index'iyle O(log n) çalışır ve derin sayfalarda offset gibi yavaşlamaz. Küçük ve sabit listelerde (facility ağacı) pagination yoktur.
- Ortak hata kodları: `401 AUTH_REQUIRED`, `403 *_FORBIDDEN`, `404 *_NOT_FOUND`, `409 *_CONFLICT`, `422 VALIDATION_ERROR`, `429 RATE_LIMITED`.
- Erişimi olmayan kaynaklarda 403 yerine **404** dönerek varlık sızdırılmaz (IDOR yanıt politikası).

> **Uygulama notu (Faz 9):** Uygulamada yalnız **hata** yanıtları
> `{ success: false, error: { code, message, requestId, timestamp } }`
> zarfındadır (`src/common/filters/global-exception.filter.ts`); **başarı**
> yanıtları zarfsız, çıplak DTO döner (global TransformInterceptor yoktur).
> Aşağıdaki endpoint tabloları başlangıç tasarımıdır; bağlayıcı katalog
> controller'lardadır. Bkz. Bölüm 17.

### Auth (`@Public` olanlar hariç JwtAuthGuard)

| Method | URL | Roller | DTO | Yanıt / Hatalar |
|---|---|---|---|---|
| POST | /auth/otp/request | public | `RequestOtpDto { phoneNumber }` | 200 generic mesaj · 429 |
| POST | /auth/otp/verify | public | `VerifyOtpDto { phoneNumber, code, deviceId? }` | 200 token çifti · 401 AUTH_INVALID_OTP · 429 |
| POST | /auth/token/refresh | public | `RefreshDto { refreshToken }` | 200 yeni çift · 401 AUTH_INVALID_REFRESH |
| POST | /auth/logout | tüm roller | `RefreshDto` | 204 |
| GET | /auth/me | tüm roller | — | 200 { id, role, fullName, memberships } |

### Users

| Method | URL | Roller | Kaynak kontrolü | DTO |
|---|---|---|---|---|
| POST | /sites/:siteId/residents | SITE_MANAGER, OPERATIONS | SM: siteId üyeliği (SiteScopeGuard) | `CreateResidentDto { phoneNumber, firstName, lastName, unitId, isPrimary? }` — unitId'nin **bu siteye ait UNIT** olduğu service'te doğrulanır |
| GET | /sites/:siteId/users | SITE_MANAGER, OPERATIONS | SM: site üyeliği | cursor pagination |
| PATCH | /users/:id | SITE_MANAGER, OPERATIONS | SM: hedef kullanıcı kendi sitesinin sakini | `UpdateUserDto { firstName?, lastName?, phoneNumber? }` (telefon değişimi audit + tokenVersion++) |
| POST | /users/:id/deactivate | SITE_MANAGER, OPERATIONS | aynı | gerekçe alanı; tüm refresh session revoke |

Hatalar: `409 USER_PHONE_ALREADY_EXISTS`, `404 UNIT_NOT_FOUND`.

### Facilities

| Method | URL | Roller | DTO / kural |
|---|---|---|---|
| POST | /facilities/sites | OPERATIONS | `CreateSiteDto { name, code }` |
| POST | /facilities/sites/:siteId/blocks | OPERATIONS | `CreateBlockDto { name, code }` — parent tipi SITE doğrulanır |
| POST | /facilities/blocks/:blockId/units | OPERATIONS | `CreateUnitDto { code, name? }` — parent tipi BLOCK, siteId parent'tan devralınır |
| POST | /facilities/:parentId/common-areas | OPERATIONS | `CreateCommonAreaDto { name, code }` — parent SITE veya BLOCK |
| GET | /facilities/sites/:siteId/tree | SITE_MANAGER, OPERATIONS | SM: SiteScopeGuard; tek sorgu `WHERE site_id=? OR id=?`, bellekte ağaç kurulur (N+1 yok) |

Hatalar: `409 FACILITY_CODE_CONFLICT`, `422 FACILITY_INVALID_PARENT`.

### Tickets

| Method | URL | Roller | Kaynak kontrolü |
|---|---|---|---|
| POST | /tickets | RESIDENT, SITE_MANAGER, OPERATIONS | `CreateTicketDto { facilityId, title, description, category, urgency }` — siteId **client'tan alınmaz**, facility'den türetilir; R: facility kendi aktif unit'i; SM: facility kendi sitesinde |
| GET | /tickets | 4 rol | role göre zorunlu filtre: R kendi, SM sitesi (`?siteId` üyelik doğrulamalı), OP tümü (`?siteId,status,urgency`), T atandıkları |
| GET | /tickets/:id | 4 rol | TicketAccessGuard + policy (matris B.9) |
| PATCH | /tickets/:id | R (OPEN, kendi), SM, OPERATIONS | `UpdateTicketDto { title?, description?, category?, urgency?, operationNote? }` — operationNote yalnız OP |
| POST | /tickets/:id/status | role göre | `ChangeTicketStatusDto { toStatus, reason?, metadata? }` — state machine |
| POST | /tickets/:id/cancel | R, SM, OPERATIONS | `CancelTicketDto { reason }` — state machine kısıtları |
| GET | /tickets/:id/history | erişimi olan | ticket policy tekrar |
| POST | /tickets/:id/attachments | erişimi olan | multipart; MIME allowlist (jpeg/png/webp), `MAX_FILE_SIZE_BYTES` (10 MB); T yalnız kendi assignment'ına |
| GET | /attachments/:id/url | erişimi olan | ticket policy TEKRAR çalışır → 5 dk'lık signed URL döner |

Hatalar: `409 TICKET_INVALID_STATUS_TRANSITION`, `403 TICKET_TRANSITION_FORBIDDEN`, `404 TICKET_NOT_FOUND`, `422 ATTACHMENT_TYPE_NOT_ALLOWED`.

### Assignments

| Method | URL | Roller | Kural |
|---|---|---|---|
| POST | /tickets/:ticketId/assignments | OPERATIONS | `CreateAssignmentDto { technicianId }` — technicianId'nin role=TECHNICIAN, aktif kullanıcı olduğu doğrulanır; yeniden atama akışı Bölüm 12/13 |
| POST | /assignments/:id/accept | TECHNICIAN | AssignmentAccessGuard: technicianId=ben, status=PENDING |
| POST | /assignments/:id/reject | TECHNICIAN | `RejectAssignmentDto { reason }` |
| POST | /assignments/:id/status | TECHNICIAN, OPERATIONS | `UpdateAssignmentStatusDto { event: EN_ROUTE\|ARRIVED\|START\|WAIT_MATERIAL\|RESUME\|COMPLETE, note? }` — ticket state machine ile senkron |
| GET | /assignments/my | TECHNICIAN | cursor pagination; yalnız kendi kayıtları; sakin PII'ı mapper'da kırpılır |
| POST | /assignments/:id/materials | TECHNICIAN, OPERATIONS | `AddMaterialDto { materialId, quantity, unitPrice, suppliedBy, note? }` — total service'te hesaplanır |
| GET | /assignments/:id/materials | erişimi olanlar | — |

### Contracts & Billing

| Method | URL | Roller | Kural |
|---|---|---|---|
| POST | /contracts | OPERATIONS | `CreateContractDto` — tarih tutarlılığı DTO'da, çakışma DB EXCLUDE + ön kontrol |
| PATCH | /contracts/:id | OPERATIONS | durum geçişi: DRAFT→ACTIVE→SUSPENDED/EXPIRED/TERMINATED |
| GET | /sites/:siteId/contracts | SITE_MANAGER (salt oku), OPERATIONS | SM: SiteScopeGuard |
| POST | /contracts/:id/invoices | OPERATIONS | `CreateInvoiceDto` — dönem sözleşme aralığı içinde, çakışma engeli |
| PATCH | /invoices/:id/status | OPERATIONS | `UpdateInvoiceStatusDto { status, paidAt?, paymentMethod?, referenceNumber? }` — PAID için paidAt+method zorunlu |
| GET | /sites/:siteId/invoices | SITE_MANAGER, OPERATIONS | — |

Hatalar: `409 CONTRACT_OVERLAP`, `409 INVOICE_PERIOD_OVERLAP`, `422 INVOICE_PERIOD_OUT_OF_CONTRACT`.

### Health

| Method | URL | Açıklama |
|---|---|---|
| GET | /health/liveness | süreç ayakta mı (yalnız event loop) |
| GET | /health/readiness | DB `SELECT 1`; SMS provider durumu **degraded** olarak raporlanır, readiness'ı düşürmez |

---

## Bölüm 12: Kritik Servis Örnekleri

Aşağıdaki iskeletler strict TypeScript'tir; hata sınıfı `DomainError(code, meta, httpStatus)` global filter'da standart zarfa çevrilir.

### SmsProvider

```typescript
// infrastructure/sms/sms-provider.interface.ts
export const SMS_PROVIDER = Symbol('SMS_PROVIDER');

export interface SmsProvider {
  sendOtp(phoneE164: string, code: string): Promise<void>;
  sendTicketNotification(phoneE164: string, message: string): Promise<void>;
  sendEmergencyAlert(phoneE164: string, message: string): Promise<void>;
  healthCheck(): Promise<{ healthy: boolean; detail?: string }>;
}

// mock-sms.provider.ts (development)
@Injectable()
export class MockSmsProvider implements SmsProvider {
  private readonly logger = new Logger(MockSmsProvider.name);
  async sendOtp(phone: string): Promise<void> {
    // DİKKAT: OTP kodu bilinçli olarak log parametresi DEĞİLDİR.
    this.logger.debug(`[MOCK SMS] OTP gönderildi -> ${maskPhone(phone)}`);
  }
  async sendTicketNotification(phone: string, message: string): Promise<void> {
    this.logger.debug(`[MOCK SMS] ${maskPhone(phone)}: ${message}`);
  }
  async sendEmergencyAlert(phone: string, message: string): Promise<void> {
    this.logger.warn(`[MOCK SMS/EMERGENCY] ${maskPhone(phone)}: ${message}`);
  }
  async healthCheck() { return { healthy: true }; }
}

// external-sms.provider.ts (production placeholder — Netgsm vb.)
@Injectable()
export class ExternalSmsProvider implements SmsProvider {
  constructor(private readonly http: HttpService, private readonly config: ConfigService) {}
  async sendOtp(phone: string, code: string): Promise<void> {
    // Sağlayıcı API çağrısı; timeout + tek retry; hata durumunda SmsDeliveryError fırlatır.
    // İstek/yanıt logunda code alanı redact edilir.
  }
  /* diğer metodlar benzer */
  async healthCheck() { /* sağlayıcı ping endpoint'i */ return { healthy: true }; }
}
```

### StorageProvider

> **Uygulama notu (Faz 9):** Uygulanan interface farklıdır
> (`finalize` / `openReadStream` / `delete` / `deleteTemp`,
> `src/infrastructure/storage/storage-provider.interface.ts`). Yalnız
> `LocalStorageProvider` mevcuttur; S3 implementasyonu ve signed URL yoktur.
> İndirme, kimlik doğrulamalı streaming `GET /attachments/:id/download`
> endpoint'iyle yapılır. Bkz. Bölüm 17.

```typescript
// infrastructure/storage/storage-provider.interface.ts
export const STORAGE_PROVIDER = Symbol('STORAGE_PROVIDER');

export interface PutObjectInput {
  key: string; body: Buffer; mimeType: string;
}

export interface StorageProvider {
  putObject(input: PutObjectInput): Promise<{ storageKey: string; checksum: string }>;
  getSignedUrl(storageKey: string, ttlSeconds: number): Promise<string>;
  deleteObject(storageKey: string): Promise<void>;
  // Genişleme noktası: ileride putObject öncesi VirusScanner adapter'ı zincire eklenir.
}

// s3-storage.provider.ts — S3 uyumlu (MinIO dev, AWS/GCS prod)
@Injectable()
export class S3StorageProvider implements StorageProvider {
  async putObject({ key, body, mimeType }: PutObjectInput) {
    const checksum = createHash('sha256').update(body).digest('hex');
    await this.s3.send(new PutObjectCommand({
      Bucket: this.bucket, Key: key, Body: body,
      ContentType: mimeType, ACL: undefined, // public ACL ASLA verilmez
    }));
    return { storageKey: key, checksum };
  }
  async getSignedUrl(key: string, ttl: number) {
    return getSignedUrl(this.s3, new GetObjectCommand({ Bucket: this.bucket, Key: key }), { expiresIn: ttl });
  }
  async deleteObject(key: string) { /* ... */ }
}
```

### OtpService

```typescript
@Injectable()
export class OtpService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly otpRepo: OtpChallengeRepository,
    private readonly userRepo: UserRepository,
    private readonly membershipQuery: MembershipQueryService,
    @Inject(SMS_PROVIDER) private readonly sms: SmsProvider,
    private readonly rateLimiter: RateLimiterService,
    private readonly audit: AuditService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  async requestOtp(rawPhone: string, ctx: RequestContext): Promise<void> {
    const phone = normalizeE164(rawPhone);
    await this.rateLimiter.consume(`otp:phone:${phone}`, { points: 3, durationSec: 600 });
    await this.rateLimiter.consume(`otp:ip:${ctx.ip}`, { points: 10, durationSec: 600 });

    const user = await this.userRepo.findActiveByPhone(phone);
    const eligible = user !== null && (await this.isLoginEligible(user));

    if (!eligible) {
      // Enumeration koruması: sessizce çık, timing farkını kapatmak için sabit bekleme.
      await this.audit.log({ action: 'OTP_REQUEST_REJECTED', entityType: 'OtpChallenge',
        entityId: NIL_UUID, metadata: { phone: maskPhone(phone) }, ip: ctx.ip });
      await constantDelay();
      return;
    }

    const code = generateNumericOtp(OTP_LENGTH); // crypto.randomInt tabanlı
    const codeHash = hmacSha256(this.config.get('otp.hmacSecret'), `${phone}:${code}`);

    await this.prisma.$transaction(async (tx) => {
      await this.otpRepo.invalidateOpen(tx, phone);
      await this.otpRepo.create(tx, {
        userId: user!.id, phoneNumber: phone, purpose: 'LOGIN', codeHash,
        expiresAt: addSeconds(new Date(), this.config.get('otp.expiresInSeconds')),
        maxAttempts: this.config.get('otp.maxAttempts'),
        requestedIp: ctx.ip, userAgent: ctx.userAgent,
      });
    });

    try {
      await this.sms.sendOtp(phone, code); // code hiçbir log satırına girmez
    } catch {
      // Kayıt duruyor; kullanıcı cooldown sonrası tekrar isteyebilir. Teslimat hatası audit'e düşer.
      await this.audit.log({ action: 'OTP_DELIVERY_FAILED', entityType: 'OtpChallenge',
        entityId: NIL_UUID, metadata: { phone: maskPhone(phone) } });
    }
  }

  /** Doğrulama: satır kilidi ile çift tüketim engellenir. Başarıda challenge döner. */
  async verifyOtp(rawPhone: string, code: string): Promise<{ userId: string }> {
    const phone = normalizeE164(rawPhone);
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<OtpRow[]>`
        SELECT * FROM otp_challenges
        WHERE phone_number = ${phone} AND purpose = 'LOGIN'
          AND consumed_at IS NULL AND invalidated_at IS NULL AND expires_at > now()
        ORDER BY created_at DESC LIMIT 1 FOR UPDATE`;
      const ch = rows[0];
      if (!ch) throw new DomainError('AUTH_INVALID_OTP', {}, 401);

      if (ch.attempt_count >= ch.max_attempts) {
        await this.otpRepo.invalidate(tx, ch.id);
        throw new DomainError('AUTH_INVALID_OTP', {}, 401);
      }

      const incoming = hmacSha256(this.config.get('otp.hmacSecret'), `${phone}:${code}`);
      if (!timingSafeEqualHex(incoming, ch.code_hash)) {
        await this.otpRepo.incrementAttempt(tx, ch.id);
        throw new DomainError('AUTH_INVALID_OTP', {}, 401);
      }

      await this.otpRepo.consume(tx, ch.id);
      if (!ch.user_id) throw new DomainError('AUTH_INVALID_OTP', {}, 401);
      return { userId: ch.user_id };
    });
  }

  private async isLoginEligible(user: User): Promise<boolean> {
    if (user.role === 'OPERATIONS' || user.role === 'TECHNICIAN') return true;
    return this.membershipQuery.hasAnyActiveSiteWithActiveContract(user.id);
  }
}
```

### TokenService

```typescript
@Injectable()
export class TokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly refreshRepo: RefreshSessionRepository,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppConfig, true>,
    private readonly audit: AuditService,
  ) {}

  async issuePair(user: Pick<User, 'id' | 'role' | 'tokenVersion'>, ctx: RequestContext) {
    const raw = randomBytes(48).toString('base64url');
    const session = await this.refreshRepo.create({
      userId: user.id,
      tokenHash: this.hashRefresh(raw),
      deviceId: ctx.deviceId ?? null,
      userAgent: ctx.userAgent ?? null,
      ipAddress: ctx.ip,
      expiresAt: addSeconds(new Date(), this.config.get('auth.refreshTtlSeconds')),
    });
    const accessToken = await this.jwt.signAsync(
      { sub: user.id, role: user.role, sessionId: session.id, tokenVersion: user.tokenVersion },
      { expiresIn: this.config.get('auth.accessTtlSeconds') },
    );
    return { accessToken, refreshToken: raw, expiresIn: this.config.get('auth.accessTtlSeconds') };
  }

  async rotate(rawRefresh: string, ctx: RequestContext) {
    return this.prisma.$transaction(async (tx) => {
      const session = await this.refreshRepo.findByHashForUpdate(tx, this.hashRefresh(rawRefresh));
      if (!session) throw new DomainError('AUTH_INVALID_REFRESH', {}, 401);

      if (session.revokedAt) {
        // REUSE DETECTION: çalınma varsayımıyla kullanıcının tüm oturumları düşürülür.
        await this.refreshRepo.revokeAllForUser(tx, session.userId);
        await this.audit.log({ action: 'REFRESH_TOKEN_REUSE_DETECTED',
          entityType: 'RefreshSession', entityId: session.id, actorUserId: session.userId });
        throw new DomainError('AUTH_INVALID_REFRESH', {}, 401);
      }
      if (session.expiresAt < new Date()) throw new DomainError('AUTH_INVALID_REFRESH', {}, 401);

      const user = await tx.user.findFirst({
        where: { id: session.userId, isActive: true, deletedAt: null },
        select: { id: true, role: true, tokenVersion: true },
      });
      if (!user) throw new DomainError('AUTH_INVALID_REFRESH', {}, 401);

      const pair = await this.issuePairInTx(tx, user, ctx);
      await this.refreshRepo.markRotated(tx, session.id, pair.sessionId);
      return pair;
    });
  }

  async revoke(rawRefresh: string): Promise<void> {
    await this.refreshRepo.revokeByHash(this.hashRefresh(rawRefresh));
  }

  private hashRefresh(raw: string): string {
    return createHash('sha256')
      .update(this.config.get('auth.refreshPepper') + raw)
      .digest('hex');
  }
}
```

### AuthService

```typescript
@Injectable()
export class AuthService {
  constructor(
    private readonly otpService: OtpService,
    private readonly tokenService: TokenService,
    private readonly userRepo: UserRepository,
    private readonly audit: AuditService,
    private readonly prisma: PrismaService,
  ) {}

  async requestOtp(dto: RequestOtpDto, ctx: RequestContext): Promise<GenericMessage> {
    await this.otpService.requestOtp(dto.phoneNumber, ctx);
    // Her koşulda aynı cevap (enumeration koruması)
    return { message: 'Numara sistemde kayıtlıysa doğrulama kodu gönderildi.' };
  }

  async verifyOtp(dto: VerifyOtpDto, ctx: RequestContext): Promise<TokenPairResponse> {
    const { userId } = await this.otpService.verifyOtp(dto.phoneNumber, dto.code);
    const user = await this.userRepo.findActiveById(userId);
    if (!user) throw new DomainError('AUTH_INVALID_OTP', {}, 401);

    const pair = await this.tokenService.issuePair(user, { ...ctx, deviceId: dto.deviceId });
    await this.userRepo.touchLastLogin(user.id);
    await this.audit.log({ action: 'AUTH_LOGIN_SUCCESS', entityType: 'User',
      entityId: user.id, actorUserId: user.id, ip: ctx.ip });
    return { ...pair, user: { id: user.id, role: user.role, fullName: `${user.firstName} ${user.lastName}` } };
  }
}
```

### TicketAuthorizationPolicy

```typescript
@Injectable()
export class TicketAuthorizationPolicy {
  constructor(
    private readonly membershipQuery: MembershipQueryService,
    private readonly assignmentRepo: AssignmentRepository,
    private readonly contractQuery: ContractQueryService,
  ) {}

  /** Okuma yetkisi yoksa 404 fırlatır (varlık sızdırma koruması). */
  async assertCanRead(user: AuthenticatedUser, ticket: Ticket): Promise<void> {
    switch (user.role) {
      case 'RESIDENT':
        if (ticket.createdByUserId !== user.id) this.deny();
        // Site ilişkisi hâlâ aktif mi? (taşınan sakin eski site verisini göremez)
        if (!(await this.membershipQuery.hasActiveSiteMembership(user.id, ticket.siteId))) this.deny();
        return;
      case 'SITE_MANAGER':
        if (!(await this.membershipQuery.hasActiveManagerMembership(user.id, ticket.siteId))) this.deny();
        return;
      case 'TECHNICIAN':
        if (!(await this.assignmentRepo.existsForTechnician(ticket.id, user.id))) this.deny();
        return;
      case 'OPERATIONS':
        return; // şirket personeli; istenirse contractQuery.isSiteActive(ticket.siteId) şartı eklenir
    }
  }

  async assertCanCancel(user: AuthenticatedUser, ticket: Ticket): Promise<void> {
    await this.assertCanRead(user, ticket);
    if (user.role === 'RESIDENT' && ticket.status !== 'OPEN')
      throw new DomainError('TICKET_TRANSITION_FORBIDDEN', {}, 403);
    if (user.role === 'SITE_MANAGER' && !['OPEN', 'TRIAGED'].includes(ticket.status))
      throw new DomainError('TICKET_TRANSITION_FORBIDDEN', {}, 403);
    if (user.role === 'TECHNICIAN') throw new DomainError('TICKET_TRANSITION_FORBIDDEN', {}, 403);
  }

  private deny(): never {
    throw new DomainError('TICKET_NOT_FOUND', {}, 404);
  }
}
```

### TicketService

```typescript
@Injectable()
export class TicketService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ticketRepo: TicketRepository,
    private readonly facilityRepo: FacilityRepository,
    private readonly membershipQuery: MembershipQueryService,
    private readonly unitQuery: ResidentUnitQueryService,
    private readonly policy: TicketAuthorizationPolicy,
    private readonly stateMachine: TicketStateMachine,
    private readonly contractQuery: ContractQueryService,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
  ) {}

  async create(user: AuthenticatedUser, dto: CreateTicketDto, ctx: RequestContext) {
    // 1) Facility gerçek mi? siteId CLIENT'TAN DEĞİL facility'den türetilir.
    const facility = await this.facilityRepo.findAliveById(dto.facilityId);
    if (!facility || facility.type === 'SITE') throw new DomainError('FACILITY_NOT_FOUND', {}, 404);
    const siteId = facility.siteId!;

    // 2) Rol bazlı oluşturma yetkisi
    if (user.role === 'RESIDENT') {
      if (facility.type !== 'UNIT') throw new DomainError('TICKET_FACILITY_FORBIDDEN', {}, 403);
      const ok = await this.unitQuery.hasActiveAssignment(user.id, facility.id);
      if (!ok) throw new DomainError('TICKET_FACILITY_FORBIDDEN', {}, 403);
    } else if (user.role === 'SITE_MANAGER') {
      const ok = await this.membershipQuery.hasActiveManagerMembership(user.id, siteId);
      if (!ok) throw new DomainError('FACILITY_NOT_FOUND', {}, 404);
    } else if (user.role === 'TECHNICIAN') {
      throw new DomainError('TICKET_CREATE_FORBIDDEN', {}, 403);
    }

    // 3) SLA hedefi aktif sözleşmeden hesaplanır
    const contract = await this.contractQuery.findActiveForSite(siteId);
    const slaTargetAt = computeSlaTarget(dto.urgency, contract);

    // 4) Ticket + history + audit + outbox TEK transaction
    const ticket = await this.prisma.$transaction(async (tx) => {
      const code = await this.ticketRepo.nextCode(tx); // TKT-2026-xxxxxx (sequence)
      const created = await this.ticketRepo.create(tx, {
        code, createdByUserId: user.id, siteId, facilityId: facility.id,
        title: dto.title, description: dto.description,
        category: dto.category, urgency: dto.urgency,
        source: sourceFromRole(user.role), slaTargetAt,
      });
      await this.ticketRepo.addHistory(tx, {
        ticketId: created.id, previousStatus: null, newStatus: 'OPEN',
        changedByUserId: user.id,
      });
      await this.audit.logInTx(tx, { action: 'TICKET_CREATED', entityType: 'Ticket',
        entityId: created.id, siteId, actorUserId: user.id, afterData: pickAuditable(created), ip: ctx.ip });
      await this.outbox.publishInTx(tx, {
        eventType: dto.urgency === 'EMERGENCY' ? 'EmergencyTicketCreated' : 'TicketCreated',
        aggregateType: 'Ticket', aggregateId: created.id,
        payload: { ticketId: created.id, siteId, urgency: dto.urgency },
      });
      return created;
    });
    return ticket;
  }

  async changeStatus(user: AuthenticatedUser, ticketId: string, dto: ChangeTicketStatusDto, ctx: RequestContext) {
    return this.prisma.$transaction(async (tx) => {
      // Satır kilidi: eşzamanlı iki geçişten biri bekler ve güncel durumu görür.
      const ticket = await this.ticketRepo.findByIdForUpdate(tx, ticketId);
      if (!ticket) throw new DomainError('TICKET_NOT_FOUND', {}, 404);

      await this.policy.assertCanRead(user, ticket);
      this.stateMachine.assertTransition(ticket.status, dto.toStatus, user.role, dto.reason);
      // Teknisyen geçişlerinde aktif assignment sahipliği ayrıca doğrulanır:
      if (user.role === 'TECHNICIAN') {
        const active = await this.assignmentRepoCurrentFor(tx, ticketId);
        if (!active || active.technicianId !== user.id)
          throw new DomainError('TICKET_TRANSITION_FORBIDDEN', {}, 403);
      }

      const updated = await this.ticketRepo.updateStatus(tx, ticket, dto.toStatus, dto.reason);
      await this.ticketRepo.addHistory(tx, {
        ticketId, previousStatus: ticket.status, newStatus: dto.toStatus,
        changedByUserId: user.id, reason: dto.reason ?? null, metadata: dto.metadata ?? null,
      });
      await this.audit.logInTx(tx, { action: 'TICKET_STATUS_CHANGED', entityType: 'Ticket',
        entityId: ticketId, siteId: ticket.siteId, actorUserId: user.id,
        beforeData: { status: ticket.status }, afterData: { status: dto.toStatus }, ip: ctx.ip });
      await this.outbox.publishInTx(tx, { eventType: 'TicketStatusChanged',
        aggregateType: 'Ticket', aggregateId: ticketId,
        payload: { from: ticket.status, to: dto.toStatus } });
      return updated;
    });
  }
}
```

### AssignmentService (yeniden atama transaction'ı)

```typescript
@Injectable()
export class AssignmentService {
  async assignTechnician(operator: AuthenticatedUser, ticketId: string, dto: CreateAssignmentDto, ctx: RequestContext) {
    return this.prisma.$transaction(async (tx) => {
      // 1) Ticket kilitle — iki operatörün eşzamanlı ataması serileşir.
      const ticket = await this.ticketRepo.findByIdForUpdate(tx, ticketId);
      if (!ticket) throw new DomainError('TICKET_NOT_FOUND', {}, 404);
      if (!['TRIAGED', 'REJECTED', 'ASSIGNED'].includes(ticket.status))
        throw new DomainError('TICKET_INVALID_STATUS_TRANSITION',
          { from: ticket.status, to: 'ASSIGNED' }, 409);

      // 2) Teknisyen doğrulaması: rol + aktiflik. Client'tan gelen id'ye güvenilmez.
      const tech = await tx.user.findFirst({
        where: { id: dto.technicianId, role: 'TECHNICIAN', isActive: true, deletedAt: null },
      });
      if (!tech) throw new DomainError('TECHNICIAN_NOT_FOUND', {}, 404);

      // 3) Mevcut aktif assignment'ı kapat (varsa)
      const current = await this.assignmentRepo.findCurrentForUpdate(tx, ticketId);
      if (current) {
        await this.assignmentRepo.update(tx, current.id, {
          assignmentStatus: 'REASSIGNED', isCurrent: false,
        });
      }

      // 4) Yeni assignment — partial unique index çifte kayda karşı son savunma hattıdır.
      const assignment = await this.assignmentRepo.create(tx, {
        ticketId, technicianId: tech.id, assignedByUserId: operator.id,
        assignmentStatus: 'PENDING', isCurrent: true,
      });

      // 5) Ticket durumu + history + audit + outbox
      await this.ticketRepo.updateStatus(tx, ticket, 'ASSIGNED');
      await this.ticketRepo.addHistory(tx, { ticketId, previousStatus: ticket.status,
        newStatus: 'ASSIGNED', changedByUserId: operator.id,
        metadata: { technicianId: tech.id, previousAssignmentId: current?.id ?? null } });
      await this.audit.logInTx(tx, { action: current ? 'ASSIGNMENT_CHANGED' : 'TECHNICIAN_ASSIGNED',
        entityType: 'Assignment', entityId: assignment.id, siteId: ticket.siteId,
        actorUserId: operator.id, ip: ctx.ip });
      await this.outbox.publishInTx(tx, { eventType: 'TechnicianAssigned',
        aggregateType: 'Ticket', aggregateId: ticketId,
        payload: { assignmentId: assignment.id, technicianId: tech.id } });

      return assignment;
    });
  }

  async accept(user: AuthenticatedUser, assignmentId: string) {
    return this.prisma.$transaction(async (tx) => {
      const a = await this.assignmentRepo.findByIdForUpdate(tx, assignmentId);
      if (!a || a.technicianId !== user.id) throw new DomainError('ASSIGNMENT_NOT_FOUND', {}, 404);
      if (a.assignmentStatus !== 'PENDING')
        throw new DomainError('ASSIGNMENT_INVALID_STATE', { status: a.assignmentStatus }, 409);

      await this.assignmentRepo.update(tx, a.id, {
        assignmentStatus: 'ACTIVE', acceptedAt: new Date(),
      });
      const ticket = await this.ticketRepo.findByIdForUpdate(tx, a.ticketId);
      this.stateMachine.assertTransition(ticket!.status, 'ACCEPTED', 'TECHNICIAN');
      await this.ticketRepo.updateStatus(tx, ticket!, 'ACCEPTED');
      await this.ticketRepo.addHistory(tx, { ticketId: a.ticketId,
        previousStatus: ticket!.status, newStatus: 'ACCEPTED', changedByUserId: user.id });
      await this.outbox.publishInTx(tx, { eventType: 'AssignmentAccepted',
        aggregateType: 'Assignment', aggregateId: a.id, payload: { ticketId: a.ticketId } });
      return a;
    });
  }

  async addMaterial(user: AuthenticatedUser, assignmentId: string, dto: AddMaterialDto) {
    return this.prisma.$transaction(async (tx) => {
      const a = await this.assignmentRepo.findByIdForUpdate(tx, assignmentId);
      if (!a) throw new DomainError('ASSIGNMENT_NOT_FOUND', {}, 404);
      // Teknisyen yalnız kendi AKTİF işine; tamamlanmış işe ekleme yapamaz.
      if (user.role === 'TECHNICIAN' &&
          (a.technicianId !== user.id || a.assignmentStatus !== 'ACTIVE'))
        throw new DomainError('ASSIGNMENT_NOT_FOUND', {}, 404);

      const material = await tx.material.findFirst({
        where: { id: dto.materialId, isActive: true, deletedAt: null } });
      if (!material) throw new DomainError('MATERIAL_NOT_FOUND', {}, 404);

      // Decimal aritmetiği: asla number ile çarpma yapılmaz.
      const total = new Prisma.Decimal(dto.quantity).mul(dto.unitPrice).toDecimalPlaces(2);
      return tx.assignmentMaterial.create({ data: {
        assignmentId, materialId: material.id,
        quantity: dto.quantity, unitPrice: dto.unitPrice, totalPrice: total,
        suppliedBy: dto.suppliedBy, note: dto.note ?? null, createdByUserId: user.id,
      }});
    });
  }
}
```

### ContractService

```typescript
@Injectable()
export class ContractService {
  async create(operator: AuthenticatedUser, dto: CreateContractDto) {
    if (dto.endDate <= dto.startDate)
      throw new DomainError('CONTRACT_INVALID_DATES', {}, 422);

    return this.prisma.$transaction(async (tx) => {
      const site = await tx.facility.findFirst({
        where: { id: dto.siteId, type: 'SITE', deletedAt: null } });
      if (!site) throw new DomainError('SITE_NOT_FOUND', {}, 404);

      try {
        return await tx.contract.create({ data: { ...dto, status: 'DRAFT',
          createdByUserId: operator.id } });
      } catch (e) {
        if (isExclusionViolation(e, 'excl_contracts_active_overlap'))
          throw new DomainError('CONTRACT_OVERLAP', { siteId: dto.siteId }, 409);
        throw e;
      }
    });
  }

  async activate(operator: AuthenticatedUser, contractId: string) {
    return this.prisma.$transaction(async (tx) => {
      const c = await this.contractRepo.findByIdForUpdate(tx, contractId);
      if (!c) throw new DomainError('CONTRACT_NOT_FOUND', {}, 404);
      if (c.status !== 'DRAFT')
        throw new DomainError('CONTRACT_INVALID_STATE', { status: c.status }, 409);
      try {
        // ACTIVE'e geçiş anında EXCLUDE constraint çakışmayı yakalar (race-safe).
        return await tx.contract.update({ where: { id: contractId }, data: { status: 'ACTIVE' } });
      } catch (e) {
        if (isExclusionViolation(e, 'excl_contracts_active_overlap'))
          throw new DomainError('CONTRACT_OVERLAP', {}, 409);
        throw e;
      }
    });
  }
}
```

---

## Bölüm 13: Transaction ve Race Condition Çözümleri

Tüm kritik akışlar `prisma.$transaction` (interactive) içinde çalışır. Varsayılan izolasyon READ COMMITTED yeterlidir çünkü çakışan satırlar açıkça kilitlenir; izolasyonu yükseltmek yerine hedefli kilit tercih edilmiştir (deadlock/serialization retry maliyeti düşük kalır).

| Senaryo | Risk | Çözüm |
|---|---|---|
| **Aynı OTP'nin iki kez doğrulanması** | İki paralel verify aynı challenge'ı okur, ikisi de token alır | Challenge `SELECT ... FOR UPDATE` ile okunur; ikinci istek kilidi bekler, `consumedAt` dolu satırı bulamaz → 401. Consume + token üretimi aynı transaction'dadır |
| **Aynı ticket'a iki operatörün eşzamanlı ataması** | İki aktif assignment oluşur | (a) Ticket satırı `FOR UPDATE` ile kilitlenir → istekler serileşir; (b) son savunma: `uq_assignments_one_current_per_ticket` partial unique index — ihlalde 409 `ASSIGNMENT_CONFLICT` |
| **Teknisyenin tamamlanmış işi tekrar güncellemesi** | COMPLETED assignment'a malzeme/durum yazılması | Assignment `FOR UPDATE` + status kontrolü (`ACTIVE` değilse 404/409); ticket tarafında state machine `COMPLETED → X` teknisyen geçişine izin vermez; `Ticket.version` optimistic lock UPDATE'lerde `WHERE version = ?` ile kullanılır, 0 satır dönerse 409 `CONCURRENT_MODIFICATION` |
| **Aynı ay için iki fatura** | Çift fatura | `@@unique(contractId, billingPeriodStart)` + `excl_invoice_period_overlap` (kısmi çakışmaları da yakalar). Unique ihlali → 409 `INVOICE_PERIOD_OVERLAP` |
| **Aynı site için çakışan aktif sözleşme** | İki ACTIVE sözleşme | `EXCLUDE USING gist` constraint — uygulama ön-kontrolü UX için, constraint doğruluk için. Aktivasyon transaction'ında ihlal 409'a çevrilir |
| **Refresh token çift kullanımı** | Rotation yarışı veya çalınmış token | Session `FOR UPDATE`; `revokedAt` dolu görülürse reuse detection → kullanıcının **tüm** session'ları revoke edilir |
| **Ticket status yarışları** (teknisyen COMPLETED yaparken operatör CANCELLED) | Tutarsız history | Ticket satır kilidi: ikinci işlem güncel durumu görür, state machine geçersiz geçişi 409 ile reddeder |
| **Facility hiyerarşisinde parent silinirken çocuk ekleme** | Öksüz kayıt | Parent `SELECT ... FOR SHARE` ile okunur; soft delete UPDATE'i kilidi bekler |
| **Ticket kodu üretimi** | Çakışan kod | PostgreSQL sequence (`nextval`) — doğası gereği atomik |

**Deadlock önleme kuralı**: kilit sırası her zaman `ticket → assignment → diğerleri` yönündedir; tüm servisler bu sıraya uyar.

---

## Bölüm 14: Test Planı

Test DB'si: **Testcontainers PostgreSQL 16** (SQLite yasak — partial index, EXCLUDE, JSONB ve `FOR UPDATE` davranışları PostgreSQL'e özgüdür).

### Unit test (Jest, bağımlılıklar mock)

| Alan | Senaryolar |
|---|---|
| `OtpService` | geçerli kod kabul; yanlış kod attemptCount artışı; max deneme sonrası invalidation; süresi dolmuş kod reddi; enumeration koruması (kayıtlı/kayıtsız numara aynı yanıt); HMAC hesaplama; `Math.random` kullanılmadığının statik kontrolü |
| `TicketStateMachine` | 16 geçerli geçişin tamamı; tüm geçersiz çiftlerin 409'u; rol dışı geçişte 403; reason zorunluluğu (CANCELLED, yeniden açma) |
| `TicketAuthorizationPolicy` | resident kendi/başkasının ticket'ı; taşınmış resident (membership pasif) reddi; manager başka site reddi (404); teknisyen assignment'sız reddi |
| `AssignmentService` | PENDING dışı accept 409; başka teknisyenin assignment'ı 404; reassign akışında eski kaydın REASSIGNED+isCurrent=false olması |
| Contract tarih doğrulama | end<=start reddi; billingDay 1-28 |
| Invoice hesap/dönem | dönem sözleşme dışı → 422; Decimal toplam hesap doğruluğu |

### Integration test (gerçek PostgreSQL)

- Repository CRUD + soft delete filtrelerinin sorgulara uygulanması.
- **Constraint testleri**: `uq_assignments_one_current_per_ticket` ikinci isCurrent insert'ünde hata; `excl_contracts_active_overlap` çakışan ACTIVE sözleşmede hata; `chk_am_total_consistent`; E.164 CHECK; `uq_facilities_parent_code_alive` (silinmiş kodun yeniden kullanılabilmesi dahil).
- **Transaction davranışı**: iki paralel `verifyOtp` çağrısından yalnız birinin başarması; iki paralel `assignTechnician` çağrısında tek aktif assignment kalması (gerçek concurrency, `Promise.all`).
- **Refresh rotation**: rotate → eski token reuse → tüm session'ların revoke edildiğinin doğrulanması.

### E2E test (supertest, tam uygulama + Testcontainers)

Seed edilmiş iki site üzerinde uçtan uca senaryo:

1. Resident OTP ister (mock provider koddan yakalanır) ve giriş yapar.
2. Resident kendi dairesi için ticket oluşturur → 201, status OPEN, history'de OPEN kaydı.
3. Resident B, resident A'nın ticket'ını GET eder → **404**.
4. Site manager kendi sitesinin tüm ticket'larını listeler; diğer sitenin `?siteId`'siyle ister → 404/403.
5. Operations ticket'ı TRIAGED yapar, teknisyen atar → ticket ASSIGNED, assignment PENDING.
6. Technician atamayı kabul eder → ACCEPTED/ACTIVE.
7. Technician EN_ROUTE→ARRIVED→IN_PROGRESS→COMPLETED zincirini yürütür; sıra atlamalı geçiş (ACCEPTED→COMPLETED) 409 alır.
8. Technician malzeme ve BEFORE/AFTER fotoğraf ekler; başka teknisyen aynı assignment'a POST eder → 404.
9. Site manager tamamlanan işi, geçmişi ve malzemeleri görüntüler.
10. Operations ticket'ı CLOSED yapar; manuel fatura oluşturulur ve PAID'e çekilir (paidAt+method zorunlu).
11. Sözleşmesi olmayan sitenin sakini OTP ister → generic yanıt, SMS gönderilmez.

---

## Bölüm 15: Docker ve Environment Yapısı

### .env.example

```dotenv
NODE_ENV=development
PORT=3000

DATABASE_URL=postgresql://app:app@localhost:5432/site_support?schema=public

# Auth
JWT_ACCESS_SECRET=change-me-32-bytes-min
JWT_ACCESS_EXPIRES_IN=900            # saniye (15 dk)
REFRESH_TOKEN_PEPPER=change-me-32-bytes-min
REFRESH_TOKEN_EXPIRES_IN=2592000     # 30 gün

# OTP
OTP_HMAC_SECRET=change-me-32-bytes-min
OTP_EXPIRES_IN_SECONDS=180
OTP_MAX_ATTEMPTS=5
OTP_RESEND_COOLDOWN_SECONDS=60

# SMS
SMS_PROVIDER=mock                    # mock | external
SMS_API_URL=
SMS_API_KEY=

# Storage
STORAGE_PROVIDER=local               # local | s3
STORAGE_LOCAL_PATH=./var/uploads
S3_ENDPOINT=
S3_BUCKET=
S3_ACCESS_KEY=
S3_SECRET_KEY=

CORS_ALLOWED_ORIGINS=http://localhost:5173
LOG_LEVEL=debug
```

### Environment doğrulama (Zod)

```typescript
// config/validation.schema.ts
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().url(),
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_ACCESS_EXPIRES_IN: z.coerce.number().int().min(300).max(3600),
  REFRESH_TOKEN_PEPPER: z.string().min(32),
  REFRESH_TOKEN_EXPIRES_IN: z.coerce.number().int(),
  OTP_HMAC_SECRET: z.string().min(32),
  OTP_EXPIRES_IN_SECONDS: z.coerce.number().int().min(180).max(300),
  OTP_MAX_ATTEMPTS: z.coerce.number().int().min(3).max(10),
  OTP_RESEND_COOLDOWN_SECONDS: z.coerce.number().int().min(30),
  SMS_PROVIDER: z.enum(['mock', 'external']),
  STORAGE_PROVIDER: z.enum(['local', 's3']),
  CORS_ALLOWED_ORIGINS: z.string(),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
}).superRefine((env, ctx) => {
  if (env.NODE_ENV === 'production' && env.SMS_PROVIDER === 'mock')
    ctx.addIssue({ code: 'custom', message: 'Production ortamında mock SMS kullanılamaz' });
  if (env.STORAGE_PROVIDER === 's3' && !process.env.S3_BUCKET)
    ctx.addIssue({ code: 'custom', message: 'S3 seçildi ancak S3_BUCKET boş' });
});
// Doğrulama bootstrap'te çalışır; hata varsa uygulama AYAĞA KALKMAZ (fail-fast).
```

JWT secret rotasyonu: `JWT_ACCESS_SECRET` virgülle çoklu değeri destekleyecek şekilde okunur (ilk değerle imzala, tümüyle doğrula); rotasyon eski token'ları 15 dk içinde doğal olarak düşürür.

### Dockerfile (multi-stage)

> **Uygulama notu (Faz 9):** Uygulanan Dockerfile `node:24-alpine` kullanır,
> build aşamasında `npm prune --omit=dev` çalıştırır (runtime imajında Prisma
> CLI yoktur; `prisma migrate deploy` build-stage imajıyla koşulur) ve
> `CMD ["node", "dist/src/main.js"]` ile başlar (`npm run start:prod` ile
> aynı). Bkz. Bölüm 17.

```dockerfile
FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json prisma ./
RUN npm ci

FROM node:20-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate && npm run build

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -S app && adduser -S app -G app
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/prisma ./prisma
COPY package.json ./
USER app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/v1/health/liveness || exit 1
CMD ["node", "dist/main.js"]
```

### docker-compose.yml (development)

```yaml
services:
  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: app
      POSTGRES_PASSWORD: app
      POSTGRES_DB: site_support
    ports: ["5432:5432"]
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U app -d site_support"]
      interval: 5s
      timeout: 3s
      retries: 10

  api:
    build: .
    env_file: .env
    environment:
      DATABASE_URL: postgresql://app:app@db:5432/site_support?schema=public
    ports: ["3000:3000"]
    depends_on:
      db:
        condition: service_healthy
    volumes:
      - ./var/uploads:/app/var/uploads   # local storage provider için

volumes:
  pgdata:
```

Komutlar:

```bash
docker compose up -d db
npx prisma migrate deploy      # migration
npx prisma db seed             # seed (prisma/seed.ts)
docker compose up api
```

### Liveness / Readiness ayrımı

- **Liveness** (`/health/liveness`): yalnızca sürecin cevap verdiğini kontrol eder. DB'ye bakmaz; DB'nin kısa kesintisi pod'un restart edilmesini gerektirmez.
- **Readiness** (`/health/readiness`): DB `SELECT 1` başarısızsa **not ready** → trafik kesilir. SMS provider health'i yanıta `"sms": "degraded"` olarak eklenir ama readiness'ı DÜŞÜRMEZ; SMS arızası OTP dışındaki tüm işlevleri etkilemediğinden uygulamayı unhealthy yapmak yanlış olur.

### Seed verisi (prisma/seed.ts özeti)

> **Uygulama notu (Faz 9):** Seed, Faz 9'da uygulandı: `prisma/seed.ts`,
> `npm run db:seed` ile açık çağrılır, idempotent'tir ve
> `NODE_ENV=production`'da fail-fast eder. Kapsam sadeleştirildi: ticket ve
> invoice seed'lenmez (manuel kabul akışı API üzerinden üretir). OTP'ye
> development'ta debug log ile değil, dev-only in-memory SMS inbox
> endpoint'iyle erişilir. Bkz. Bölüm 17.

```text
Kullanıcılar (telefonlar TR test aralığı +90 5xx ... kurgusal):
  OPERATIONS: Operasyon Bir       +905550000001
  TECHNICIAN: Teknisyen Bir       +905550000002
  SITE_MANAGER (Panorama): ...    +905550000003
  SITE_MANAGER (Marina):   ...    +905550000004
  RESIDENT x2 / site:             +905550000005..08

Facilities:
  Panorama Evleri (SITE) ─ A Blok ─ Daire 1..3, Elektrik Odası(COMMON_AREA)
                         ─ B Blok ─ Daire 1..2
                         ─ Ana Havuz, Otopark (COMMON_AREA)
  Marina Park (SITE)     ─ 2 blok, daireler, Güvenlik Kulübesi

İlişkiler: her manager'a MANAGER membership, her resident'a RESIDENT membership + unit assignment.
Sözleşme: Panorama için ACTIVE (2026-01-01..2026-12-31, 15000.00 TRY, billingDay 5, SLA 24h, emergencyCoverage true)
Fatura: 2026-06 dönemi ISSUED.
Ticketlar: OPEN (resident), TRIAGED (SM ortak alan), ASSIGNED+aktif PENDING assignment,
           IN_PROGRESS (ACTIVE assignment + 2 malzeme satırı), COMPLETED.
Malzemeler: "16A Sigorta" (adet), "PPRC Boru 25mm" (metre), "Havuz Klor Tableti" (kg).

OTP kodu seed'e YAZILMAZ; development'ta mock provider debug logu ve
NODE_ENV=development'a özel test yardımcıları kullanılır.
```

---

## Bölüm 16: Uygulama Sırası (Fazlar)

> **Uygulama notu (Faz 9):** Faz 1–8 tamamlanmış ve main'e merge edilmiştir.
> Faz 9'un gerçek kapsamı `docs/phase-9-plan.md`'dedir (CI, belge revizyonu,
> seed, manuel kabul, config sertleştirmesi, runbook). Aşağıdaki Faz 9
> tanımındaki yük testi, penetrasyon kontrol listesi, Swagger koruması ve
> OTP/session temizlik job'ları sonraki fazlara ertelenmiştir. Bkz. Bölüm 17.

**Faz 0 — İskelet (3-4 gün)**
Repo, strict tsconfig, ESLint/Prettier, NestJS iskeleti, ConfigModule + Zod fail-fast, PrismaService, global exception filter + response zarfı, request-id, structured logger, Docker compose, CI'da Testcontainers.

**Faz 1 — Veri modeli (3-4 gün)**
schema.prisma + özel SQL migration'lar (Bölüm 6), seed, constraint integration testleri. *Şema en pahalı değişendir; önce sabitlenir.*

**Faz 2 — Auth (1 hafta)**
OtpService, TokenService, AuthService, guards (`JwtAuthGuard`, `RolesGuard`), rate limiting, mock SMS. E2E: OTP giriş, refresh rotation, reuse detection.

**Faz 3 — Facility + Membership + Users (1 hafta)**
FacilityService + FacilityValidator, MembershipQueryService, resident onboarding endpoint'leri, `SiteScopeGuard`. E2E: tenant izolasyon senaryoları.

**Faz 4 — Ticket çekirdeği (1-1,5 hafta)**
TicketService, state machine, policy, history, audit, outbox yazımı, cursor pagination. E2E: oluşturma/okuma/iptal ve izolasyon.

**Faz 5 — Assignment + Materials (1 hafta)**
Atama/yeniden atama transaction'ı, teknisyen akışı, malzeme kayıtları, concurrency testleri.

**Faz 6 — Attachments (3-4 gün)**
StorageProvider (local + S3/MinIO), MIME/boyut doğrulama, signed URL, erişimde policy tekrarı.

**Faz 7 — Contracts + Billing (4-5 gün)**
ContractService, InvoiceService, EXCLUDE constraint akışları, SM salt-okuma görünümleri.

**Faz 8 — Notifications + Outbox relay (3-4 gün)**
OutboxRelay (interval, backoff), NotificationDispatcher, acil arıza SMS'i, `ContractExpiring`/`InvoiceOverdue` tarama job'ları.

**Faz 9 — Sertleştirme ve yayın (1 hafta)**
Helmet/CORS/Swagger prod koruması, OTP/session temizlik job'ları, KVKK maskeleme denetimi, yük testi, penetrasyon kontrol listesi (IDOR, enumeration, rate limit), dokümantasyon.

---

## Bölüm 17: Uygulama Sonrası Mimari Revizyon (Faz 1–8)

Bu bölüm Faz 9'da eklendi. Faz 1–8 uygulaması ile bu belgenin başlangıç
tasarımı arasındaki bilinen farkların bağlayıcı kaydıdır. Çelişki durumunda
bu bölüm, `docs/implementation-overrides.md` ve kaynak kod geçerlidir.
Tarihsel metin silinmemiş, yalnız "Uygulama notu (Faz 9)" kutularıyla
işaretlenmiştir.

| # | Konu | Bu belgedeki hüküm | Uygulanan gerçeklik | Kanıt |
| --- | --- | --- | --- | --- |
| 1 | Başarı yanıt zarfı | Bölüm 11: "Tüm cevaplar `{ success, data \| error }` zarfındadır" | Yalnız **hata** yanıtları zarflıdır (`{ success:false, error:{ code, message, requestId, timestamp, details? } }`); başarı yanıtları çıplak DTO döner, global TransformInterceptor yoktur | `src/common/filters/global-exception.filter.ts`, `src/common/types/error-response.type.ts` |
| 2 | Repository export kuralı | Bölüm 1: modüller birbirinin repository'sine doğrudan dokunmaz | Kural geçerlidir; iki bilinçli istisna vardır: `MembershipsModule` (`SiteMembershipRepository`, `ResidentUnitAssignmentRepository`, `MembershipQueryService`, `SiteScopeGuard` export eder — tenant kapsam doğrulaması için ortak altyapı) ve `FacilitiesModule` (`FacilityRepository`, `FacilityService` export eder) | `src/modules/memberships/memberships.module.ts`, `src/modules/facilities/facilities.module.ts` |
| 3 | `NotificationDelivery` modeli | Yok | Faz 8'de eklendi: `notification_deliveries` tablosu; dispatcher exactly-once fan-out ile delivery satırları üretir, delivery relay at-least-once SMS gönderir; `status`, `attemptCount`, `nextAttemptAt`, `failedAt`, `lastError` alanları ve `[sourceEventId, recipientPhone, channel]` unique kısıtı vardır | `prisma/schema.prisma`, `src/modules/notifications/notification-dispatcher.service.ts`, `src/modules/notifications/notification-delivery-relay.service.ts` |
| 4 | `OutboxEvent.failedAt` | Yok (Bölüm 5) | Kalıcı başarısızlıkta (`attemptCount >= OUTBOX_MAX_ATTEMPTS` veya non-retryable hata) `status=FAILED` + `failedAt` yazılır | `prisma/schema.prisma`, `src/modules/notifications/outbox-relay.service.ts` |
| 5 | `Contract.expiryNotifiedAt` | Yok (Bölüm 5) | `ContractExpiring` tarama job'ının idempotency işaretidir; aynı sözleşme için bildirimin tekrar üretilmesini engeller | `prisma/schema.prisma`, `src/modules/contracts/jobs/contract-expiring-scan.job.ts` |
| 6 | Attachment erişimi | Signed URL: `StorageProvider.getSignedUrl`, `GET /attachments/:id/url` (5 dk TTL), Ek B'de private bucket + signed URL | Signed URL yoktur. İndirme kimlik doğrulamalı streaming `GET /attachments/:id/download` endpoint'iyle yapılır (policy parent ticket üzerinden yeniden doğrulanır, `X-Content-Type-Options: nosniff`). Uygulanan interface: `finalize` / `openReadStream` / `delete` / `deleteTemp` | `src/modules/attachments/controllers/attachment-download.controller.ts`, `src/infrastructure/storage/storage-provider.interface.ts` |
| 7 | Storage implementasyonları | Faz 6: local + S3/MinIO | Yalnız `LocalStorageProvider` vardır; `STORAGE_PROVIDER=s3` seçilirse uygulama fail-fast eder. S3 sonraki faza bırakıldı | `src/infrastructure/storage/storage.module.ts` |
| 8 | SMS provider | `ExternalSmsProvider` production placeholder (Netgsm vb.) | Yalnız `MockSmsProvider` vardır; `SMS_PROVIDER=external` implement edilmediği için config doğrulamasında açıkça reddedilir (Faz 9 kuralı). Gerçek SMS entegrasyonu sonraki faza bırakıldı | `src/infrastructure/sms/sms.module.ts`, `src/config/validation.schema.ts` |
| 9 | WhatsApp / E-posta / Push | Ek C: gelecek genişleme noktası | Kodda hiçbir karşılığı yoktur; sonraki fazlara bırakıldı | — |
| 10 | REST endpoint kataloğu | Bölüm 11 tabloları | Bağlayıcı katalog controller'lardadır. Belirgin eklemeler: `POST /sites/:siteId/users/:userId/deactivate`, `POST /sites/:siteId/units/:unitId/assignments/:assignmentId/deactivate` (users); `POST /assignments/:id/cancel`; `PATCH /tickets/:id`, `POST /tickets/:id/cancel`, `GET /tickets/:id/history`; `GET /attachments/:id/download`; contracts/billing endpoint'leri (`POST /contracts`, `PATCH /contracts/:id`, `GET /sites/:siteId/contracts`, `POST /contracts/:id/invoices`, `PATCH /invoices/:id/status`, `GET /sites/:siteId/invoices`) | `src/modules/**/**.controller.ts` |
| 11 | Notifications mimarisi | Bölüm 3: "MVP: SMS + log", tek dispatcher | Faz 8: iki aşamalı pipeline — `OutboxRelay` (SKIP LOCKED claim + lease + exponential backoff) → `NotificationDispatcher` (exactly-once, Zod payload doğrulaması) → `NotificationDeliveryRelay` (at-least-once SMS). Kill-switch: `OUTBOX_RELAY_ENABLED`; `NODE_ENV=test`'te her zaman kapalı | `src/modules/notifications/` |
| 12 | Zamanlanmış job'lar | Faz 8 planında | `ContractExpiringScanJob` ve `InvoiceOverdueScanJob`, cron `0 2 * * *` (UTC), dinamik kayıt + kill-switch `BACKGROUND_JOBS_ENABLED`; API prosesinde çalışır, ayrı worker prosesi yoktur | `src/modules/contracts/jobs/`, `src/modules/billing/jobs/` |
| 13 | Rate limiting | Bölüm 8 pseudocode | `rate-limiter-flexible` ile in-memory, yalnız OTP akışlarında (`otpPhone` 3/600s, `otpIp` 10/600s, `otpCooldown`, `otpVerifyIp` 20/600s); eşikler kodda sabittir, env'e taşınması sonraki faza bırakıldı | `src/infrastructure/rate-limit/rate-limiter.service.ts` |
| 14 | Docker / çalıştırma | `node:20-alpine`, `CMD ["node", "dist/main.js"]` | `node:24-alpine`; `npm prune --omit=dev` (runtime imajında Prisma CLI yok, `migrate deploy` build-stage imajıyla koşulur); `CMD ["node", "dist/src/main.js"]`; `npm run start:prod` aynı komutu çalıştırır | `Dockerfile`, `package.json` |
| 15 | Seed | Bölüm 15'te planlandı | Faz 9'da uygulandı: `prisma/seed.ts`, `npm run db:seed`, idempotent (upsert), `NODE_ENV=production`'da fail-fast; ticket/invoice seed'lenmez | `prisma/seed.ts` |
| 16 | Faz durumu | Bölüm 16 sıralama listesi | Faz 1–8 tamamlandı ve main'e merge edildi. Faz 9 kapsamı `docs/phase-9-plan.md`'dedir; yük testi, pentest kontrol listesi, Swagger, OTP/session temizlik job'ları sonraki fazlara ertelendi | `docs/phase-9-plan.md`, git geçmişi |

Yeni bir belge-kod farkı tespit edildiğinde bu tabloya satır eklenir; bu
belgenin tarihsel bölümleri yeniden yazılmaz.

---

## Ek A: DTO ve Validasyon Örnekleri

```typescript
export class CreateTicketDto {
  @IsUUID() facilityId!: string;

  @IsString() @Length(5, 150)
  @Transform(({ value }) => String(value).trim())
  title!: string;

  @IsString() @Length(10, 4000)
  description!: string;

  @IsEnum(TicketCategory) category!: TicketCategory;
  @IsEnum(TicketUrgency) urgency!: TicketUrgency;
  // DİKKAT: siteId alanı YOK — client'tan alınmaz, facility'den türetilir.
}

export class RequestOtpDto {
  // Pipe E.164'e normalize eder; format hatası 422 VALIDATION_ERROR.
  @IsPhoneE164() phoneNumber!: string;
}

export class AddMaterialDto {
  @IsUUID() materialId!: string;
  @IsNumberString() @IsPositiveDecimal() quantity!: string;   // Decimal string taşınır
  @IsNumberString() @IsNonNegativeDecimal() unitPrice!: string;
  @IsEnum(SuppliedBy) suppliedBy!: SuppliedBy;
  @IsOptional() @Length(0, 1000) note?: string;
}
```

Kural: "facility gerçek mi", "resident'ın aktif unit'i mi", "dönem sözleşme içinde mi" gibi **DB'ye bakan** doğrulamalar DTO'da değil service/policy katmanındadır; DTO yalnız şekil doğrular.

## Ek B: KVKK ve Veri Minimizasyonu

- **Toplanan PII**: yalnızca ad-soyad + telefon. Adres, TC kimlik, e-posta MVP'de toplanmaz.
- **Teknisyen görünümü**: mapper teknisyene yalnız `unit kodu + kat/blok + ad` döner; sakinin telefonunu ancak aktif assignment sırasında ve "ara" işlevi için maskeli/aracılı gösterecek genişleme noktası bırakılmıştır (MVP'de telefon hiç dönmez).
- **Fotoğraflar**: private bucket, public ACL yok, 5 dk TTL'li signed URL, her URL üretiminde ticket policy tekrar çalışır.
- **Silme talebi**: operasyon kayıtları (ticket/assignment/audit) yasal saklama gerekçesiyle silinmez; kullanıcı satırı anonimleştirilir (`firstName='Silinmiş'`, `phoneNumber` yerine tekil placeholder, `deletedAt` set). FK'ler bozulmaz, kişisel iz kalkar.
- **Audit maskeleme**: `AuditService` yazmadan önce `beforeData/afterData` içinden `phoneNumber` gibi alanları `+90*******12` biçimine çevirir; OTP, JWT, refresh token, SMS içeriği, signed URL asla loglanmaz (serializer redact listesi).
- **Saklama süreleri**: `RETENTION_OTP_DAYS`, `RETENTION_SESSION_DAYS`, `RETENTION_AUDIT_MONTHS` config'ten okunur; gece çalışan temizlik job'ları süresi dolmuş `otp_challenges` ve revoke edilmiş `refresh_sessions` satırlarını fiziksel siler.

## Ek C: Gelecek Genişleme Noktaları

**IoT**: `devices(id, facilityId FK→facilities, type, serial, isActive)` → `device_readings(deviceId, metric, value, recordedAt)` → `device_alerts(deviceId, severity, ticketId nullable)`. Facility hiyerarşisi hazırdır: sensör bir UNIT'e ya da COMMON_AREA'ya bağlanır; alert, mevcut `TicketService.create`'i `source=DEVICE` (enum'a eklenecek) ile çağırır. MVP şemasına bu tablolar **eklenmemiştir**.

**Sanal POS**: `billing` modülü yalnızca aşağıdaki interface'e bağımlı yazılmıştır; Iyzico/PayTR birer implementation olarak `payments` modülüne gelir, webhook'lar outbox üzerinden `InvoicePaid` event'ine çevrilir:

```typescript
interface PaymentProvider {
  createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult>;
  verifyWebhook(input: VerifyWebhookInput): Promise<VerifiedPaymentEvent>;
  refund(input: RefundInput): Promise<RefundResult>;
}
```

Kart verisi hiçbir zaman backend'e uğramaz (hosted payment page / tokenization); PCI DSS kapsamı dışında kalınır.

**Bildirim kanalları**: `NotificationDispatcher` kanal bağımsızdır — `NotificationChannel { send(recipient, template, data) }` interface'ine SMS dışında Push/WhatsApp/E-posta implementation'ları eklenir; outbox event → template → kanal seçimi (kullanıcı tercihi tablosu ileride) zinciri değişmez.

# Site Teknik Destek Sistemi — API

Site (apartman/rezidans) yönetiminde teknik destek taleplerinin (arıza
bildirimi) oluşturulması, teknisyenlere atanması, iş akışının yürütülmesi ve
kullanılan malzemelerin kayıt altına alınması için geliştirilen NestJS tabanlı
backend API'sidir.

Bu depo yalnızca backend uygulamasını içerir. Frontend veya mobil istemci
bulunmamaktadır.

## 1. Kısa Açıklama

Sistem; siteler, bloklar, bağımsız bölümler (unit) ve ortak alanları
(common area) modelleyerek bu yapı üzerinde açılan teknik destek
taleplerinin (ticket) uçtan uca yaşam döngüsünü yönetir: talebin
oluşturulması, önceliklendirilmesi (triage), bir teknisyene atanması,
teknisyenin kabul/red/işlem adımlarını ilerletmesi ve iş sırasında
kullanılan malzemelerin kaydedilmesi.

## 2. Projenin Çözdüğü Problem

Çok siteli (multi-tenant) bir site yönetim şirketinin karşılaştığı şu
ihtiyaçları çözer:

- Sakinlerin ve site yöneticilerinin arıza/destek talebi açabilmesi.
- Operasyon ekibinin talepleri önceliklendirip uygun teknisyene atayabilmesi.
- Teknisyenin kendi işlerini görüp durum güncelleyebilmesi (yola çıktı,
  vardı, işleme başladı, malzeme bekliyor, tamamladı).
- İş sırasında kullanılan malzemelerin miktar/fiyat bilgisiyle kayıt altına
  alınması.
- Sözleşmesi askıya alınmış veya sona ermiş bir sitenin, devam eden açık
  işlerinin yarıda kalmadan tamamlanabilmesi; buna karşın yeni iş açmanın
  aktif sözleşme gerektirmesi.
- Bir sitenin verisinin başka bir siteden asla görünmemesi (tenant
  izolasyonu).

## 3. Güncel Geliştirme Durumu

- Faz 1–5 tamamlanmıştır.
- Backend, NestJS ile geliştirilmektedir; frontend veya mobil uygulama
  bulunmamaktadır.
- Gerçek bir SMS sağlayıcı entegre edilmemiştir; OTP kodları mock SMS
  sağlayıcı (`SMS_PROVIDER=mock`) ile "gönderilir".
- Dosya ekleri (attachment), sözleşme/faturalama (contract/billing) ve
  bildirim (notification) modülleri henüz uygulanmamıştır; bu alanlara ait
  bazı veri modelleri Prisma şemasında hazır olsa da servis/endpoint
  katmanları yoktur.
- Malzeme kataloğu için CRUD endpointi yoktur; yalnızca aktif malzeme
  doğrulaması (lookup) yapılır.

## 4. Tamamlanan Fazlar (Faz 1–5)

| Faz | Kapsam |
|---|---|
| Faz 1 | Proje iskeleti: NestJS kurulumu, strict TypeScript, ESLint/Prettier, Zod tabanlı environment doğrulaması, Prisma 7 + `@prisma/adapter-pg` ile PostgreSQL bağlantısı, tam veri modeli ve custom migration'lar, health (liveness/readiness), global exception filter, request id, yapılandırılmış JSON log, Helmet, CORS allowlist, global `ValidationPipe`. Auth, domain modülleri ve testler bu fazda yoktur. |
| Faz 2 | Kimlik doğrulama: OTP isteği/doğrulaması, JWT access token, refresh token rotasyonu ve reuse detection, `JwtAuthGuard`/`RolesGuard`, `@Public()`/`@Roles()`/`@CurrentUser()`, adlandırılmış rate limiter'lar, mock SMS sağlayıcı, auth audit kayıtları. Jest test altyapısı (unit/integration/e2e) ilk kez bu fazda kurulmuştur. |
| Faz 3 | Facility (SITE/BLOCK/UNIT/COMMON_AREA), membership ve kullanıcı yönetimi: site ağacı oluşturma, sakin onboarding, site kullanıcı listesi, profil güncelleme, site bazlı ve global deaktivasyon, `SiteScopeGuard`, cursor pagination. |
| Faz 4 | Ticket çekirdeği: ticket oluşturma/listeleme/güncelleme, durum geçişi, iptal, geçmiş; `TicketStateMachine`'in tam tanımı; SLA hedef hesaplama; outbox'a yalnızca yazma (`publishInTx`), henüz relay/tüketici yok. |
| Faz 5 | Assignment ve malzeme yönetimi: teknisyen atama/yeniden atama, kabul/red, durum olayları (yola çıktı, vardı, başladı, malzeme bekliyor, devam, tamamlandı), atanmış ticket iptali, malzeme kullanım kayıtları; `TicketAssignmentWorkflowService` ile ticket ve assignment güncellemelerinin tek transaction'da orkestrasyonu. |

## 5. Kapsamda Olmayan veya Henüz Tamamlanmayan Özellikler

- Dosya eki (attachment) yükleme endpointleri (Prisma modeli `TicketAttachment`
  hazır, controller/servis yok).
- Sözleşme (contract) CRUD ve faturalama (billing/invoice) endpointleri
  (Prisma modelleri `Contract`/`ContractInvoice` hazır; yalnızca ticket SLA
  hesaplaması için dar kapsamlı bir okuma servisi — `ContractQueryService` —
  vardır).
- Bildirim (notification) gönderimi ve outbox olaylarının tüketilmesi
  (relay); mevcut outbox yalnızca transaction içinde olay yazar.
- Gerçek SMS sağlayıcı entegrasyonu (yalnızca mock sağlayıcı vardır;
  `SMS_PROVIDER=external` için gerekli env doğrulaması hazırdır fakat gerçek
  bir dış sağlayıcı implementasyonu yoktur).
- Nesne depolama (S3) veya yerel dosya depolama akışı fiilen kullanılmaz;
  ilgili environment değişkenleri ileride attachment özelliği için
  hazırlanmıştır.
- Malzeme kataloğu CRUD endpointi (malzeme ekleme/düzenleme/listeleme
  endpointi yoktur; yalnızca mevcut ve aktif bir malzemenin doğrulanması
  yapılır).
- `COMPLETED → IN_PROGRESS` (işi yeniden açma) API üzerinden desteklenmez;
  state machine tablosunda tanımlı olsa da doğrudan transition politikası
  buna izin vermez.
- `PLATFORM_ADMIN` rolü MVP kapsamında yoktur.
- Kullanıcı/üyelik reaktivasyon (yeniden aktif etme) endpointi yoktur;
  geçmiş üyelikler yeniden aktifleştirilmez, yeni bir kayıt açılır.
- Sakinler için çoklu aktif unit (bağımsız bölüm) senaryosu desteklenmez
  (tek aktif unit varsayımı).
- Swagger/OpenAPI doküman üretimi yoktur.

## 6. Kullanıcı Rolleri

`UserRole` enum'ı dört rol tanımlar:

| Rol | Açıklama |
|---|---|
| `RESIDENT` | Site sakini. Kendi sitesinde ticket açabilir, kendi taleplerini görebilir. |
| `SITE_MANAGER` | Site yöneticisi. Kendi yönettiği sitede sakin/unit eşleştirmesi ve ticket yönetimi yapar. |
| `OPERATIONS` | Operasyon ekibi. Facility oluşturma, kullanıcı yönetimi, ticket triage/atama, assignment yönetimi gibi geniş yetkilere sahiptir. |
| `TECHNICIAN` | Teknisyen. Kendisine atanan işleri görür, kabul/red eder, durum günceller, malzeme kaydeder. |

## 7. Rol ve Erişim Özeti

| Rol | Giriş (login) şartı | Genel yetkiler |
|---|---|---|
| `RESIDENT` | Aktif kullanıcı hesabı + en az bir aktif site üyeliği | Ticket oluşturma, kendi taleplerini/geçmişini görme, `OPEN` durumundaki kendi talebini iptal etme |
| `SITE_MANAGER` | Aktif kullanıcı hesabı + en az bir aktif site üyeliği | Kendi sitesinde sakin onboarding, kullanıcı listeleme, deaktivasyon; ticket oluşturma, `OPEN`/`TRIAGED` iptali; facility oluşturamaz |
| `OPERATIONS` | Aktif kullanıcı hesabı yeterli (üyelik şartı yok) | Facility (SITE/BLOCK/UNIT/COMMON_AREA) oluşturma, global kullanıcı yönetimi, ticket triage/durum/iptal, teknisyen atama/yeniden atama/iptal, malzeme kaydı |
| `TECHNICIAN` | Aktif kullanıcı hesabı yeterli (üyelik şartı yok) | Kendi atamalarını görme (`GET /assignments/my`), kabul/red, durum olayı ilerletme, kendi aktif atamasına malzeme ekleme |

Sözleşme (contract) durumu login uygunluğunda kullanılmaz; yalnızca yeni
ticket/iş açma gibi belirli aksiyonlar aktif sözleşme gerektirir (bkz.
bölüm 20).

## 8. Teknoloji Yığını

- **Runtime:** Node.js `>=24.0.0`
- **Paket yöneticisi:** npm (`package-lock.json` ile sabitlenmiş sürümler)
- **Framework:** NestJS 11 (`@nestjs/common`, `@nestjs/core`,
  `@nestjs/platform-express`, `@nestjs/config`, `@nestjs/jwt`)
- **Dil:** strict TypeScript 5.7
- **Veritabanı:** PostgreSQL 16
- **ORM:** Prisma 7, `prisma-client` generator, `@prisma/adapter-pg` driver
  adapter, bağlantı ayarları `pg`
- **Environment doğrulama:** Zod
- **Logging:** `nestjs-pino` (yapılandırılmış JSON log)
- **Güvenlik:** `helmet`, `class-validator`/`class-transformer`,
  `rate-limiter-flexible`
- **Test:** Jest, `ts-jest`, `supertest`, `@testcontainers/postgresql`

## 9. Mimari Yaklaşım

- Modüler NestJS yapısı: her domain kendi klasöründe (`src/modules/*`)
  ayrı bir Nest modülü olarak tanımlıdır (`auth`, `memberships`,
  `facilities`, `users`, `tickets`, `materials`, `assignments`, `health`).
- Global environment/config katmanı (`ConfigModule.forRoot`) Zod ile
  doğrulanmış tipli config namespace'leri sağlar (`app`, `cors`, `logging`,
  `database`, `auth`, `tickets`).
- Kimlik doğrulama ve rol kontrolü global guard olarak uygulanır
  (`JwtAuthGuard`, `RolesGuard`); `@Public()` ile açık uçlar, `@Roles(...)`
  ile rol kısıtlaması tanımlanır.
- Global `ValidationPipe` (`whitelist`, `forbidNonWhitelisted`,
  `transform`, doğrulama hatalarında `422`) ve global `GlobalExceptionFilter`
  tüm uygulamaya uygulanır.
- **Modüller arası bağımlılık tek yönlüdür; repository export politikası
  modülden modüle değişir — genel bir "repository asla paylaşılmaz" kuralı
  yoktur:**
  - `MembershipsModule` temel/paylaşılan bir modüldür ve repository'lerini
    doğrudan export eder (`SiteMembershipRepository`,
    `ResidentUnitAssignmentRepository`, `MembershipQueryService`,
    `SiteScopeGuard`); `AuthModule`, `FacilitiesModule`, `TicketsModule`,
    `AssignmentsModule` bunları import edip ortak kullanır.
  - `FacilitiesModule` da repository'sini doğrudan export eder
    (`FacilityRepository` ve `FacilityService`).
  - `AuthModule` ise repository'lerini kapatır: yalnızca
    `AuthSessionRevocationService`'i export eder; `RefreshSessionRepository`/
    `UserAuthRepository` diğer modüllere kapalıdır.
  - `TicketsModule` de repository'sini kapatır: yalnızca
    `TICKET_TRANSITION_PORT` adlı dar bir arayüzü export eder;
    `TicketRepository`/`TicketStateMachine` diğer modüllere kapalıdır.
    `AssignmentsModule`, ticket'a yalnızca bu port üzerinden erişir.
  - `MaterialsModule` de repository'sini kapatır: yalnızca
    `MaterialLookupService`'i export eder; `MaterialRepository` kapalıdır.
  - `AssignmentsModule` ve `UsersModule` hiçbir şey export etmez ("leaf"
    modüller): başka hiçbir modül bunlara bağımlı değildir, kendileri de
    tersine bir bağımlılık (`forwardRef`) kullanmaz; `AssignmentsModule`,
    `TicketRepository`/`MaterialRepository`'yi asla doğrudan enjekte etmez,
    yalnızca `TICKET_TRANSITION_PORT` ve `MaterialLookupService` üzerinden
    erişir.

## 10. Tenant İzolasyonu

`siteId` yalnızca aşağıdaki temel modellerde doğrudan tutulur:

- `SiteMembership.siteId`
- `Facility.siteId` (SITE dışındaki facility'ler kök SITE'a bu alanla bağlanır)
- `Ticket.siteId`
- `Contract.siteId`
- `AuditLog.siteId` (nullable)

Diğer modeller site kapsamını üst ilişkilerinden türetir:
`ResidentUnitAssignment` → `unit.siteId`, `Assignment` → `ticket.siteId`,
`AssignmentMaterial` → `assignment.ticket.siteId`, `TicketAttachment` →
`ticket.siteId`, `ContractInvoice` → `contract.siteId`.

Uygulama katmanında:

- `SiteScopeGuard` site kapsamlı endpointlerde üyelik doğrulaması yapar;
  `OPERATIONS` rolü yalnızca üyelik kontrolünü atlar, site'nin var olup
  olmadığı yine servis katmanında doğrulanır.
- Repository metotları anonim "tüm kayıtlar" sorgusu sunmaz; site kapsamlı
  metotlar `siteId` veya doğrulanmış bir scope parametresi ister.
- Assignment ve materyal sorguları ticket üzerinden, invoice sorguları
  contract üzerinden site filtresi uygular.
- Cross-site/unit erişim denemeleri `404` ile sonuçlanır (bilgi sızıntısı
  yapılmaz).

## 11. Güvenlik Yaklaşımı

- **Kimlik doğrulama:** Telefon numarasına OTP gönderimi, HMAC-SHA256 ile
  kod hash'leme, timing-safe karşılaştırma, `crypto.randomInt` ile rastgele
  kod üretimi (asla `Math.random` değil).
- **Rate limiting:** OTP istek/doğrulama uçları için adlandırılmış
  limiter'lar (`otpPhone`, `otpIp`, `otpCooldown`, `otpVerifyIp`).
- **Token yönetimi:** Access JWT rotasyon destekli çoklu secret ile
  imzalanır/doğrulanır (`JWT_ACCESS_SECRET` virgülle ayrılmış birden fazla
  değer alabilir); refresh token yalnızca hash'i veritabanında tutulur, ham
  değer asla saklanmaz.
- **Refresh token reuse detection:** Kullanılmış/revoke edilmiş bir refresh
  token tekrar sunulursa kullanıcının tüm aktif oturumları aynı transaction
  içinde revoke edilir ve audit kaydı yazılır.
- **RBAC:** Her endpoint `@Roles(...)` dekoratörüyle rol bazlı erişime tabidir.
- **HTTP güvenliği:** `helmet` middleware, `CORS_ALLOWED_ORIGINS` ile
  whitelist edilmiş origin listesi, `credentials: true`.
- **Girdi doğrulama:** Global `ValidationPipe` bilinmeyen alanları reddeder
  (`forbidNonWhitelisted`), doğrulama hatalarında `422` döner.
- **Loglama:** Secret, OTP kodu, ham token ve kişisel veriler loglanmaz;
  audit kayıtlarında serbest metin/ham not alanları taşınmaz.
- **Concurrency güvenliği:** Kritik satırlar `FOR UPDATE` ile kilitlenir
  (ticket, assignment, OTP challenge, refresh session); `Ticket.version`
  alanıyla optimistic locking uygulanır.
- **Container güvenliği:** Production Docker imajı non-root kullanıcıyla
  çalışır.

## 12. Proje Klasör Yapısı

```
prisma/
  schema.prisma
  migrations/
src/
  main.ts
  app.module.ts
  config/
    configuration.ts
    validation.schema.ts
  infrastructure/
    logging/
    database/
      prisma/
  generated/
    prisma-client/
  modules/
    auth/
    memberships/
    facilities/
    users/
    tickets/
      state/
    materials/
    assignments/
      state/
      services/
    health/
test/
  integration/
    setup/
  e2e/
    support/
docker-compose.yml
Dockerfile
prisma.config.ts
.env.example
```

## 13. Kurulum Gereksinimleri

- Node.js `>=24.0.0` (LTS)
- npm
- Docker ve Docker Compose (PostgreSQL için, opsiyonel olarak API için)
- PostgreSQL 16 (Docker ile çalıştırılmıyorsa yerel kurulum)

## 14. Windows Kurulumu

CMD üzerinden:

```cmd
git clone https://github.com/yusuufkesici/site-teknik-destek-backend.git
cd site-teknik-destek-backend
copy .env.example .env
npm.cmd install
docker compose up -d db
npm.cmd run prisma:generate
npm.cmd run prisma:migrate:dev
npm.cmd run start:dev
```

PowerShell kullanılacaksa aynı komutlar geçerlidir; yalnızca `npm` yerine
`npm.cmd` kullanılmalıdır.

`.env` dosyasındaki `change-me-...` ile başlayan secret değerlerini gerçek
değerlerle güncelleyin (bkz. bölüm 15). Testler (`test:integration`,
`test:e2e`) `@testcontainers/postgresql` kullanır ve Windows'ta `prisma
migrate deploy` komutunu `.cmd` uzantılı ikili için özel olarak
tetikleyerek çalışır; ek bir manuel adım gerekmez, yalnızca Docker'ın
çalışıyor olması gerekir.

## 15. Environment Değişkenleri

Değişken adları `.env.example` dosyasındaki adlarla birebir aynıdır.

| Değişken | Açıklama |
|---|---|
| `NODE_ENV` | `development` \| `test` \| `production` |
| `PORT` | API'nin dinleyeceği port |
| `DATABASE_URL` | PostgreSQL bağlantı adresi |
| `JWT_ACCESS_SECRET` | Access token imzalama secret'ı. Rotasyon için virgülle ayrılmış birden çok değer desteklenir; her segment en az 32 karakter olmalıdır. |
| `JWT_ACCESS_EXPIRES_IN` | Access token geçerlilik süresi (saniye) |
| `REFRESH_TOKEN_PEPPER` | Refresh token hash'lemede kullanılan pepper (en az 32 karakter) |
| `REFRESH_TOKEN_EXPIRES_IN` | Refresh token geçerlilik süresi (saniye) |
| `OTP_HMAC_SECRET` | OTP kodu hash'leme secret'ı (en az 32 karakter) |
| `OTP_EXPIRES_IN_SECONDS` | OTP kodunun geçerlilik süresi |
| `OTP_MAX_ATTEMPTS` | Bir challenge için izin verilen maksimum hatalı deneme |
| `OTP_RESEND_COOLDOWN_SECONDS` | Yeni OTP isteği için bekleme süresi |
| `SMS_PROVIDER` | `mock` \| `external` |
| `SMS_API_URL` | `SMS_PROVIDER=external` iken zorunlu |
| `SMS_API_KEY` | `SMS_PROVIDER=external` iken zorunlu |
| `STORAGE_PROVIDER` | `local` \| `s3` |
| `STORAGE_LOCAL_PATH` | `STORAGE_PROVIDER=local` iken zorunlu |
| `S3_ENDPOINT` | AWS dışı S3 uyumlu servisler için opsiyonel |
| `S3_REGION` | `STORAGE_PROVIDER=s3` iken zorunlu |
| `S3_BUCKET` | `STORAGE_PROVIDER=s3` iken zorunlu |
| `S3_ACCESS_KEY` | `STORAGE_PROVIDER=s3` iken zorunlu |
| `S3_SECRET_KEY` | `STORAGE_PROVIDER=s3` iken zorunlu |
| `S3_FORCE_PATH_STYLE` | `true`/`false` |
| `CORS_ALLOWED_ORIGINS` | Virgülle ayrılmış izinli origin listesi |
| `LOG_LEVEL` | `debug` \| `info` \| `warn` \| `error` |
| `EMERGENCY_SLA_HOURS` | `EMERGENCY` öncelikli ticket'lar için sabit SLA hedefi (yalnızca sözleşmede `emergencyCoverage=true` iken kullanılır) |

Koşullu doğrulama Zod şeması içinde (`src/config/validation.schema.ts`)
uygulanır ve yalnızca parse edilmiş nesne üzerinden çalışır:

- `NODE_ENV=production` iken `SMS_PROVIDER=mock` reddedilir.
- `SMS_PROVIDER=external` ise `SMS_API_URL`/`SMS_API_KEY` zorunlu olur.
- `STORAGE_PROVIDER=local` ise `STORAGE_LOCAL_PATH` zorunlu olur.
- `STORAGE_PROVIDER=s3` ise region/bucket/access key/secret key zorunlu olur.

API prefix (`api/v1`) environment değişkeni değildir; `src/config/configuration.ts`
içinde sabit olarak tanımlıdır.

## 16. Docker ile PostgreSQL Çalıştırma

Yalnızca veritabanını çalıştırmak için:

```powershell
docker compose up -d db
```

`db` servisi `postgres:16-alpine` imajını kullanır, `pg_isready` ile
healthcheck yapar. API'yi de container içinde çalıştırmak isterseniz:

```powershell
docker compose up --build
```

`api` servisi Dockerfile'ın `build` (ara) aşamasını hedefler, kaynak kodu
volume olarak bağlar (`npm run start:dev` ile hot reload), `node_modules`
ayrı bir named volume'dur ve `db` servisi healthy olmadan başlamaz.

## 17. Prisma Komutları

```powershell
npm run prisma:generate
npm run prisma:format
npm run prisma:validate
npm run prisma:migrate:dev
```

Prisma bağlantı URL'si `schema.prisma` içinde değil, `prisma.config.ts`
içinde tanımlıdır; runtime'da bağlantı `@prisma/adapter-pg` driver adapter
üzerinden `PrismaService` tarafından kurulur.

## 18. Uygulamayı Çalıştırma

```powershell
npm install
npm run start:dev
```

Production build:

```powershell
npm run build
npm run start:prod
```

## 19. Health Endpointleri

| Method | Endpoint | Açıklama |
|---|---|---|
| `GET` | `/api/v1/health/liveness` | Basit canlılık kontrolü, `{ status: 'ok' }` döner |
| `GET` | `/api/v1/health/readiness` | Prisma üzerinden `SELECT 1` çalıştırır; veritabanına ulaşılamıyorsa `503`, aksi halde `{ status: 'ok', database: 'ok' }` döner |

Bu iki endpoint `@Public()` olarak işaretlidir ve authentication gerektirmez.
Production Docker imajı, `HEALTHCHECK` için tam yol olan
`/api/v1/health/liveness` uç noktasını (`wget -qO- http://127.0.0.1:3000/api/v1/health/liveness`)
kullanır.

## 20. Kimlik Doğrulama Akışı

1. `POST /api/v1/auth/otp/request` — telefon numarasına OTP kodu üretilir
   (mock SMS sağlayıcı ile "gönderilir").
2. `POST /api/v1/auth/otp/verify` — kod doğrulanır; başarılıysa refresh
   session oluşturulur, `lastLoginAt` güncellenir, audit kaydı yazılır ve bu
   işlemler tek transaction içinde atomik yapılır. Access JWT, transaction
   commit edildikten sonra üretilir.
3. `POST /api/v1/auth/token/refresh` — refresh token rotasyonu yapılır.
   Kullanılmış/revoke edilmiş bir token tekrar sunulursa kullanıcının tüm
   oturumları revoke edilir ve istek reddedilir.
4. `POST /api/v1/auth/logout` — mevcut refresh session'ı revoke eder.
5. `GET /api/v1/auth/me` — giriş yapmış kullanıcının profilini döner.

**Login uygunluğu:**

- `OPERATIONS` ve `TECHNICIAN` için aktif, silinmemiş kullanıcı hesabı
  yeterlidir.
- `RESIDENT` ve `SITE_MANAGER` için ayrıca en az bir aktif site üyeliği
  gerekir.
- Sözleşme (contract) durumu login kontrolünde kullanılmaz.

**Feature entitlement (özellik bazlı yetki) kuralları:**

- Geçmiş ticket/fatura/sözleşme kayıtlarını görüntülemek, aktif üyelik ve
  kaynak erişimi varsa sözleşme sona ermiş olsa da mümkündür.
- Yeni ticket oluşturmak veya yeni bağımsız bir iş başlatmak aktif sözleşme
  gerektirir.
- Sözleşme askıya alınmış/sona ermiş/feshedilmiş olsa dahi daha önce açılmış
  ve henüz kapanmamış işler tamamlanabilir (kabul, durum geçişi, gerekirse
  yeniden atama dahil).
- SLA hedefi yalnızca ticket oluşturulduğu anda geçerli olan sözleşmeden
  hesaplanır.

## 21. Facility, Membership ve User Özellikleri

- `POST /api/v1/facilities/sites`, `.../blocks`, `.../units`,
  `.../common-areas` ile SITE → BLOCK → UNIT → COMMON_AREA hiyerarşisi
  yalnızca `OPERATIONS` tarafından oluşturulur.
- `GET /api/v1/facilities/sites/:siteId/tree` ile site ağacı görüntülenir
  (`SITE_MANAGER`, `OPERATIONS`; site kapsamı `SiteScopeGuard` ile
  doğrulanır).
- `POST /api/v1/sites/:siteId/residents` ile sakin onboarding yapılır
  (`SITE_MANAGER`, `OPERATIONS`); telefon numarası bazında
  `pg_advisory_xact_lock` ile eşzamanlılık koruması vardır; mevcut bir
  sakinin adı sessizce üzerine yazılmaz.
- `GET /api/v1/sites/:siteId/users` ile site kullanıcıları listelenir.
- `PATCH /api/v1/users/:id` ile profil güncellenir; `SITE_MANAGER` yalnızca
  yönettiği sitelerdeki kullanıcıların adını/telefonunu (kendi yönetim
  kapsamı bir alt küme olduğu sürece) değiştirebilir, `OPERATIONS` adı
  değiştirebilir fakat telefon değişikliği farklı kurallara tabidir; telefon
  değişikliği `tokenVersion`'ı artırır ve maskelenmiş audit kaydı bırakır.
- `POST /api/v1/sites/:siteId/users/:userId/deactivate` yalnızca ilgili
  site üyeliğini deaktive eder (kullanıcının global durumunu etkilemez).
- `POST /api/v1/users/:id/deactivate` (yalnızca `OPERATIONS`) kullanıcıyı
  global olarak deaktive eder ve tüm refresh session'ları revoke eder.
- `POST /api/v1/sites/:siteId/units/:unitId/assignments/:assignmentId/deactivate`
  ile bir sakin-unit eşleştirmesi deaktive edilir.
- Site dışı/unit dışı erişim denemeleri `404` döner.

## 22. Ticket Özellikleri

- Kategoriler (`TicketCategory`): `ELECTRICAL`, `PLUMBING`, `HVAC`, `PUMP`,
  `POOL`, `SECURITY_SYSTEM`, `GENERAL_MAINTENANCE`, `OTHER`.
- Öncelik (`TicketUrgency`): `STANDARD`, `URGENT`, `EMERGENCY`.
- Kaynak (`TicketSource`): `RESIDENT`, `SITE_MANAGER`, `OPERATIONS`,
  `PHONE_CALL`.
- `POST /api/v1/tickets` ile `RESIDENT`/`SITE_MANAGER`/`OPERATIONS` ticket
  oluşturabilir; yeni ticket açmak aktif sözleşme gerektirir.
- `GET /api/v1/tickets` cursor tabanlı sayfalama döner (`createdAt DESC, id
  DESC` sıralı, `items` + `nextCursor`).
- `PATCH /api/v1/tickets/:id` ile ticket alanları güncellenir; `urgency`
  değiştiğinde `slaTargetAt` yeniden hesaplanır.
- `operationNote` alanı yalnızca `OPERATIONS` rolüne dönen cevaplarda yer
  alır, diğer rollerden gizlenir.
- SLA hedefi: `EMERGENCY` öncelik + sözleşmede `emergencyCoverage=true` ise
  `EMERGENCY_SLA_HOURS`; aksi halde sözleşmenin
  `standardResponseTargetHours` alanı varsa o kullanılır, yoksa `null`.
- `Ticket.version` alanı optimistic locking için kullanılır.

## 23. Ticket Durum Yaşam Döngüsü

`TicketStatus`: `OPEN, TRIAGED, ASSIGNED, ACCEPTED, REJECTED, EN_ROUTE,
ARRIVED, IN_PROGRESS, WAITING_MATERIAL, COMPLETED, CLOSED, CANCELLED`

`TicketStateMachine` tarafından tanımlanan tüm geçişler:

| Mevcut Durum | Yeni Durum | Yetkili Roller | Gerekçe Zorunlu mu |
|---|---|---|---|
| OPEN | TRIAGED | OPERATIONS | Hayır |
| OPEN | CANCELLED | RESIDENT, SITE_MANAGER, OPERATIONS | Evet |
| TRIAGED | ASSIGNED | OPERATIONS | Hayır |
| TRIAGED | CANCELLED | SITE_MANAGER, OPERATIONS | Evet |
| ASSIGNED | ACCEPTED | TECHNICIAN | Hayır |
| ASSIGNED | REJECTED | TECHNICIAN | Evet |
| ASSIGNED | CANCELLED | OPERATIONS | Evet |
| REJECTED | ASSIGNED | OPERATIONS | Hayır |
| ACCEPTED | EN_ROUTE | TECHNICIAN | Hayır |
| EN_ROUTE | ARRIVED | TECHNICIAN | Hayır |
| ARRIVED | IN_PROGRESS | TECHNICIAN | Hayır |
| IN_PROGRESS | WAITING_MATERIAL | TECHNICIAN, OPERATIONS | Hayır |
| IN_PROGRESS | COMPLETED | TECHNICIAN | Hayır |
| WAITING_MATERIAL | IN_PROGRESS | TECHNICIAN, OPERATIONS | Hayır |
| COMPLETED | CLOSED | OPERATIONS | Hayır |
| COMPLETED | IN_PROGRESS | OPERATIONS | Evet |

`CLOSED` ve `CANCELLED` terminal durumlardır (çıkış geçişi yoktur).

**Önemli:** yukarıdaki tablo state machine'in tam tanımıdır; ancak API
seviyesinde hangi geçişlerin hangi endpoint'ten tetiklenebileceği ayrıca
kısıtlanmıştır:

- `POST /api/v1/tickets/:id/status` ve `POST /api/v1/tickets/:id/cancel`
  yalnızca şu dört geçişe izin verir: `OPEN→TRIAGED`, `OPEN→CANCELLED`,
  `TRIAGED→CANCELLED`, `COMPLETED→CLOSED` (yalnızca `OPERATIONS`).
- `TRIAGED→ASSIGNED`, `REJECTED→ASSIGNED`, `ASSIGNED→ACCEPTED`,
  `ASSIGNED→REJECTED`, `ASSIGNED→CANCELLED` ve teknisyen iş akışı
  geçişleri (`ACCEPTED→EN_ROUTE→ARRIVED→IN_PROGRESS↔WAITING_MATERIAL→COMPLETED`)
  yalnızca assignment endpointleri (bölüm 25) üzerinden, atomik olarak
  tetiklenir.
- `COMPLETED → IN_PROGRESS` state machine tablosunda tanımlı olsa da hiçbir
  endpoint bu geçişe izin vermez; denenirse `409` döner. Bu bilinçli bir
  tasarım kararıdır (yeniden açma desteklenmez).
- Aynı durumdan aynı duruma geçiş denemesi (`from === to`) `409
  TICKET_STATUS_UNCHANGED` ile reddedilir ve history kaydı oluşturulmaz.
- Ticket zaten `ASSIGNED` iken teknisyen değiştirilirse (yeniden atama),
  ticket durumu `ASSIGNED` olarak kalır; ikinci bir `ASSIGNED→ASSIGNED`
  history kaydı oluşmaz, yalnızca eski assignment `REASSIGNED` yapılır.

## 24. Assignment Özellikleri

- `POST /api/v1/tickets/:ticketId/assignments` (yalnızca `OPERATIONS`) —
  teknisyen atar/yeniden atar. Ticket `TRIAGED`, `REJECTED` veya `ASSIGNED`
  durumundaysa atanabilir; yeniden atamada eski assignment `REASSIGNED`
  olur.
- `POST /api/v1/assignments/:id/accept` (yalnızca kendi assignment'ı olan
  `TECHNICIAN`) — atamayı kabul eder.
- `POST /api/v1/assignments/:id/reject` (`TECHNICIAN`, gerekçe zorunlu) —
  atamayı reddeder.
- `POST /api/v1/assignments/:id/status` (`TECHNICIAN` veya `OPERATIONS`) —
  durum olayını ilerletir (bkz. bölüm 25).
- `POST /api/v1/assignments/:id/cancel` (yalnızca `OPERATIONS`, gerekçe
  zorunlu) — yalnızca ticket `ASSIGNED` ve assignment
  `PENDING`/`ACCEPTED`/`ACTIVE` iken geçerlidir; ticket ve assignment aynı
  transaction içinde atomik olarak `CANCELLED` yapılır.
- `GET /api/v1/assignments/my` (`TECHNICIAN`) — kendi atamalarını
  sayfalanmış olarak listeler.
- `POST /api/v1/assignments/:id/materials` (`TECHNICIAN` kendi assignment'ı
  veya `OPERATIONS`) — yalnızca assignment `ACTIVE` iken malzeme ekler.
- `GET /api/v1/assignments/:id/materials` (`TECHNICIAN` sahibi,
  `SITE_MANAGER` kendi sitesi, `OPERATIONS`) — malzeme kayıtlarını listeler.

Tüm bu operasyonlar `TicketAssignmentWorkflowService` tarafından; her
zaman önce ticket, sonra assignment satırının kilitlendiği tek bir
transaction içinde yürütülür.

## 25. Assignment Durum Yaşam Döngüsü

`AssignmentStatus`: `PENDING, ACCEPTED, REJECTED, ACTIVE, COMPLETED,
CANCELLED, REASSIGNED`

Durum olayı haritası (`assignment-status-event.map.ts`), her olayı hem
assignment geçişine hem de karşılık gelen ticket durumuna eşler:

| Olay | Assignment Geçişi | Sonuç Ticket Durumu | Zaman Damgası |
|---|---|---|---|
| `EN_ROUTE` | ACCEPTED → ACTIVE | EN_ROUTE | `enRouteAt` |
| `ARRIVED` | ACTIVE → ACTIVE | ARRIVED | `arrivedAt` |
| `START` | ACTIVE → ACTIVE | IN_PROGRESS | `startedAt` |
| `WAIT_MATERIAL` | ACTIVE → ACTIVE | WAITING_MATERIAL | — |
| `RESUME` | ACTIVE → ACTIVE | IN_PROGRESS | — |
| `COMPLETE` | ACTIVE → COMPLETED | COMPLETED | `completedAt` |

`COMPLETE` olayında assignment `isCurrent=false` yapılır ve opsiyonel bir
`note` (çözüm notu) kabul edilir; `note` başka hiçbir olayda gönderilemez
(gönderilirse `422`). Assignment durum kurallarında ayrı bir rol tablosu
tutulmaz; roller `TicketStateMachine`'deki tabloyla tutarlıdır.

## 26. Material Kullanımı

- Malzeme kataloğu (`Material` modeli) yalnızca okunur; ekleme/düzenleme
  endpointi yoktur. `MaterialLookupService.assertActiveMaterial` ile bir
  malzemenin var ve aktif olduğu doğrulanır.
- `AssignmentMaterial` kaydı: `quantity` (`Decimal(12,3)`), `unitPrice` ve
  `totalPrice` (`Decimal(12,2)`) — kayan nokta (float) kullanılmaz.
- `suppliedBy` (`SuppliedBy` enum): `COMPANY`, `SITE_MANAGEMENT`,
  `RESIDENT`, `TECHNICIAN`, `OTHER`.
- Malzeme yalnızca assignment `ACTIVE` durumdayken eklenebilir; aksi halde
  `409 ASSIGNMENT_MATERIAL_NOT_ALLOWED` döner.

## 27. Mevcut REST Endpointleri

Tüm yollar `/api/v1` prefix'i ile başlar. Global guard'lar nedeniyle
`@Public()` işaretli olmayan her endpoint authentication gerektirir.

### auth

| Method | Endpoint | Roller | Açıklama |
|---|---|---|---|
| POST | `/auth/otp/request` | Public | OTP kodu ister |
| POST | `/auth/otp/verify` | Public | OTP doğrular, token çifti döner |
| POST | `/auth/token/refresh` | Public | Refresh token rotasyonu |
| POST | `/auth/logout` | Giriş yapmış kullanıcı | Refresh session'ı revoke eder |
| GET | `/auth/me` | Giriş yapmış kullanıcı | Kullanıcı profilini döner |

### facilities

| Method | Endpoint | Roller | Açıklama |
|---|---|---|---|
| POST | `/facilities/sites` | OPERATIONS | Site oluşturur |
| POST | `/facilities/sites/:siteId/blocks` | OPERATIONS | Blok oluşturur |
| POST | `/facilities/blocks/:blockId/units` | OPERATIONS | Bağımsız bölüm oluşturur |
| POST | `/facilities/:parentId/common-areas` | OPERATIONS | Ortak alan oluşturur |
| GET | `/facilities/sites/:siteId/tree` | SITE_MANAGER, OPERATIONS | Site ağacını döner |

### users

| Method | Endpoint | Roller | Açıklama |
|---|---|---|---|
| POST | `/sites/:siteId/residents` | SITE_MANAGER, OPERATIONS | Sakin onboarding |
| GET | `/sites/:siteId/users` | SITE_MANAGER, OPERATIONS | Site kullanıcılarını listeler |
| PATCH | `/users/:id` | SITE_MANAGER, OPERATIONS | Kullanıcı profili günceller |
| POST | `/sites/:siteId/users/:userId/deactivate` | SITE_MANAGER, OPERATIONS | Site üyeliğini deaktive eder |
| POST | `/users/:id/deactivate` | OPERATIONS | Kullanıcıyı global deaktive eder |
| POST | `/sites/:siteId/units/:unitId/assignments/:assignmentId/deactivate` | SITE_MANAGER, OPERATIONS | Sakin-unit eşleştirmesini deaktive eder |

### tickets

| Method | Endpoint | Roller | Açıklama |
|---|---|---|---|
| POST | `/tickets` | RESIDENT, SITE_MANAGER, OPERATIONS | Ticket oluşturur |
| GET | `/tickets` | RESIDENT, SITE_MANAGER, OPERATIONS | Ticket listeler (cursor pagination) |
| GET | `/tickets/:id` | RESIDENT, SITE_MANAGER, OPERATIONS, TECHNICIAN | Ticket detayını döner |
| PATCH | `/tickets/:id` | RESIDENT, SITE_MANAGER, OPERATIONS | Ticket günceller |
| POST | `/tickets/:id/status` | OPERATIONS | Durum geçişi yapar |
| POST | `/tickets/:id/cancel` | RESIDENT, SITE_MANAGER, OPERATIONS | Ticket iptal eder |
| GET | `/tickets/:id/history` | RESIDENT, SITE_MANAGER, OPERATIONS, TECHNICIAN | Durum/audit geçmişini döner |

### assignments

| Method | Endpoint | Roller | Açıklama |
|---|---|---|---|
| POST | `/tickets/:ticketId/assignments` | OPERATIONS | Teknisyen atar/yeniden atar |
| POST | `/assignments/:id/accept` | TECHNICIAN | Atamayı kabul eder |
| POST | `/assignments/:id/reject` | TECHNICIAN | Atamayı reddeder |
| POST | `/assignments/:id/status` | TECHNICIAN, OPERATIONS | Durum olayı ilerletir |
| POST | `/assignments/:id/cancel` | OPERATIONS | Atanmış ticket'ı iptal eder |
| GET | `/assignments/my` | TECHNICIAN | Kendi atamalarını listeler |
| POST | `/assignments/:id/materials` | TECHNICIAN, OPERATIONS | Malzeme kullanımı ekler |
| GET | `/assignments/:id/materials` | TECHNICIAN, SITE_MANAGER, OPERATIONS | Malzeme kayıtlarını listeler |

### health

| Method | Endpoint | Roller | Açıklama |
|---|---|---|---|
| GET | `/health/liveness` | Public | Canlılık kontrolü |
| GET | `/health/readiness` | Public | Veritabanı bağlantısını kontrol eder |

## 28. Standart API Başarı ve Hata Cevapları

- Başarılı cevaplar için standart HTTP kodları kullanılır: `200` (okuma),
  `201` (oluşturma), `204` (gövdesiz işlem, örn. deaktivasyon/logout).
- Liste endpointleri (`GET /tickets`, `GET /assignments/my`) cursor tabanlı
  sayfalama şekli döner: `{ items: [...], nextCursor: string | null }`.
- Girdi doğrulama hataları global `ValidationPipe` tarafından `422
  Unprocessable Entity` olarak döner.
- Domain kuralları global `GlobalExceptionFilter` üzerinden uygun HTTP
  koduna çevrilir. Bilinen bazı hata kodları:

| Hata Kodu | HTTP | Anlamı |
|---|---|---|
| `TICKET_STATUS_UNCHANGED` | 409 | `from === to` durum geçişi denemesi |
| `TICKET_INVALID_STATUS_TRANSITION` | 409 | Tanımsız veya endpoint seviyesinde izinsiz geçiş |
| `TICKET_TRANSITION_FORBIDDEN` | 403 | Geçişe rolün yetkisi yok |
| `TICKET_TRANSITION_REASON_REQUIRED` | 422 | Gerekçe zorunlu olan geçişte gerekçe eksik |
| `ASSIGNMENT_NOT_FOUND` | 404 | Assignment bulunamadı |
| `ASSIGNMENT_TECHNICIAN_INVALID` | 422 | Geçersiz/uygun olmayan teknisyen ataması |
| `ASSIGNMENT_STATUS_CONFLICT` | 409 | Beklenmeyen assignment durumu |
| `ASSIGNMENT_MATERIAL_NOT_ALLOWED` | 409 | Assignment `ACTIVE` değilken malzeme ekleme denemesi |

Bu liste ayrıntılı olmayıp yalnızca en sık karşılaşılan kodları örnekler;
tam liste kaynak kodda ilgili domain error tanımlarında yer alır.

## 29. Transaction ve Concurrency Yaklaşımı

- **Ticket + assignment orkestrasyonu:** `TicketAssignmentWorkflowService`
  her operasyonda tek bir `$transaction` açar, her zaman önce ticket sonra
  assignment satırını `FOR UPDATE` ile kilitler.
- **OTP doğrulama:** Beklenen hatalarda (yanlış kod, deneme limiti) transaction
  içinde exception fırlatılmaz; discriminated result (`SUCCESS`,
  `INVALID_OTP`, `MAX_ATTEMPTS_REACHED`, `USER_INACTIVE`) döner ve
  transaction normal şekilde commit edilir; servis katmanı sonucu uygun
  domain hatasına çevirir.
- **Başarılı login:** OTP tüketimi, login uygunluğu doğrulaması, refresh
  session oluşturma, `lastLoginAt` güncelleme ve audit kaydı tek
  transaction'da yapılır; access JWT commit sonrasında üretilir.
- **Refresh reuse detection:** Reuse tespit edildiğinde kullanıcının tüm
  aktif session'ları aynı transaction içinde revoke edilir, audit kaydı
  yazılır, transaction `REUSE_DETECTED` sonucuyla commit edilir.
- **Optimistic locking:** `Ticket.version` alanı eşzamanlı güncellemeleri
  algılamak için kullanılır.
- **Onboarding eşzamanlılığı:** Sakin onboarding'de telefon numarası
  bazında `pg_advisory_xact_lock` kullanılır.
- **Eşzamanlılık senaryoları (Faz 5):** `TicketAssignmentWorkflowService`
  her operasyonda önce ticket satırını `FOR UPDATE` ile kilitlediği için
  çakışan istekler PostgreSQL tarafından sıraya konur; satırı önce kilitleyen
  istek tamamlanır, ikinci istek güncellenmiş duruma göre değerlendirilir:
  - **ACCEPT vs CANCEL:** Aynı assignment için gelen `POST
    /assignments/:id/accept` (teknisyen) ve `POST /assignments/:id/cancel`
    (OPERATIONS) istekleri aynı anda işlenirse, ticket satırını önce
    kilitleyen işlem tamamlanır; ikinci istek artık beklediği ön koşulu
    (ör. assignment durumu) bulamazsa reddedilir.
  - **İki paralel `assign` isteği:** Aynı ticket için eş zamanlı iki teknisyen
    atama isteği geldiğinde ticket satırı kilidi sayesinde yalnızca biri ilk
    sırada işlenir; ikinci istek ticket'ın artık güncellenmiş durumunu
    (örn. `ASSIGNED`) görür ve buna göre yeniden atama olarak ele alınır ya
    da reddedilir.
  - **Assign/reassign yarışları:** Bir ticket için yeniden atama ile eş
    zamanlı yeni bir atama isteği geldiğinde de aynı ticket satırı kilidi
    isteklerin sırayla işlenmesini garanti eder; ikinci istek önceki isteğin
    sonucunda oluşan assignment/ticket durumunu temel alır.

## 30. Audit ve Outbox Yaklaşımı

- `AuditLog` modeli append-only'dir, hiçbir foreign key taşımaz (entity
  referansı `entityType` + `entityId` ile gevşek tutulur); `siteId`
  nullable'dır.
- Audit kayıtlarında serbest metin gerekçe/not alanları ham olarak
  taşınmaz.
- `OutboxEvent` modeli (`status`: `PENDING`, `PROCESSING`, `PROCESSED`,
  `FAILED`) mevcuttur; mevcut `OutboxService` yalnızca transaction içinde
  olay yazar (`publishInTx`). Olayları tüketen bir relay/consumer henüz
  uygulanmamıştır.

## 31. Test Yapısı

| Katman | Konum | Çalıştırma | Açıklama |
|---|---|---|---|
| Unit | `src/**/*.spec.ts` (kaynak koduyla aynı klasörde) | `npm test` | Jest, `jest.config.ts` |
| Integration | `test/integration/**/*.integration-spec.ts` | `npm run test:integration` | Gerçek PostgreSQL, `@testcontainers/postgresql` |
| E2E | `test/e2e/**/*.e2e-spec.ts` | `npm run test:e2e` | Tam uygulama + `supertest`, Testcontainers |

Integration ve E2E testleri, veritabanını `postgres:16-alpine` içeren bir
Testcontainers container'ında ayağa kaldırıp `prisma migrate deploy`
çalıştırır; bu kurulum hem integration hem e2e testler tarafından ortak bir
yardımcı (`test/integration/setup/postgres-testcontainer.ts`) üzerinden
paylaşılır.

## 32. Güncel Doğrulanmış Test Sonuçları

- Unit: 23 suite / 243 test
- Integration: 14 suite / 54 test
- E2E: 4 suite / 20 test
- Integration ve E2E testleri gerçek PostgreSQL/Testcontainers ile geçmiştir.
- Lint, build, Prisma format/validate ve Docker Compose config kontrolleri
  başarılıdır.
- Faz 1–4 regresyonu yoktur.

## 33. Git Branch ve Pull Request Çalışma Biçimi

Depodaki geçmiş, her fazın ayrı bir özellik dalında geliştirilip `main`
dalına Pull Request ile birleştirildiği bir akış izler, örneğin:
`phase-4-ticket-core` ve `phase-5-assignments-materials` dalları PR ile
`main`'e merge edilmiştir. Commit mesajları `feat: complete phase N ...`
biçimindedir.

## 34. Faz 6–9 Planlanan Yol Haritası

Aşağıdaki kapsam yalnızca Prisma şemasından tahmin edilmemiştir; genel
kapsam mimari belgede (`docs/architecture.md`) yer almaktadır. Her fazın
ayrıntılı teknik kararları, ilgili fazın implementasyon planı onaylandığında
kesinleşecektir.

- **Faz 6 — Attachments:** Ticket/assignment'a dosya eki yükleme, `local`/`s3`
  storage sağlayıcı entegrasyonu, `assignmentId` verildiğinde
  `ticketId` eşleşme doğrulaması.
- **Faz 7 — Contracts & Billing:** Sözleşme CRUD, fatura (invoice)
  oluşturma/listeleme, ödeme durumu takibi.
- **Faz 8 — Notifications & Outbox Relay:** Outbox olaylarının tüketilmesi,
  SMS/push bildirim gönderimi.
- **Faz 9 — Üretime hazırlık:** Güvenlik sertleştirmesi, deployment ve
  yayın hazırlığı, gözlemlenebilirlik/monitoring, Swagger/OpenAPI
  dokümantasyonu, gerçek SMS sağlayıcı entegrasyonu, performans ve
  güvenlik testleri.

## 35. Üretime Geçmeden Önce Yapılması Gerekenler

- Gerçek bir SMS sağlayıcı entegre edilmeli (`SMS_PROVIDER=external`).
- Attachment özelliği tamamlanmadan önce gerçek nesne depolama (S3) veya
  yerel depolama akışı uçtan uca test edilmeli.
- Outbox relay/consumer uygulanmalı; bildirim gönderimi olmadan outbox
  olayları yalnızca veritabanında birikir.
- Sözleşme/faturalama modülleri tamamlanmadan gelir etkileyen akışlar
  devreye alınmamalı.
- Production secret'ları (`JWT_ACCESS_SECRET`, `REFRESH_TOKEN_PEPPER`,
  `OTP_HMAC_SECRET` vb.) güvenli bir secret yönetimi aracıyla sağlanmalı,
  `.env` dosyası ile production'a taşınmamalı.
- `CORS_ALLOWED_ORIGINS` production domain'leri ile güncellenmeli.
- Rate limit eşikleri gerçek trafik beklentisine göre gözden geçirilmeli.
- Swagger/OpenAPI dokümantasyonu eklenmeli.
- Yük/performans testleri ve güvenlik değerlendirmesi (pen test) yapılmalı.
- PostgreSQL için yedekleme ve felaket kurtarma (backup/DR) planı
  oluşturulmalı.
- Production için log seviyesi ve izleme/alerting altyapısı kurulmalı.

## 36. Lisans ve Proje Durumu

- `package.json` içinde lisans `UNLICENSED`, paket `private: true` olarak
  işaretlidir.
- Proje aktif geliştirme aşamasındadır; Faz 1–5 tamamlanmış olup üretime
  hazır (production-ready) bir MVP değildir (bkz. bölüm 35).

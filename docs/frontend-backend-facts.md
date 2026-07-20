# Frontend için Backend Gerçekleri (Tek Güvenilir Kaynak)

Bu belge, frontend ekibinin kullanacağı backend davranışlarını **yalnız çalışan
kaynak koddan** çıkarır. Kod ile diğer belgeler çeliştiğinde kod esas alınmıştır
ve çelişkiler Bölüm 15'te raporlanmıştır. Kodda doğrulanamayan konular
`BELİRSİZ`, kodda bulunmayanlar `UYGULANMAMIŞ` olarak işaretlenmiştir.

---

## 1. Belge statüsü

- **İncelenen branch:** `main`
- **Backend kaynak commit:** `13da24e4e23730aeb10b1e1daebb87d2d90c94be` —
  "Merge pull request #8 from yusuufkesici/phase-10-production-integrations"
  (PR #8 merge edildi; dört frontend discovery endpoint'i —
  `GET /materials`, `GET /users/technicians`, `GET /users/me/units`,
  `GET /tickets/:ticketId/assignments/current` — bu commit ile `main`'e
  merge edilmiştir).
- **Test durumu (merge öncesi doğrulama):** 632 unit + 147 integration +
  53 E2E = **832 test**, tamamı geçti. Merge sonrası `main` branch CI
  koşumu (`Lint, build ve testler` + `Production imaj build ve boot
  smoke`) **başarılı** sonuçlandı.
- **İnceleme tarihi:** 2026-07-19 (keşif uçları güncellemesi dahil),
  2026-07-20'de PR #8 merge sonrası metadata güncellemesi.
- **İncelenen temel belgeler:** `docs/implementation-overrides.md`,
  `docs/architecture.md` (Bölüm 7, 11, 17 hedefli okuma), `.env.example`,
  `.github/workflows/ci.yml`, `prisma/seed.ts`. `docs/manual-acceptance.md`,
  `docs/operations-runbook.md` ve faz planları bu incelemede yalnız referans
  olarak listelendi, içerikleri satır satır doğrulanmadı.
- **İncelenen temel kod alanları:** `src/main.ts`, `src/app.module.ts`, 11
  controller dosyasının tamamı, tüm request DTO'ları, mapper'lar
  (ticket/assignment/material/attachment/contract/invoice), auth zinciri
  (`AuthService`, `OtpService`, `TokenService`, `JwtAuthGuard`, `RolesGuard`,
  `SiteScopeGuard`), state machine'ler (ticket/assignment-event/contract/
  invoice), `TicketAssignmentWorkflowService`, attachment servis + storage,
  contract/invoice servis kuralları, pagination utility,
  `GlobalExceptionFilter`, error-code sabitleri, Prisma şema + 5 migration,
  rate limiter, notifications pipeline, dev SMS inbox, seed, E2E testler.

---

## 2. Uygulamanın HTTP temeli

| Konu | Gerçek davranış | Kanıt |
|---|---|---|
| Base URL / API prefix | Tüm route'lar `api/v1` global prefix'i altındadır (ör. `POST /api/v1/auth/otp/request`). | `src/main.ts:21` (`setGlobalPrefix`), `src/config/configuration.ts` — `appConfig.apiPrefix = 'api/v1'` |
| API versioning | Yalnız URL prefix'i (`/api/v1`). Nest `enableVersioning` YOK; header/media-type versioning UYGULANMAMIŞ. | `src/main.ts` |
| JSON body limiti | `100kb` (JSON + urlencoded). Aşılırsa **413** + `VALIDATION_ERROR` kodu. Multipart (attachment) bu limitten etkilenmez — Multer sınırı ayrıdır (10 MB). | `src/common/constants/http-body-limit.constant.ts`, `src/main.ts:31-32`, `src/common/filters/global-exception.filter.ts:88-94` |
| CORS | Allowlist `CORS_ALLOWED_ORIGINS` (virgülle ayrılmış, yalnız `http(s)://host[:port]` biçimi; `*` ve path'li girdiler env doğrulamasında reddedilir). **`credentials: true` her zaman açık.** | `src/main.ts:34-37`, `src/config/validation.schema.ts` (`isValidHttpOrigin`), `src/config/configuration.ts` (`corsConfig`) |
| Başarı response zarfı | **Zarf YOK.** Başarı yanıtları çıplak DTO/JSON döner (global TransformInterceptor yok; `success: true` hiçbir yerde üretilmez). Liste uçları `{ items: [...], nextCursor: string \| null }` biçimindedir. | Tüm controller'lar; `rg "success: true" src` → 0 sonuç; `docs/architecture.md` Bölüm 17 satır #1 aynı gerçeği kayda geçirir |
| Hata response zarfı | `{ "success": false, "error": { "code", "message", "requestId", "timestamp", "details?" } }` — tüm hatalar için tek biçim. | `src/common/filters/global-exception.filter.ts` — `GlobalExceptionFilter.catch()`, `src/common/types/error-response.type.ts` |
| Validation hataları | Global `ValidationPipe` (`whitelist: true`, `forbidNonWhitelisted: true`, `transform: true`) hataları **422** üretir; kod `VALIDATION_ERROR`, `details` alanı class-validator mesaj dizisidir. **Bilinmeyen body alanı 422 ile reddedilir.** `ParseUUIDPipe` kullanılan contract/billing path paramlarında geçersiz UUID de 422 döner. | `src/main.ts:39-46`, `global-exception.filter.ts` (`extractDetails`, `mapStatusToCode`), `src/modules/contracts/contracts.controller.ts:19` |
| Request ID | `x-request-id` isteği header'ı varsa kullanılır, yoksa UUID üretilir; **hata zarfındaki `error.requestId`** ve loglarda görünür. Başarı yanıtlarına response header olarak yazıldığına dair kanıt yok → `BELİRSİZ` (frontend requestId'yi yalnız hata gövdesinden okumalı). | `src/infrastructure/logging/logger.module.ts:39-43`, `global-exception.filter.ts:30` |
| Tarih serialization | `Date` alanları Express `res.json` üzerinden **ISO-8601 UTC** string olarak döner (`2026-07-19T12:34:56.789Z`). İstisna: takvim tarihi alanları (`Contract.startDate/endDate`, invoice dönem/vade/kesim tarihleri) mapper'da **`YYYY-MM-DD`** stringine indirgenir. | `src/modules/contracts/mappers/contract.mapper.ts`, `src/modules/billing/mappers/invoice.mapper.ts` |
| Decimal serialization | Para/miktar alanları **string** döner ve ölçek sabittir: `quantity` → `toFixed(3)` (ör. `"3.000"`), `unitPrice`/`totalPrice`/`monthlyFee`/`amount` → `toFixed(2)` (ör. `"37.50"`). Request'te de string beklenir (regex doğrulamalı). | `src/modules/assignments/mappers/assignment-material.mapper.ts`, `contract.mapper.ts`, `invoice.mapper.ts`, `AddMaterialDto` |
| Güvenlik header'ları | `helmet()` açık. | `src/main.ts:23` |
| Swagger/OpenAPI | **UYGULANMAMIŞ.** `@nestjs/swagger` bağımlılığı yok, `main.ts`'te kurulum yok. | `package.json`, `src/main.ts` |

---

## 3. Kullanıcı rolleri

Prisma `UserRole` enum: `RESIDENT`, `SITE_MANAGER`, `OPERATIONS`, `TECHNICIAN`
(`prisma/schema.prisma:24-29`). PLATFORM_ADMIN yoktur (overrides §10).

Yetkilendirme üç katmanlıdır: `JwtAuthGuard` + `RolesGuard` global
(`src/modules/auth/auth.module.ts` — `APP_GUARD`), `SiteScopeGuard` route
bazında, kaynak-bazlı kontroller policy/service katmanında.

### RESIDENT (sakin)
- **Amaç:** kendi dairesi için arıza kaydı açmak ve takip etmek.
- **Yapabildikleri:** OTP login (aktif site üyeliği şart); kendi aktif
  unit'lerini keşfetme (`GET /users/me/units`); `POST /tickets`
  (yalnız kendi aktif `ResidentUnitAssignment`'ındaki UNIT için —
  `TicketAuthorizationPolicy.assertCanCreate`); kendi ticket'larını listeleme
  (`GET /tickets` filtre otomatik `createdByUserId = ben`); kendi ticket
  detayı/history; kendi OPEN ticket'ını PATCH; kendi ticket'ını reason ile
  iptal (OPEN durumunda); kendi ticket'ına attachment upload (assignmentId
  GÖNDEREMEZ) ve listeleme/download.
- **Liste sınırı:** yalnız kendi oluşturduğu ticket'lar; site geneli liste yok.
- **Görmemesi gereken işlemler:** `operationNote` (response'tan tamamen
  çıkarılır — `ticket.mapper.ts`), assignment/teknisyen uçları, facility
  yönetimi, contract/invoice uçları, kullanıcı yönetimi.
- **Kaynak dışı erişim cevabı:** uniform **404** (`TICKET_NOT_FOUND` vb.).

### SITE_MANAGER (site yöneticisi)
- **Amaç:** kendi sitesinin sakin/ticket/sözleşme görünürlüğü ve sakin yönetimi.
- **Yapabildikleri:** login (aktif MANAGER üyeliği şart); kendi sitesi için
  ticket açma; site ticket listesi (`GET /tickets?siteId=` **zorunlu**,
  MANAGER üyeliği doğrulanır); ticket detay/history (kendi sitesi); OPEN/TRIAGED
  ticket'larda içerik PATCH; OPEN/TRIAGED iptal; sakin onboarding
  (`POST /sites/:siteId/residents`), site kullanıcı listesi, profil güncelleme,
  site-scoped pasifleştirme, unit-assignment pasifleştirme;
  `GET /sites/:siteId/contracts` ve `GET /sites/:siteId/invoices` (salt-okuma);
  `GET /assignments/:id/materials` (kendi sitesinin ticket'ı üzerinden);
  attachment upload/list/download (kendi sitesi, assignmentId gönderemez);
  `GET /facilities/sites/:siteId/tree`.
- **Sınırlar:** başka sitenin `siteId`'siyle her istek **404 SITE_NOT_FOUND**
  (`SiteScopeGuard`); contract/invoice **yazamaz**; teknisyen atayamaz; ticket
  durum geçişi yapamaz (yalnız cancel); global kullanıcı pasifleştiremez;
  OPERATIONS telefon değiştirme kuralının aksine SM kendi sitesinin sakininin
  profil/telefonunu `UserAccessPolicy` kurallarıyla güncelleyebilir.
- **Site kapsamı:** `SiteMembership (membershipRole=MANAGER, isActive)` —
  `MembershipQueryService.hasActiveManagerMembership`.

### OPERATIONS (şirket operasyon)
- **Amaç:** cross-site operasyon otoritesi.
- **Yapabildikleri:** facility oluşturma (site/blok/unit/ortak alan), facility
  ağacı; sakin onboarding ve kullanıcı yönetimi (global pasifleştirme dahil;
  **telefon değiştiremez** — `users.service.ts:144-150`); tüm ticket'ları
  listeleme (siteId filtresi opsiyonel)/okuma/güncelleme (`operationNote` dahil);
  `OPEN→TRIAGED` ve `COMPLETED→CLOSED` doğrudan geçişleri; ticket iptalleri;
  teknisyen keşfi (`GET /users/technicians`) ve atama/yeniden atama; ticket'ın
  current assignment'ını görüntüleme (`GET /tickets/:ticketId/assignments/current`);
  `ASSIGNED` ticket iptali
  (`POST /assignments/:id/cancel`); assignment status event'lerinden
  `WAIT_MATERIAL`/`RESUME` (state machine rol tablosu gereği); malzeme ekleme
  ve listeleme; her ticket'a attachment (tip kısıtsız, assignmentId
  verebilir); contract CRUD + durum geçişleri; invoice oluşturma + durum
  geçişleri; site contract/invoice listeleri.
- **Site kapsamı:** yok — `SiteScopeGuard` OPERATIONS'ı koşulsuz geçirir
  (`site-scope.guard.ts:38-40`); ticket okuma da koşulsuzdur
  (`ticket-authorization.policy.ts` — `case 'OPERATIONS'`).

### TECHNICIAN (teknisyen)
- **Amaç:** kendisine atanan işleri yürütmek.
- **Yapabildikleri:** login (üyelik şartı yok, aktif hesap yeter);
  `GET /assignments/my` (yalnız kendi kayıtları, `status` filtresi);
  accept/reject (`PENDING` durumundaki kendi ataması); durum event'leri
  (`EN_ROUTE`, `ARRIVED`, `START`, `WAIT_MATERIAL`, `RESUME`, `COMPLETE`);
  material kataloğunu keşfetme (`GET /materials`); malzeme ekleme (yalnız
  kendi `ACTIVE` assignment'ı); kendi assignment'ına
  `BEFORE_WORK`/`AFTER_WORK`/`MATERIAL` tipli fotoğraf upload;
  atandığı ticket'ın detayını/history'sini/attachment'larını okuma.
- **Sınırlar:** **`GET /tickets` listesine erişemez → 403 FORBIDDEN**
  (`ticket.service.ts:218-225`); ticket oluşturamaz/PATCH edemez/iptal edemez;
  başka teknisyenin assignment'ında her işlem **404 ASSIGNMENT_NOT_FOUND**;
  attachment tip kısıtı dışına çıkarsa **422 ATTACHMENT_TYPE_NOT_ALLOWED**.

---

## 4. Authentication

Tamamı `src/modules/auth/` — yalnız çalışan kod esas alınmıştır.

- **OTP request:** `POST /auth/otp/request` (`@Public`), body
  `{ phoneNumber }` (E.164'e normalize edilir; geçersiz format 422).
  **Her koşulda** `200 { "message": "Numara sistemde kayitliysa dogrulama kodu gonderildi." }`
  döner (enumeration koruması — `auth.service.ts:62-67`). Rate limitler
  (bellek içi, `rate-limiter.service.ts`): telefon başına 3/600 sn, IP başına
  10/600 sn, cooldown `OTP_RESEND_COOLDOWN_SECONDS` (örnek env: 60 sn). Limit
  aşımı da **sessizce aynı 200 mesajını döndürür** (reddin nedeni sızmaz,
  `otp.service.ts:40-51`). OTP 6 haneli, `OTP_EXPIRES_IN_SECONDS` (örnek: 180 sn)
  geçerli, `OTP_MAX_ATTEMPTS` (örnek: 5) deneme. Telefon başına tek açık
  challenge (öncekiler invalidate edilir).
- **Dev-only OTP inbox:** `GET /dev/sms/:phone/last-otp` (`@Public`) →
  `{ phoneNumber, code, createdAt }`. YALNIZ `NODE_ENV=development` **ve**
  `DEV_SMS_INBOX_ENABLED=true` iken route mount edilir; aksi halde route yok
  (404). `src/modules/dev-tools/dev-sms-inbox.controller.ts`,
  `src/app.module.ts:78`. Production'da asla açılmaz.
- **OTP verify:** `POST /auth/otp/verify` (`@Public`), body
  `{ phoneNumber, code, deviceId? }` (`code` tam 6 rakam). Başarı: **200**
  ```json
  { "accessToken": "...", "refreshToken": "...", "expiresIn": 900,
    "user": { "id": "...", "role": "RESIDENT", "fullName": "Ad Soyad" } }
  ```
  (`expiresIn` = access token saniyesi). Hatalı kod / uygun olmayan kullanıcı /
  süresi dolmuş challenge → **401 `AUTH_INVALID_OTP`** (tek generic hata).
  IP başına 20/600 sn verify limiti → **429 `AUTH_RATE_LIMITED`**.
  Tüm login yan etkileri tek transaction'dadır (`auth.service.ts:96-174`).
- **Login uygunluğu:** OPERATIONS/TECHNICIAN → aktif hesap yeterli;
  RESIDENT/SITE_MANAGER → aktif hesap + en az bir aktif site üyeliği.
  Contract durumu login'e etki etmez (`otp.service.ts:113-120`,
  `auth.service.ts:140-148`).
- **Access token:** JWT HS256, payload `{ sub, role, sessionId, tokenVersion }`
  (`token.service.ts:55-63`). TTL `JWT_ACCESS_EXPIRES_IN` (örnek env: 900 sn).
  Her istekte `Authorization: Bearer <token>` header'ı; guard **her istekte
  DB'den kullanıcıyı okuyup `tokenVersion` eşitliğini doğrular** — telefon
  değişimi veya global pasifleştirme sonrası eski access token'lar anında 401
  olur (`jwt-auth.guard.ts:65-69`). Secret rotasyonu: virgülle ayrılmış çoklu
  secret, doğrulamada sırayla denenir.
- **Refresh token:** 48 bayt `base64url` opak string; DB'de yalnız hash
  saklanır. TTL `REFRESH_TOKEN_EXPIRES_IN` (örnek env: 2 592 000 sn = 30 gün).
- **Refresh rotation:** `POST /auth/token/refresh` (`@Public`), body
  `{ refreshToken }` → **200 `{ accessToken, refreshToken, expiresIn }`**
  (**`user` nesnesi YOK** — verify yanıtından farklıdır,
  `token.service.ts:176`). Eski session `markRotated` ile kapatılır, yeni
  session yaratılır. Her refresh token **tek kullanımlıktır**.
- **Reuse detection:** revoke edilmiş/rotate edilmiş token yeniden sunulursa
  kullanıcının **tüm aktif refresh session'ları revoke edilir**, audit yazılır,
  istemciye **401 `AUTH_INVALID_REFRESH`** döner (`token.service.ts:105-114`).
  Sonuç: kullanıcı her cihazda yeniden login olmak zorunda kalır.
- **Eşzamanlı refresh:** aynı token'la paralel iki refresh'te ikincisi reuse
  detection'a düşer ve tüm oturumları öldürür. **Frontend refresh çağrılarını
  serileştirmeli** (tek uçuşta tek refresh).
- **Logout:** `POST /auth/logout` — **auth GEREKTİRİR** (Bearer) **ve** body'de
  `{ refreshToken }` ister → **204**. Yalnız o session revoke edilir.
- **`GET /auth/me`:** →
  `{ id, role, fullName, memberships: [{ siteId, membershipRole }] }`
  (`auth.service.ts:207-229`; `ActiveMembership` —
  `site-membership.repository.ts:15-18`). **Unit/daire bilgisi İÇERMEZ.**
- **Cookie:** **KULLANILMAZ.** Token'lar yalnız JSON body'de taşınır; `Set-Cookie`
  üreten hiçbir kod yoktur. CORS `credentials: true` açık olsa da mevcut auth
  akışı cookie'ye bağlı değildir.
- **Beklenen hata kodları:** 401 `UNAUTHORIZED` (eksik/geçersiz Bearer), 401
  `AUTH_INVALID_OTP`, 401 `AUTH_INVALID_REFRESH`, 429 `AUTH_RATE_LIMITED`,
  422 `VALIDATION_ERROR`.
- **Test kanıtı:** `test/e2e/auth.e2e-spec.ts:53` — "otp request → yanlış kod →
  doğru kod → me → refresh → reuse → logout" tam akışı.

---

## 5. Endpoint kataloğu

Tüm route'lar `/api/v1` prefix'lidir. "Zarf" = başarıda çıplak JSON (Bölüm 2).
Aksi yazılmadıkça durum: **UYGULANMIŞ**.

### Health (`src/modules/health/health.controller.ts`)

| Method + Route | Auth | Yanıt |
|---|---|---|
| GET `/health/liveness` | Public | 200 `{ status: "ok" }` |
| GET `/health/readiness` | Public | 200 `{ status: "ok", database: "ok" }`; DB yoksa 503 |

### Auth (`src/modules/auth/auth.controller.ts`)

| Method + Route | Auth | Request | Yanıt | Hatalar |
|---|---|---|---|---|
| POST `/auth/otp/request` | Public | `RequestOtpDto { phoneNumber }` | 200 `{ message }` (her koşulda) | 422 |
| POST `/auth/otp/verify` | Public | `VerifyOtpDto { phoneNumber, code, deviceId? }` | 200 `{ accessToken, refreshToken, expiresIn, user{id,role,fullName} }` | 401 `AUTH_INVALID_OTP`, 429 `AUTH_RATE_LIMITED`, 422 |
| POST `/auth/token/refresh` | Public | `RefreshTokenDto { refreshToken }` | 200 `{ accessToken, refreshToken, expiresIn }` | 401 `AUTH_INVALID_REFRESH` |
| POST `/auth/logout` | Bearer | `RefreshTokenDto` | 204 (gövdesiz) | 401 |
| GET `/auth/me` | Bearer (tüm roller) | — | 200 `{ id, role, fullName, memberships[] }` | 401 |

### Dev tools (yalnız development, çift koşullu mount)

| Method + Route | Auth | Yanıt |
|---|---|---|
| GET `/dev/sms/:phone/last-otp` | Public | 200 `{ phoneNumber, code, createdAt }`; kayıt yoksa 404 |

### Facilities (`src/modules/facilities/facilities.controller.ts`)

| Method + Route | Roller | Request | Yanıt (201/200) | Hatalar |
|---|---|---|---|---|
| POST `/facilities/sites` | OPERATIONS | `CreateSiteDto { name, code }` | Ham `FacilityRow` (id, type, name, code, parentId, siteId, isActive, createdAt, updatedAt, deletedAt) | 409 `FACILITY_CODE_CONFLICT` |
| POST `/facilities/sites/:siteId/blocks` | OPERATIONS | `CreateBlockDto { name, code }` | `FacilityRow` | 404 `SITE_NOT_FOUND`/`FACILITY_NOT_FOUND`, 409, 422 `FACILITY_INVALID_PARENT` |
| POST `/facilities/blocks/:blockId/units` | OPERATIONS | `CreateUnitDto { code, name? }` | `FacilityRow` | aynı |
| POST `/facilities/:parentId/common-areas` | OPERATIONS | `CreateCommonAreaDto { name, code }` | `FacilityRow` | aynı |
| GET `/facilities/sites/:siteId/tree` | SITE_MANAGER (SiteScopeGuard), OPERATIONS | — | `FacilityTreeNode` (FacilityRow + `children[]` iç içe) | 404 `SITE_NOT_FOUND` |

Kaynak: `FacilityService`, `FacilityValidatorService`, `FacilityRepository`.
**Dikkat:** response mapper yok — ham satır döner (`deletedAt` dahil).

### Users (`src/modules/users/users.controller.ts`)

| Method + Route | Roller | Request | Yanıt | Hatalar |
|---|---|---|---|---|
| GET `/users/technicians` | Yalnız OPERATIONS | — (parametre yok) | 200 `[{ id, firstName, lastName }]` — **`phoneNumber` bilinçli olarak dönmez**; pagination yok (sıralama lastName/firstName/id asc, repository'de 500 üst sınırı) | 401, 403 |
| GET `/users/me/units` | Yalnız RESIDENT | — (kimlik token'dan) | 200 `[{ id, unitId, isPrimary, startsAt, unit: { id, name, code, siteId } }]` — yalnız çağıranın aktif kayıtları; kayıt yoksa `[]` (404 değil); pagination yok | 401, 403 |
| POST `/sites/:siteId/residents` | SM+OP (SiteScopeGuard) | `CreateResidentDto { phoneNumber, firstName, lastName, unitId, isPrimary? }` | 201 ham `UserRow` | 404 `UNIT_NOT_FOUND`/`SITE_NOT_FOUND`, 409 `USER_PHONE_ALREADY_EXISTS`, 409 `RESIDENT_UNIT_ASSIGNMENT_CONFLICT` |
| GET `/sites/:siteId/users` | SM+OP (SiteScopeGuard) | Query: `cursor?, limit?` (1-100, default 20) | 200 `{ items: UserRow[], nextCursor }` | 404 `SITE_NOT_FOUND`, 422 geçersiz cursor |
| PATCH `/users/:id` | SM+OP | `UpdateUserDto { firstName?, lastName?, phoneNumber? }` — OP telefon değiştiremez (403) | 200 ham `UserRow` | 404 `USER_NOT_FOUND`, 409 `USER_PHONE_ALREADY_EXISTS`, 403 |
| POST `/sites/:siteId/users/:userId/deactivate` | SM+OP (SiteScopeGuard) | `{ reason }` | 204 | 404 `USER_NOT_FOUND` |
| POST `/users/:id/deactivate` | Yalnız OPERATIONS | `{ reason }` | 204 | 404 `USER_NOT_FOUND` |
| POST `/sites/:siteId/units/:unitId/assignments/:assignmentId/deactivate` | SM+OP (SiteScopeGuard) | — | 204 | 404 `RESIDENT_UNIT_ASSIGNMENT_NOT_FOUND` |

Kaynak: `UsersService`, `UserAccessPolicy`, `UserRepository`; yeni keşif
uçları için `toTechnicianSummaryResponse` (`mappers/technician-summary.mapper.ts`)
ve `toMyUnitResponse` (`mappers/my-unit.mapper.ts`) açık alan listeli
mapper'lardır.
**Dikkat (KISMİ):** onboarding/PATCH/listBySite uçlarında response mapper yok —
`UserRow` **`phoneNumber`, `tokenVersion`, `isActive`, `deletedAt` alanlarını
da içerir** (`user.repository.ts:11-22`). Bkz. Bölüm 16. Yeni iki GET ucu bu
soruna DAHİL DEĞİLDİR (mapper'lıdır).

### Tickets (`src/modules/tickets/tickets.controller.ts`)

Response modeli `TicketRow` (`ticket.repository.ts:12-34`): `id, code,
createdByUserId, siteId, facilityId, title, description, category, urgency,
status, source, slaTargetAt, isRecurring, operationNote*, completedAt,
cancelledAt, cancellationReason, version, createdAt, updatedAt, deletedAt`.
(*`operationNote` yalnız OPERATIONS'a döner — `ticket.mapper.ts`.)

| Method + Route | Roller | Request | Yanıt | Hatalar |
|---|---|---|---|---|
| POST `/tickets` | RESIDENT, SM, OP | `CreateTicketDto { facilityId, title(5-150), description(10-4000), category, urgency? }` | 201 TicketRow (status `OPEN`, `code` `TKT-YYYY-NNNNNN`) | 404 `FACILITY_NOT_FOUND`, 409 `TICKET_SITE_CONTRACT_INACTIVE`, 403 (teknisyen) |
| GET `/tickets` | RESIDENT, SM, OP (**TECHNICIAN → 403**) | Query: `cursor?, limit?(1-100, default 20), siteId?, status?, urgency?` — SM için `siteId` **zorunlu** (yoksa 422) | 200 `{ items, nextCursor }` | 404 `SITE_NOT_FOUND`, 422 |
| GET `/tickets/:id` | 4 rol | — | 200 TicketRow | 404 `TICKET_NOT_FOUND` (uniform) |
| PATCH `/tickets/:id` | RESIDENT, SM, OP | `UpdateTicketDto { title?, description?, category?, urgency?, operationNote?, version! }` — optimistic lock | 200 TicketRow | 409 `CONCURRENT_MODIFICATION`, 422 `TICKET_UPDATE_EMPTY`, 403 `TICKET_UPDATE_FORBIDDEN`/`FORBIDDEN`, 404 |
| POST `/tickets/:id/status` | Yalnız OPERATIONS | `ChangeTicketStatusDto { toStatus: 'TRIAGED'\|'CLOSED', reason? }` — DTO başka değer kabul etmez | 200 TicketRow | 409 `TICKET_STATUS_UNCHANGED`/`TICKET_INVALID_STATUS_TRANSITION`, 403 `TICKET_TRANSITION_FORBIDDEN`, 422 `TICKET_TRANSITION_REASON_REQUIRED`, 404 |
| POST `/tickets/:id/cancel` | RESIDENT, SM, OP | `CancelTicketDto { reason! }` | 200 TicketRow | aynı state machine hataları, 404 |
| GET `/tickets/:id/history` | 4 rol | — | 200 `TicketStatusHistoryRow[]` (id, ticketId, previousStatus, newStatus, changedByUserId, reason, metadata, createdAt) — **pagination YOK**, `createdAt asc` | 404 |

Kaynak: `TicketService`, `TicketAuthorizationPolicy`, `TicketStateMachine`,
`TicketDirectTransitionPolicy`, `TicketTransitionService`, `toTicketResponse`.

### Assignments + Materials (`src/modules/assignments/assignments.controller.ts`)

Response modeli `toAssignmentResponse` (`assignment.mapper.ts`): `id, ticketId,
technicianId, assignedByUserId, assignmentStatus, assignedAt, acceptedAt,
rejectedAt, rejectionReason, enRouteAt, arrivedAt, startedAt, completedAt,
resolutionNote, isCurrent, createdAt, updatedAt`.

| Method + Route | Roller | Request | Yanıt | Hatalar |
|---|---|---|---|---|
| POST `/tickets/:ticketId/assignments` | OPERATIONS | `CreateAssignmentDto { technicianId }` | 201 Assignment (`PENDING`) | 404 `TICKET_NOT_FOUND`, 409 `TICKET_INVALID_STATUS_TRANSITION`, 422 `ASSIGNMENT_TECHNICIAN_INVALID` |
| GET `/tickets/:ticketId/assignments/current` | Yalnız OPERATIONS | — | 200 Assignment (mevcut `toAssignmentResponse` sözleşmesi birebir; `isCurrent=true` satır) | 404 `TICKET_NOT_FOUND` (ticket yok), 404 `ASSIGNMENT_NOT_FOUND` (current atama yok — OPEN/TRIAGED/terminal durumlar ve COMPLETE sonrası normal akış), 401, 403 |
| POST `/assignments/:id/accept` | TECHNICIAN | — | 200 Assignment (`ACCEPTED`; ticket → `ACCEPTED`) | 404 `ASSIGNMENT_NOT_FOUND`, 409 `ASSIGNMENT_STATUS_CONFLICT` |
| POST `/assignments/:id/reject` | TECHNICIAN | `{ reason! }` | 200 Assignment (`REJECTED`; ticket → `REJECTED`) | aynı |
| POST `/assignments/:id/status` | TECHNICIAN, OP | `{ event: EN_ROUTE\|ARRIVED\|START\|WAIT_MATERIAL\|RESUME\|COMPLETE, note? }` — `note` yalnız `COMPLETE` ile (aksi 422) | 200 Assignment | 404, 409 `ASSIGNMENT_STATUS_CONFLICT`, 403 `TICKET_TRANSITION_FORBIDDEN` (rol/event uyuşmazlığı), 409 ticket state hataları |
| POST `/assignments/:id/cancel` | OPERATIONS | `{ reason! }` | 200 Assignment (`CANCELLED`; ticket → `CANCELLED`) | 404, 409 |
| GET `/assignments/my` | TECHNICIAN | Query: `cursor?, limit?(default 20), status?` | 200 `{ items, nextCursor }` — her item Assignment + `ticket: { id, code, status }` (PII yok) | 422 geçersiz cursor |
| POST `/assignments/:id/materials` | TECHNICIAN, OP | `AddMaterialDto { materialId, quantity: "1.5", unitPrice: "12.50", suppliedBy, note? }` | 201 `{ id, assignmentId, material{id,name,code,unit}, quantity, unitPrice, totalPrice, suppliedBy, note, createdByUserId, createdAt }` | 404 `MATERIAL_NOT_FOUND`/`ASSIGNMENT_NOT_FOUND`, 409 `ASSIGNMENT_MATERIAL_NOT_ALLOWED`, **409 `MATERIAL_INACTIVE`** (`material-lookup.service.ts` — doğrulandı) |
| GET `/assignments/:id/materials` | TECHNICIAN, SM, OP | — | 200 dizi (pagination yok) | 404 |

Kaynak: `TicketAssignmentWorkflowService`, `AssignmentService`,
`AssignmentAuthorizationPolicy`, `assignment-status-event.map.ts`;
current ucu için `AssignmentService.getCurrentForTicket` +
`AssignmentRepository.findCurrentByTicketId` + `TicketReadAccessService`.

### Materials (`src/modules/materials/materials.controller.ts`)

| Method + Route | Roller | Request | Yanıt | Hatalar |
|---|---|---|---|---|
| GET `/materials` | TECHNICIAN, OPERATIONS | Query: `cursor?, limit?(1-100, default 20)` — başka filtre yok | 200 `{ items: [{ id, name, code, unit, description, createdAt }], nextCursor }` — yalnız aktif+silinmemiş katalog; `isActive/updatedAt/deletedAt` dönmez; sıralama `createdAt DESC, id DESC` | 401, 403 (RESIDENT/SM), 422 `VALIDATION_ERROR` (geçersiz cursor/limit) |

Kaynak: `MaterialLookupService.listActiveCatalog`,
`MaterialRepository.listActive`, `toMaterialResponse`
(`mappers/material.mapper.ts`). Tenant kapsamı yok — Material site'a bağlı
olmayan şirket kataloğudur.

### Attachments (`src/modules/attachments/controllers/`)

| Method + Route | Roller | Request | Yanıt | Hatalar |
|---|---|---|---|---|
| POST `/tickets/:ticketId/attachments` | 4 rol | multipart: `file` (tek dosya) + `attachmentType` + `assignmentId?` | 201 `{ id, ticketId, assignmentId, attachmentType, originalFileName, mimeType, fileSize, uploadedByUserId, createdAt }` | Bölüm 11'e bakın |
| GET `/tickets/:ticketId/attachments` | 4 rol | Query: `cursor?, limit?(default 20)` | 200 `{ items, nextCursor }` | 404 `TICKET_NOT_FOUND` |
| GET `/attachments/:id/download` | 4 rol | — | 200 **binary stream**; header'lar: `Content-Type`, `Content-Length`, `Content-Disposition: attachment; filename=...; filename*=UTF-8''...`, `X-Content-Type-Options: nosniff` | 404 `ATTACHMENT_NOT_FOUND` (uniform), 500 `ATTACHMENT_STORAGE_FAILED` |

Kaynak: `AttachmentService`, `AttachmentAuthorizationPolicy`,
`LocalStorageProvider`, `toAttachmentResponse`.

### Contracts (`src/modules/contracts/contracts.controller.ts`)

Response `ContractResponse` (`contract.mapper.ts`): `id, siteId,
contractNumber, startDate("YYYY-MM-DD"), endDate("YYYY-MM-DD"),
monthlyFee("1000.00"), currency, billingDay, status, serviceScope,
standardResponseTargetHours, emergencyCoverage, notes, createdByUserId,
createdAt, updatedAt, terminatedAt, terminationReason`.

| Method + Route | Roller | Request | Yanıt | Hatalar |
|---|---|---|---|---|
| POST `/contracts` | OPERATIONS | `CreateContractDto { siteId, startDate, endDate, monthlyFee, billingDay(1-28), currency?, serviceScope?, standardResponseTargetHours?, emergencyCoverage?, notes? }` — status/contractNumber gönderilemez | 201 (status her zaman `DRAFT`) | 422 `VALIDATION_ERROR`/`CONTRACT_INVALID_DATE_RANGE`*, 409 `CONTRACT_OVERLAP`, 404 `SITE_NOT_FOUND` |
| PATCH `/contracts/:id` | OPERATIONS | `UpdateContractDto { endDate?, monthlyFee?, billingDay?, currency?, serviceScope?, standardResponseTargetHours?, emergencyCoverage?, notes?, status?, terminationReason? }` — siteId/startDate/contractNumber immutable | 200 | 404 `CONTRACT_NOT_FOUND`, 409 `CONTRACT_STATUS_UNCHANGED`/`CONTRACT_INVALID_STATUS_TRANSITION`/`CONTRACT_OVERLAP`/`CONTRACT_TERMINATION_INVOICE_CONFLICT`, 422 `CONTRACT_UPDATE_EMPTY`/`CONTRACT_IMMUTABLE_FIELD`*/`CONTRACT_TERMINATION_DETAILS_REQUIRED` |
| GET `/sites/:siteId/contracts` | SM (SiteScopeGuard) + OP | Query: `cursor?, limit?, status?` | 200 `{ items, nextCursor }` | 404 `SITE_NOT_FOUND` |

*Tam HTTP status eşlemeleri (409 vs 422) için `contract.service.ts` içindeki
her `DomainError` satırı bağlayıcıdır; tabloda kod adları kesindir, tek tek
status'lar için bkz. dosya.

### Billing (`src/modules/billing/invoices.controller.ts`)

Response `InvoiceResponse` (`invoice.mapper.ts`): `id, contractId,
invoiceNumber, billingPeriodStart/End("YYYY-MM-DD"), issueDate, dueDate,
amount("1000.00"), currency, status, paidAt, paymentMethod, referenceNumber,
note, createdAt, updatedAt`.

| Method + Route | Roller | Request | Yanıt | Hatalar |
|---|---|---|---|---|
| POST `/contracts/:id/invoices` | OPERATIONS | `CreateInvoiceDto { billingPeriodStart, billingPeriodEnd, issueDate, dueDate, amount, note? }` — currency/invoiceNumber/status gönderilemez (currency sözleşmeden kopyalanır) | 201 (status `DRAFT`) | 404 `CONTRACT_NOT_FOUND`, 409/422: `INVOICE_CONTRACT_NOT_BILLABLE`, `INVOICE_INVALID_PERIOD`, `INVOICE_INVALID_DUE_DATE`, `INVOICE_PERIOD_OUT_OF_CONTRACT`, `INVOICE_PERIOD_OVERLAP`, `INVOICE_CURRENCY_MISMATCH` |
| PATCH `/invoices/:id/status` | OPERATIONS | `ChangeInvoiceStatusDto { status, paymentMethod?, referenceNumber? }` — `paidAt` client'tan ALINMAZ | 200 | 404 `INVOICE_NOT_FOUND`, 409 `INVOICE_STATUS_UNCHANGED`/`INVOICE_INVALID_STATUS_TRANSITION`, 422 `INVOICE_PAYMENT_DETAILS_REQUIRED`/`VALIDATION_ERROR` |
| GET `/sites/:siteId/invoices` | SM (SiteScopeGuard) + OP | Query: `cursor?, limit?, status?, contractId?` | 200 `{ items, nextCursor }` | 404 `SITE_NOT_FOUND` |

### Var olmayan (UYGULANMAMIŞ) uçlar — frontend'in bilmesi gerekenler

- Genel kullanıcı arama/listeleme (`GET /users`) — YOK. (Teknisyen keşfi için
  dar `GET /users/technicians` ucu VAR — yukarıdaki Users tablosu.)
- Material CRUD (create/update/deactivate) — YOK; yalnız salt-okunur
  `GET /materials` kataloğu VAR.
- Ticket'ın assignment GEÇMİŞİNİ listeleyen uç
  (`GET /tickets/:id/assignments` tam listesi) — YOK; yalnız
  `GET /tickets/:id/assignments/current` VAR (OPERATIONS).
- Tekil contract/invoice detay ucu (`GET /contracts/:id`, `GET /invoices/:id`) — YOK.
- Notification endpoint'i — YOK (Bölüm 12).
- `GET /attachments/:id/url` (signed URL) — YOK; yerine `/download` var.
- RESIDENT/SITE_MANAGER için current-assignment görünürlüğü — YOK (bilinçli;
  yeni PII/ürün kararı gerektirir — `docs/frontend-enablement-plan.md` Bölüm 13).

---

## 6. Cursor pagination

Kaynak: `src/common/utils/pagination.util.ts`; kullanan servisler: tickets,
attachments, assignments/my, site users, contracts, invoices.

- **Request:** `?cursor=<opak string>&limit=<1-100>`. `cursor` opak
  base64url'dür (`createdAt ISO|id` çifti) — **frontend içeriğini parse
  etmemeli**.
- **Response:** `{ items: T[], nextCursor: string | null }`.
- **Limit:** default 20 (`DEFAULT_PAGE_LIMIT`, her serviste), max 100 (DTO
  `@Max(100)`).
- **Sıralama:** `createdAt DESC, id DESC` (en yeni önce) — ör.
  `ticket.repository.ts:256`, `assignment.repository.ts:239`.
- **Next cursor:** sayfanın son öğesinin `(createdAt, id)` değerinden üretilir;
  repository `limit+1` kayıt çeker, fazlası varsa `nextCursor` dolu döner
  (`buildPage`).
- **Son sayfa:** `nextCursor: null`.
- **Geçersiz cursor:** decode edilemezse **422 `VALIDATION_ERROR`**
  ("Gecersiz cursor.").
- **Filtre değişimi:** cursor yalnız `(createdAt,id)` konumu taşır; filtreler
  cursor'a gömülmez. Filtre değiştirilirse eski cursor teknik olarak çalışır
  ama anlamlı sayfa bütünlüğü garanti edilmez — filtre değişince cursor'ı
  sıfırlamak frontend sorumluluğudur (kodda buna engel/kontrol yok).

---

## 7. Ticket state machine

Kaynak: `src/modules/tickets/state/ticket-state-machine.ts` (tam tablo) +
`ticket-direct-transition.policy.ts` (genel uçtan izinli alt küme).

**Status değerleri** (`TicketStatus`): `OPEN, TRIAGED, ASSIGNED, ACCEPTED,
REJECTED, EN_ROUTE, ARRIVED, IN_PROGRESS, WAITING_MATERIAL, COMPLETED, CLOSED,
CANCELLED`.

**Tam geçiş tablosu (rol + reason şartı):**

| From | To | Roller | Reason |
|---|---|---|---|
| OPEN | TRIAGED | OPERATIONS | — |
| OPEN | CANCELLED | RESIDENT, SITE_MANAGER, OPERATIONS | zorunlu |
| TRIAGED | ASSIGNED | OPERATIONS | — |
| TRIAGED | CANCELLED | SITE_MANAGER, OPERATIONS | zorunlu |
| ASSIGNED | ACCEPTED | TECHNICIAN | — |
| ASSIGNED | REJECTED | TECHNICIAN | zorunlu |
| ASSIGNED | CANCELLED | OPERATIONS | zorunlu |
| REJECTED | ASSIGNED | OPERATIONS | — |
| ACCEPTED | EN_ROUTE | TECHNICIAN | — |
| EN_ROUTE | ARRIVED | TECHNICIAN | — |
| ARRIVED | IN_PROGRESS | TECHNICIAN | — |
| IN_PROGRESS | WAITING_MATERIAL | TECHNICIAN, OPERATIONS | — |
| IN_PROGRESS | COMPLETED | TECHNICIAN | — |
| WAITING_MATERIAL | IN_PROGRESS | TECHNICIAN, OPERATIONS | — |
| COMPLETED | CLOSED | OPERATIONS | — |
| COMPLETED | IN_PROGRESS (reopen) | OPERATIONS, zorunlu reason | **tabloda var ama genel uçtan ERİŞİLEMEZ; workflow'da da yolu yok → fiilen UYGULANMAMIŞ** |

**Kritik ayrım:** `POST /tickets/:id/status` ve `POST /tickets/:id/cancel`
yalnız şu geçişleri çalıştırabilir (`TicketDirectTransitionPolicy`):
`OPEN→TRIAGED`, `OPEN→CANCELLED`, `TRIAGED→CANCELLED`, `COMPLETED→CLOSED`.
Assignment akışına ait tüm geçişler (ASSIGNED, ACCEPTED, EN_ROUTE ... COMPLETED)
yalnız assignment uçlarından (`TicketAssignmentWorkflowService`) yapılır;
genel uçtan denenirse **409 `TICKET_INVALID_STATUS_TRANSITION`**.

- **Aynı duruma geçiş:** her zaman **409 `TICKET_STATUS_UNCHANGED`**; ticket
  güncellenmez, history yazılmaz (`ticket-state-machine.ts:51-57`; sıra
  garantisi `ticket.service.ts:373-387`).
- **Terminal durumlar:** `CLOSED`, `CANCELLED` (çıkış geçişi yok).
- **History:** her gerçek geçişte `TicketStatusHistory` satırı (create'te
  `null→OPEN` dahil); `GET /tickets/:id/history` `createdAt asc` döner.
- **Hata kodları:** 409 `TICKET_STATUS_UNCHANGED`,
  409 `TICKET_INVALID_STATUS_TRANSITION`, 403 `TICKET_TRANSITION_FORBIDDEN`,
  422 `TICKET_TRANSITION_REASON_REQUIRED`, 409 `CONCURRENT_MODIFICATION`
  (PATCH version uyuşmazlığı).

---

## 8. Assignment state machine

Kaynak: `src/modules/assignments/state/assignment-status-event.map.ts`,
`services/ticket-assignment-workflow.service.ts`.

**AssignmentStatus:** `PENDING, ACCEPTED, REJECTED, ACTIVE, COMPLETED,
CANCELLED, REASSIGNED` (terminal: REJECTED, CANCELLED, REASSIGNED, COMPLETED).

**Event → durum eşlemesi** (`POST /assignments/:id/status`):

| Event | Assignment from→to | Ticket to | Zaman damgası |
|---|---|---|---|
| (accept ucu) | PENDING → ACCEPTED | ACCEPTED | acceptedAt |
| (reject ucu) | PENDING → REJECTED | REJECTED | rejectedAt + rejectionReason |
| EN_ROUTE | ACCEPTED → ACTIVE | EN_ROUTE | enRouteAt |
| ARRIVED | ACTIVE → ACTIVE | ARRIVED | arrivedAt |
| START | ACTIVE → ACTIVE | IN_PROGRESS | startedAt |
| WAIT_MATERIAL | ACTIVE → ACTIVE | WAITING_MATERIAL | — |
| RESUME | ACTIVE → ACTIVE | IN_PROGRESS | — |
| COMPLETE | ACTIVE → COMPLETED (`isCurrent=false`) | COMPLETED | completedAt (+ `note` → resolutionNote) |

- **Rol kısıtı event'lerde tekrarlanmaz** — ticket state machine'in rol
  tablosundan gelir: `EN_ROUTE/ARRIVED/START/COMPLETE` fiilen yalnız
  TECHNICIAN; `WAIT_MATERIAL/RESUME` TECHNICIAN + OPERATIONS. TECHNICIAN
  yalnız kendi assignment'ında işlem yapabilir (aksi 404).
- **Senkronizasyon:** her yazma tek transaction'dadır; kilit sırası her zaman
  önce ticket (`FOR UPDATE`), sonra assignment. Ticket geçişi
  `TICKET_TRANSITION_PORT` üzerinden `TicketTransitionService` ile yapılır;
  history/audit/outbox aynı transaction'da yazılır.
- **Reassignment:** ticket `TRIAGED`/`REJECTED`/`ASSIGNED` iken
  `POST /tickets/:ticketId/assignments`. Ticket `ASSIGNED` iken: eski atama
  `REASSIGNED` + `isCurrent=false`, yenisi `PENDING`; ticket durumu değişmez,
  ikinci bir `ASSIGNED→ASSIGNED` history satırı YAZILMAZ
  (`workflow.assignTechnician:72-97`). Ticket `REJECTED` iken eski atamanın
  status'u korunur, yalnız `isCurrent` kapatılır.
- **Workflow service sorumluluğu:** ticket+assignment'ı birlikte değiştiren TÜM
  yazma yolları (atama, accept, reject, status event, cancel, malzeme ekleme)
  `TicketAssignmentWorkflowService`'tedir; başka servis bu iki modeli birlikte
  güncellemez.
- **Hata kodları:** 404 `ASSIGNMENT_NOT_FOUND` (yok/sahiplik dışı),
  409 `ASSIGNMENT_STATUS_CONFLICT` (yanlış durumdan event),
  422 `ASSIGNMENT_TECHNICIAN_INVALID`, 409 `TICKET_INVALID_STATUS_TRANSITION`
  (atanamaz ticket durumu), 409 `ASSIGNMENT_MATERIAL_NOT_ALLOWED`,
  422 `VALIDATION_ERROR` (`note` COMPLETE dışı event'le).
  (`ASSIGNMENT_CONCURRENT_CONFLICT` sabiti tanımlı; fırlatan yer bu incelemede
  görülmedi → `BELİRSİZ`.)

---

## 9. Contract state machine

Kaynak: `src/modules/contracts/state/contract-state-machine.ts`,
`services/contract.service.ts`.

- **Durumlar:** `DRAFT, ACTIVE, SUSPENDED, EXPIRED, TERMINATED`.
- **Geçişler:** DRAFT→{ACTIVE, TERMINATED}; ACTIVE→{SUSPENDED, EXPIRED,
  TERMINATED}; SUSPENDED→{ACTIVE, EXPIRED, TERMINATED}; EXPIRED ve TERMINATED
  terminaldir. Aynı duruma geçiş → 409 `CONTRACT_STATUS_UNCHANGED`.
- **Guard'lar:** ACTIVE hedefi yalnız `endDate >= bugün` (UTC) ise; EXPIRED
  hedefi yalnız `endDate < bugün` ise (endDate günü boyunca sözleşme
  geçerlidir — "katı EXPIRED sınırı"). `ContractExpiringScanJob` ve
  `InvoiceOverdueScanJob` cron `0 2 * * *` UTC'de sistem geçişleri üretir.
- **Roller:** tüm yazma uçları yalnız OPERATIONS (`@Roles`); state machine rol
  parametresi almaz.
- **Tarih/overlap kuralları:** `endDate > startDate` (aksi
  `CONTRACT_INVALID_DATE_RANGE`); aynı sitede ACTIVE dönem çakışması hem ön
  kontrol hem DB exclusion constraint ile `CONTRACT_OVERLAP`;
  `siteId/startDate/contractNumber` immutable; `endDate` EXPIRED/TERMINATED'ta
  değiştirilemez, ACTIVE/SUSPENDED'ta geriye çekilemez
  (`CONTRACT_IMMUTABLE_FIELD`); DRAFT-only alanlar (`monthlyFee, billingDay,
  currency`) yalnız DRAFT'ta değişir; TERMINATED hedefi `terminationReason`
  zorunlu kılar (`CONTRACT_TERMINATION_DETAILS_REQUIRED`), fesih tarihinden
  sonraki döneme kesilmiş fatura varsa `CONTRACT_TERMINATION_INVOICE_CONFLICT`.
- **Entitlement (overrides §5 birebir kodda):** aktif sözleşme login şartı
  DEĞİLDİR; yalnız **yeni ticket oluşturma** aktif sözleşme ister
  (`ticket.service.create` → `ContractLookupService.findActiveForSite`:
  `status='ACTIVE' AND start_date <= CURRENT_DATE <= end_date`, aksi 409
  `TICKET_SITE_CONTRACT_INACTIVE`). Açık işlerin devamı (accept, status
  event'leri, complete, reassignment, close) sözleşme kontrolü YAPMAZ. SLA
  yalnız ticket oluşturma anındaki sözleşmeden hesaplanır
  (`sla.util.ts` — `computeSlaTargetAt`).
- **Geçmiş kayıtlar:** `GET /sites/:siteId/contracts` durum filtresiz tüm
  sözleşmeleri (EXPIRED/TERMINATED dahil) listeler; SM salt-okuma erişimini
  korur.

---

## 10. Invoice state machine

Kaynak: `src/modules/billing/state/invoice-state-machine.ts`,
`services/invoice.service.ts`.

- **Durumlar:** `DRAFT, ISSUED, PAID, OVERDUE, CANCELLED`.
- **Geçişler (API):** DRAFT→{ISSUED, CANCELLED}; ISSUED→{PAID, CANCELLED};
  OVERDUE→{PAID, CANCELLED}; PAID ve CANCELLED terminal. **OVERDUE hedefine
  API'den geçiş her koşulda 409** — OVERDUE'yu yalnız sistem job'ı üretir
  (`assertSystemOverdueTransition`, `InvoiceOverdueScanJob`). Aynı durum →
  409 `INVOICE_STATUS_UNCHANGED`.
- **Ödeme alanları:** hedef `PAID` iken `paymentMethod` zorunlu
  (`INVOICE_PAYMENT_DETAILS_REQUIRED`); `paymentMethod=BANK_TRANSFER` iken
  `referenceNumber` zorunlu; hedef PAID değilken `paymentMethod`/
  `referenceNumber` gönderilirse 422 `VALIDATION_ERROR`. **`paidAt` server
  tarafından set edilir, client'tan asla alınmaz** (DTO'da yok;
  `forbidNonWhitelisted` gönderilirse 422 üretir).
- **Dönem kontrolleri (create):** `billingPeriodEnd > billingPeriodStart`
  (`INVOICE_INVALID_PERIOD`); `dueDate >= issueDate`
  (`INVOICE_INVALID_DUE_DATE`); dönem sözleşme aralığı içinde
  (`INVOICE_PERIOD_OUT_OF_CONTRACT`); aynı sözleşmede dönem çakışması yasak
  (`INVOICE_PERIOD_OVERLAP`, uygulama + DB exclusion constraint); DRAFT/
  SUSPENDED sözleşme faturalanamaz (`INVOICE_CONTRACT_NOT_BILLABLE`);
  `currency` sözleşmeden kopyalanır (`INVOICE_CURRENCY_MISMATCH` DB backstop).
- **Yetki:** mutasyonlar yalnız OPERATIONS; listeler SM+OP (SiteScopeGuard,
  site kapsamı `contract.siteId` üzerinden).

---

## 11. Attachment davranışı

Kaynak: `src/modules/attachments/`, `src/common/constants/attachment.constant.ts`,
`src/infrastructure/storage/local-storage.provider.ts`.

- **Upload:** `POST /tickets/:ticketId/attachments` — multipart alanları:
  **`file`** (FileInterceptor alan adı), **`attachmentType`** (zorunlu),
  **`assignmentId`** (opsiyonel UUID). Bilinmeyen ek alan → 422.
- **MIME:** yalnız `image/jpeg`, `image/png`, `image/webp`. Dosyanın **magic
  bytes** imzası okunur ve beyan edilen `Content-Type` ile eşleşmek zorundadır;
  aksi **415 `ATTACHMENT_UNSUPPORTED_TYPE`**
  (`file-signature.util.detectImageMimeType`).
- **Boyut:** 10 MB (`MAX_FILE_SIZE_BYTES`) → aşımı **413
  `ATTACHMENT_TOO_LARGE`**. Boş/eksik dosya → **422
  `ATTACHMENT_FILE_REQUIRED`**.
- **AttachmentType değerleri:** `ISSUE, BEFORE_WORK, AFTER_WORK, MATERIAL,
  DOCUMENT, OTHER` (Prisma enum).
- **Role göre kısıtlar** (`AttachmentAuthorizationPolicy`):
  - RESIDENT/SITE_MANAGER: `assignmentId` GÖNDEREMEZ (403
    `ATTACHMENT_UPLOAD_NOT_ALLOWED`); CLOSED/CANCELLED ticket'a upload 403
    `TICKET_UPDATE_FORBIDDEN`; tip kısıtı yok.
  - TECHNICIAN: `assignmentId` ZORUNLU; kendi, `isCurrent`,
    ACCEPTED/ACTIVE assignment'ı olmalı (aksi 404 `ASSIGNMENT_NOT_FOUND`);
    tip yalnız `BEFORE_WORK`/`AFTER_WORK`/`MATERIAL` (aksi 422
    `ATTACHMENT_TYPE_NOT_ALLOWED`).
  - OPERATIONS: kısıtsız; `assignmentId` verirse varlık + ticket eşleşmesi
    doğrulanır.
- **Assignment-ticket eşleşmesi:** `assignment.ticketId !== ticketId` → **409
  `ATTACHMENT_ASSIGNMENT_MISMATCH`**; ayrıca DB'de composite FK
  (`ticket_attachments(assignment_id, ticket_id) → assignments(id, ticket_id)`,
  `prisma/migrations/20260710000100_custom_constraints`).
- **Listeleme:** `GET /tickets/:ticketId/attachments` — cursor pagination,
  parent ticket okuma yetkisi şart.
- **Download:** `GET /attachments/:id/download` — **signed URL DEĞİL**,
  Bearer token'lı doğrudan streaming. Yetki parent ticket policy'siyle YENİDEN
  doğrulanır. Header'lar: `Content-Type` (kayıtlı MIME), `Content-Length`,
  `Content-Disposition: attachment; filename="ascii"; filename*=UTF-8''enc`
  (RFC 5987), `X-Content-Type-Options: nosniff`.
  **Frontend etkisi:** `<img src>` doğrudan kullanılamaz (Authorization header
  gerekir) — fetch + blob URL gerekir; `Content-Disposition: attachment`
  indirme semantiğidir.
- **Local storage:** dosyalar `STORAGE_LOCAL_PATH` altında hash'lenmiş
  storage key ile saklanır; `storageKey/checksum/storageProvider` response'a
  asla çıkmaz (`toAttachmentResponse` açık alan listesi).
- **Uniform 404:** attachment yok / soft-deleted / parent ticket'a erişim yok
  → hepsi **404 `ATTACHMENT_NOT_FOUND`** (`attachment.service.ts:164-181`;
  E2E kanıt: `attachments.e2e-spec.ts:528`).
- **S3:** **UYGULANMAMIŞ** — `STORAGE_PROVIDER=s3` env doğrulamasında
  fail-fast ile reddedilir (`validation.schema.ts`); tek provider
  `LocalStorageProvider`'dır.

---

## 12. Notification davranışı

- **Frontend'in erişebileceği notification endpoint'i YOKTUR.**
  `NotificationsModule`'da controller yok (`src/modules/notifications/` —
  yalnız relay/dispatcher servisleri).
- Bildirimler tamamen backend içi outbox → delivery pipeline'ıdır:
  `OutboxRelay` (PENDING event'leri SKIP LOCKED ile claim eder) →
  `NotificationDispatcher` (event başına alıcı listesine
  `NotificationDelivery` satırları üretir; işlenen event tipleri:
  `EmergencyTicketCreated`, `TechnicianAssigned`, `ContractExpiring`,
  `InvoiceOverdue`; diğer tüm event tipleri bildirimsiz PROCESSED işaretlenir)
  → `NotificationDeliveryRelay` (SMS gönderimi, at-least-once).
- **SMS/log:** tek gerçek provider `MockSmsProvider` (yalnız maskelenmiş
  numarayla log yazar); development'ta `DevInboxSmsProvider` OTP'yi bellekte
  tutar. `SMS_PROVIDER=external` **UYGULANMAMIŞ** ve env doğrulaması reddeder.
  Yani bugün hiçbir gerçek SMS çıkmaz.
- **Polling/realtime:** WebSocket/SSE/push **UYGULANMAMIŞ**. Frontend güncel
  veri için normal GET uçlarını yeniden sorgulamak zorundadır.
- **Uygulanmamış kanallar:** WhatsApp/e-posta/push kodda hiç yok
  (`docs/architecture.md` Bölüm 17 satır #9 da doğrular).

---

## 13. Tenant izolasyonu ve IDOR

- **`siteId` doğrudan bulunan modeller:** `SiteMembership`, `Facility`
  (SITE-dışı satırlarda dolu), `Ticket`, `Contract`, `AuditLog` (nullable)
  — `prisma/schema.prisma`.
- **Türetilen kapsam:** `ResidentUnitAssignment → unit.siteId`,
  `Assignment → ticket.siteId`, `AssignmentMaterial → assignment.ticket.siteId`,
  `TicketAttachment → ticket.siteId`, `ContractInvoice → contract.siteId`
  (repository sorguları ilişki üzerinden filtreler; ör. invoice listesi
  `contract.siteId` ile).
- **Repository filtreleri:** anonim "tüm kayıtlar" metodu yok;
  `TicketListFilter` scope'suz kurulamayan discriminated union'dır
  (`ticket.repository.ts:83-108`); cross-site sorgular yalnız OPERATIONS
  scope'unda ve açıkça adlandırılmıştır.
- **Guard/policy zinciri:** `JwtAuthGuard` (kimlik + tokenVersion) →
  `RolesGuard` (@Roles) → `SiteScopeGuard` (`:siteId` route'larında üyelik) →
  policy'ler (`TicketAuthorizationPolicy`, `AssignmentAuthorizationPolicy`,
  `AttachmentAuthorizationPolicy`, `UserAccessPolicy`) kaynak bazlı karar verir.
- **OPERATIONS cross-site:** `SiteScopeGuard` ve ticket-okuma policy'si
  OPERATIONS'ı koşulsuz geçirir; listelerde `siteId` filtresi opsiyoneldir
  (verilirse sitenin varlığı doğrulanır — `assertSiteExists`).
- **403 / 404 ayrımı:**
  - **403** yalnız iki durumda: rol uyuşmazlığı (`RolesGuard` → `FORBIDDEN`)
    ve "kaynağı görebilirsin ama bu işlemi yapamazsın" kuralları
    (`TICKET_UPDATE_FORBIDDEN`, `TICKET_TRANSITION_FORBIDDEN`,
    `ATTACHMENT_UPLOAD_NOT_ALLOWED`, operationNote yazımı vb.).
  - **404 (uniform):** kaynağın varlığını sızdıracak her erişim reddi —
    başka sitenin site'ı (`SITE_NOT_FOUND`), başkasının ticket'ı
    (`TICKET_NOT_FOUND`), başka teknisyenin assignment'ı
    (`ASSIGNMENT_NOT_FOUND`), erişilemeyen attachment
    (`ATTACHMENT_NOT_FOUND`), site dışı unit (`UNIT_NOT_FOUND`), resident'ın
    kendisine ait olmayan facility (`FACILITY_NOT_FOUND`).
  - E2E kanıt: `tenant-isolation.e2e-spec.ts`, `tickets.e2e-spec.ts:187`,
    `attachments.e2e-spec.ts:229/250`, `assignments.e2e-spec.ts:271`.
- **Rol bazlı sınır özetleri:** RESIDENT — yalnız kendi ticket'ları + kendi
  unit'i; SITE_MANAGER — yalnız MANAGER üyeliği olduğu siteler; TECHNICIAN —
  yalnız atandığı ticket/assignment'lar; hepsinde ihlal 404'tür.

---

## 14. Frontend'in yeniden uygulamaması gereken backend kuralları

Aşağıdakilerin otoritesi backend'dir; frontend yalnız UX için ön kontrol
yapabilir, sonucu asla varsaymamalıdır:

1. **State transition doğruluğu** — ticket/assignment/contract/invoice geçiş
   tabloları ve rol kısıtları (Bölüm 7-10). Frontend butonları gizleyebilir ama
   409/403'ü her zaman handle etmelidir.
2. **`siteId` türetme** — ticket create'te siteId client'tan alınmaz,
   facility'den türetilir; invoice currency sözleşmeden kopyalanır.
3. **SLA hesabı** — `slaTargetAt` server hesaplar (`computeSlaTargetAt`);
   frontend yalnız gösterir.
4. **Entitlement** — "aktif sözleşme var mı" kontrolü yalnız ticket create'te
   backend'dedir; frontend sözleşme durumuna bakarak login/iş-devamı
   engellememelidir.
5. **Assignment-ticket eşleşmesi** — `ATTACHMENT_ASSIGNMENT_MISMATCH` ve DB
   composite FK backend'dedir.
6. **Decimal aritmetiği** — `totalPrice = quantity × unitPrice` server'da
   Decimal ile hesaplanır (ROUND_HALF_UP, 2 hane); frontend toplama/çarpma
   sonucu göndermez, string alanları olduğu gibi gösterir.
7. **Contract/invoice tarih ve overlap kuralları** — dönem, vade, çakışma,
   immutability kontrolleri backend + DB constraint'lerindedir.
8. **Kaynak sahipliği ve uniform 404** — frontend 404'ü "yok veya erişimin
   yok" olarak yorumlamalı, ayrım yapmaya çalışmamalıdır.
9. **Optimistic locking** — `PATCH /tickets/:id` `version` alanı ister; 409
   `CONCURRENT_MODIFICATION` gelince kaynak yeniden okunup form yenilenmelidir.
10. **OTP/token yaşam döngüsü** — deneme sayacı, cooldown, rotation, reuse
    tespiti tamamen backend'dedir.

---

## 15. Kod-belge çelişkileri

`docs/architecture.md` Bölüm 17 zaten 16 maddelik bağlayıcı bir revizyon
tablosu içerir (Faz 9'da eklenmiş); aşağıdakiler frontend'i etkileyen ve/veya
o tabloda olmayan farklardır.

| Konu | Belgede söylenen | Kodda uygulanan | Geçerli davranış | Frontend etkisi | Kaynak |
|---|---|---|---|---|---|
| Başarı zarfı | arch. Bölüm 11: "Tüm cevaplar `{success, data\|error}` zarfında" | Başarıda zarf yok, çıplak DTO | **Çıplak DTO** | HTTP client'ta `data` unwrap katmanı YAZILMAMALI | `global-exception.filter.ts`; arch. Bölüm 17 #1 |
| Teknisyen ticket listesi | arch. Bölüm 11: `GET /tickets` "4 rol … T atandıkları" | TECHNICIAN → **403 FORBIDDEN** | 403; teknisyen `GET /assignments/my` kullanır | Teknisyen ekranı assignment listesi üzerine kurulmalı | `ticket.service.ts:218-225` |
| Attachment erişimi | arch.: `GET /attachments/:id/url` 5 dk signed URL | Signed URL yok; auth'lu streaming `GET /attachments/:id/download` | download ucu | `<img src>` yerine fetch+blob | `attachment-download.controller.ts`; arch. Bölüm 17 #6 |
| `POST /tickets/:id/status` DTO | arch.: `{ toStatus, reason?, metadata? }`, "role göre" | `toStatus` yalnız `TRIAGED\|CLOSED`; `metadata` alanı yok; yalnız OPERATIONS | Kodun hali | Durum düğmeleri role/duruma göre ayrışmalı; diğer geçişler assignment uçlarından | `change-ticket-status.dto.ts`, `tickets.controller.ts:69` |
| Invoice PAID DTO | arch.: `paidAt` client'tan gelir | `paidAt` DTO'da yok, server set eder; gönderilirse 422 | Kodun hali | Ödeme formunda `paidAt` alanı olmamalı | `change-invoice-status.dto.ts` |
| `POST /users/:id/deactivate` rolleri | arch.: SM + OP, "tüm refresh session revoke" | Global pasifleştirme yalnız OP; SM için ayrı site-scoped uç (`/sites/:siteId/users/:userId/deactivate`, session'lara dokunmaz) | Kodun hali | İki ayrı aksiyon olarak modellenmeli | `users.controller.ts:60-82`, `users.service.ts:224-310` |
| Ortak hata kodları | arch.: `401 AUTH_REQUIRED`, `429 RATE_LIMITED` | Kodlar `UNAUTHORIZED` ve `AUTH_RATE_LIMITED` | Kodun hali | Hata eşleme tablosu Bölüm 2/4'teki kodlarla kurulmalı | `error-codes.constant.ts` |
| Readiness'ta SMS durumu | arch.: SMS provider degraded raporlanır | Yalnız DB kontrolü | Kodun hali | Health ekranında SMS durumu beklenmemeli | `health.controller.ts` |
| Swagger | arch. klasör yapısı "Swagger (prod'da korumalı)" | Swagger hiç yok | UYGULANMAMIŞ | Tip üretimi elle yapılmalı (Bölüm 16) | `main.ts`, `package.json` |
| Reopen (COMPLETED→IN_PROGRESS) | State machine tablosunda OPERATIONS+reason ile tanımlı | `TicketDirectTransitionPolicy` allowlist'inde bilinçli olarak yok; assignment workflow'unda da yolu yok | **Fiilen erişilemez** | "Yeniden aç" UI'ı yapılmamalı | `ticket-direct-transition.policy.ts` (yorum + allowlist), E2E `assignments.e2e-spec.ts:329` |
| SMS/S3 provider'ları | arch. klasör yapısında `s3-storage.provider.ts`, `external-sms.provider.ts` | Dosyalar yok; env doğrulaması `s3`/`external` seçimini reddeder | UYGULANMAMIŞ | — | `validation.schema.ts`, `src/infrastructure/` |

Test-implementasyon çelişkisi: incelenen kapsamli E2E/unit testlerle
implementasyon arasında çelişki **bulunmadı**; state machine testleri
(25 hücre matrisleri) kod tablolarıyla birebir uyumludur.

---

## 16. Eksik veya riskli frontend sözleşmeleri

| # | Konu | Sınıf | Ayrıntı |
|---|---|---|---|
| 1 | Resident'ın kendi unit'ini keşfedeceği uç | **ÇÖZÜLDÜ (2026-07-19)** | `GET /users/me/units` eklendi (`users.controller.ts` — `UsersController.listMyUnits`). E2E kanıt: `test/e2e/discovery.e2e-spec.ts`. |
| 2 | Teknisyen listesi ucu | **ÇÖZÜLDÜ (2026-07-19)** | `GET /users/technicians` eklendi (OPERATIONS-only, telefon dönmez). E2E kanıt: `discovery.e2e-spec.ts`. |
| 3 | Material listesi ucu | **ÇÖZÜLDÜ (2026-07-19)** | `GET /materials` eklendi (TECHNICIAN+OPERATIONS, yalnız aktif katalog, cursor pagination). E2E kanıt: `discovery.e2e-spec.ts`. |
| 4 | Users/Facilities response mapper'ı yok | **ÖNEMLİ** | Onboarding/PATCH/listBySite uçlarında `UserRow` (`tokenVersion`, `phoneNumber`, `deletedAt`) ve facilities uçlarında `FacilityRow` (`deletedAt`) ham döner; ileride alan kırpma yapılırsa frontend tipi kırılır. Yeni keşif uçları mapper'lıdır ve bu soruna dahil değildir. |
| 5 | Ticket'ın mevcut assignment'ını veren uç | **KISMEN ÇÖZÜLDÜ → İYİLEŞTİRME** | `GET /tickets/:ticketId/assignments/current` eklendi (OPERATIONS-only) — reassign/iptal akışı artık keşfedilebilir. Kalan boşluklar: assignment GEÇMİŞİ listesi yok; RESIDENT/SM teknisyen bilgisini göremez (bilinçli PII kararı). |
| 6 | OpenAPI/Swagger yok | **ÖNEMLİ** | Tip güvenli client üretimi yapılamaz; bu belge + DTO dosyaları tek sözleşme kaynağıdır. |
| 7 | Auth: eşzamanlı refresh reuse-detection'ı tetikler | **ÖNEMLİ** | İki paralel refresh tüm oturumları öldürür; frontend refresh'i mutlaka tekilleştirmeli (mutex/queue). |
| 8 | Download'ın Authorization header istemesi | **ÖNEMLİ** | `<img>`/`<a href>` doğrudan kullanılamaz; fetch+blob veya object URL şart. `Content-Disposition: attachment` inline görüntülemeyi de zorlaştırır. |
| 9 | Ticket history'de kullanıcı adı yok | İYİLEŞTİRME | History `changedByUserId` döner; ad göstermek için ek uç yok (SM/OP site kullanıcı listesinden eşleyebilir, RESIDENT/TECH eşleyemez). |
| 10 | `GET /assignments/my` ticket özeti minimal | İYİLEŞTİRME | Yalnız `{id, code, status}`; başlık/adres için teknisyen ayrıca `GET /tickets/:id` çağırmalı (erişimi var). |
| 11 | Liste uçlarında toplam sayı yok | İYİLEŞTİRME | Cursor modelinde `totalCount` dönmez; sayfa numaralı UI kurgulanamaz. |
| 12 | `MATERIAL_INACTIVE`/`ASSIGNMENT_CONCURRENT_CONFLICT` status'ları | İYİLEŞTİRME | Doğrulandı (2026-07-19): `MATERIAL_INACTIVE` **409** döner (`material-lookup.service.ts` — `assertActiveMaterial`); `ASSIGNMENT_CONCURRENT_CONFLICT` sabiti tanımlıdır ama kodda hiçbir yerde fırlatılmaz (ölü sabit — frontend bu kodu beklememelidir). |
| 13 | Tarih/Decimal biçimleri | — | Risk değil, sözleşme netdir: timestamp'lar ISO-8601, takvim tarihleri `YYYY-MM-DD`, paralar string (Bölüm 2). |

---

## 17. İlk vertical slice uygunluk kontrolü

Akış: Resident giriş → ticket → Operations görür → teknisyen atar → Technician
kabul → durum günceller → malzeme → fotoğraf → tamamlar → Operations kapatır →
Resident sonucu görür.

**Sonuç: Akış backend'de UÇTAN UCA ÇALIŞIYOR ve 2026-07-19 itibarıyla tüm
ID'ler API'den keşfedilebilir.** E2E kanıtları: `assignments.e2e-spec.ts:176`
"tam mutlu yol" + `discovery.e2e-spec.ts` "vertical slice discovery varyantı"
(unit/teknisyen/materyal id'leri YALNIZ yeni keşif uçlarından alınarak akışın
tamamını koşturur). Aşağıdaki ⚠ satırları eski durumu ve onu kapatan yeni ucu
birlikte gösterir.

| Adım | Endpoint | Request | Response | Gerekli ID'nin kaynağı | Eksik |
|---|---|---|---|---|---|
| 1. Resident login | `POST /auth/otp/request` → (dev) `GET /dev/sms/:phone/last-otp` → `POST /auth/otp/verify` | phoneNumber; code | `{accessToken, refreshToken, expiresIn, user}` | Telefon kullanıcıdan | Prod'da gerçek SMS yok (SMS_PROVIDER=external UYGULANMAMIŞ) — dev'de inbox ile çalışır |
| 2. Ticket oluştur | `POST /tickets` | `{facilityId, title, description, category, urgency?}` | 201 TicketRow (`id`, `code`, `status:OPEN`) | ⚠→✔ facilityId artık `GET /users/me/units` yanıtındaki `unitId`'den alınır (Bölüm 16 #1 ÇÖZÜLDÜ) | — |
| 3. Operations görür | `GET /tickets?siteId=&status=OPEN` veya `GET /tickets/:id` | Bearer(OP) | `{items, nextCursor}` | ticket id adım 2'den / listeden | — |
| 3a. Triage (atama öncesi zorunlu) | `POST /tickets/:id/status` | `{toStatus:"TRIAGED"}` | 200 (TRIAGED) | — | — (OPEN'dan doğrudan atama yapılamaz; `ASSIGNABLE_TICKET_STATUSES = TRIAGED/REJECTED/ASSIGNED`) |
| 4. Teknisyen ata | `POST /tickets/:ticketId/assignments` | `{technicianId}` | 201 Assignment (`id`, PENDING) | ⚠→✔ technicianId artık `GET /users/technicians` listesinden seçilir (Bölüm 16 #2 ÇÖZÜLDÜ) | — |
| 5. Kabul | `POST /assignments/:id/accept` | Bearer(TECH) | 200 (ACCEPTED) | assignment id: teknisyen `GET /assignments/my`'dan | — |
| 6. Durum güncelle | `POST /assignments/:id/status` ×3 | `{event:"EN_ROUTE"}` → `ARRIVED` → `START` | 200 (ticket IN_PROGRESS'e ilerler) | — | — |
| 7. Malzeme ekle | `POST /assignments/:id/materials` | `{materialId, quantity:"3", unitPrice:"12.50", suppliedBy:"COMPANY"}` | 201 (`totalPrice:"37.50"`) | ⚠→✔ materialId artık `GET /materials` kataloğundan seçilir (Bölüm 16 #3 ÇÖZÜLDÜ) | — |
| 8. Fotoğraf yükle | `POST /tickets/:ticketId/attachments` | multipart `file` + `attachmentType:"AFTER_WORK"` + `assignmentId` | 201 AttachmentResponse | assignmentId adım 5'ten | — |
| 9. Tamamla | `POST /assignments/:id/status` | `{event:"COMPLETE", note?}` | 200 (ticket COMPLETED) | — | — |
| 10. Operations kapatır | `POST /tickets/:id/status` | `{toStatus:"CLOSED"}` | 200 (CLOSED) | Atanan teknisyeni görmek için `GET /tickets/:id/assignments/current` kullanılabilir (COMPLETE sonrası current kapandığı için 404 `ASSIGNMENT_NOT_FOUND` normaldir) | — |
| 11. Resident sonucu görür | `GET /tickets/:id`, `GET /tickets/:id/history`, `GET /tickets/:ticketId/attachments` + `/attachments/:id/download` | Bearer(RESIDENT) | TicketRow (CLOSED), history, attachment listesi | — | Resident assignment/malzeme detayını GÖREMEZ (assignment uçları resident'a kapalı) — sonuç görünürlüğü ticket status/history/attachment düzeyindedir |

**Ön koşullar:** sitede ACTIVE sözleşme (adım 2 için — seed'de
`contractPanoramaActive` mevcut), resident'ın aktif unit assignment'ı,
teknisyen hesabı. Development'ta `npm run db:seed` bunların tamamını kurar
(`prisma/seed.ts` — kullanıcılar `+9055500000xx`).

**Güncelleme (2026-07-19):** Bu bölümde daha önce önerilen üç keşif ucu,
`docs/frontend-enablement-plan.md` kapsamında uygulandı ve E2E ile
kanıtlandı: (a) `GET /users/me/units`, (b) `GET /users/technicians`,
(c) `GET /materials`; ek olarak (d) `GET /tickets/:ticketId/assignments/current`.
`/auth/me` genişletilmedi (plan Bölüm 4 kararı). Seed sabitleri artık yalnız
manuel kabul kolaylığıdır, zorunluluk değildir.

---

## 18. Frontend mimarisini etkileyen doğrulanmış backend kısıtları

Yalnız olgular (tercih/öneri içermez):

1. Access + refresh token **JSON body'de döner**; `Set-Cookie` yoktur; auth
   `Authorization: Bearer` header'ı ile taşınır.
2. Refresh **rotation'lıdır ve tek kullanımlıktır**; kullanılmış token'ın
   tekrarı tüm oturumları revoke eder (reuse detection).
3. Access token TTL env'den gelir (`expiresIn` alanı yanıtla döner; örnek env
   900 sn); guard her istekte DB'de `tokenVersion` doğrular — pasifleştirme/
   telefon değişikliği token süresi dolmadan 401 üretir.
4. CORS origin allowlist'i env'dendir, `credentials: true` sabittir; wildcard
   origin backend tarafından reddedilir.
5. Attachment indirme **kimlik doğrulamalı binary stream**'dir
   (`/attachments/:id/download`); public/signed URL yoktur.
6. Tüm listeler **cursor tabanlıdır** (`items`/`nextCursor`, default 20,
   max 100, `createdAt DESC`); toplam sayı alanı yoktur.
7. Başarı yanıtları **zarfsızdır**; hatalar tek tip
   `{success:false, error:{code, message, requestId, timestamp, details?}}`
   zarfındadır; validation hataları **422**'dir (400 değil).
8. Yetkisiz kaynak erişimi **404** döner (403 değil); 403 yalnız rol/işlem
   kısıtlarındadır — UI "bulunamadı"yı "erişim yok" olasılığıyla birlikte ele
   almalıdır.
9. OpenAPI/Swagger **yoktur**; tip sözleşmesi DTO/mapper dosyaları ve bu
   belgedir.
10. Realtime kanal (WebSocket/SSE/push) **yoktur**; bildirim uç noktası
    yoktur.
11. Para/miktar alanları **string**, takvim tarihleri **`YYYY-MM-DD`**,
    timestamp'lar **ISO-8601 UTC**'dir.
12. Dev ortamında OTP `GET /api/v1/dev/sms/:phone/last-otp` ile alınır;
    production'da gerçek SMS provider'ı henüz yoktur (`SMS_PROVIDER=external`
    reddedilir) — **production login akışı bugün uçtan uca çalıştırılamaz**.
13. JSON body limiti 100 kB'dir; dosya limiti 10 MB'dir (yalnız
    jpeg/png/webp, magic-bytes doğrulamalı).
14. `PATCH /tickets/:id` optimistic-lock `version` alanı zorunludur.

---

## 19. İncelenmesi gereken ek dosyalar

Bu incelemede açık kalan noktalar için tam yollar:

- ~~`material-lookup.service.ts` hata status'ları~~ — ÇÖZÜLDÜ (2026-07-19):
  `MATERIAL_NOT_FOUND` 404, `MATERIAL_INACTIVE` 409.
- ~~`ASSIGNMENT_CONCURRENT_CONFLICT` fırlatma yolu~~ — ÇÖZÜLDÜ (2026-07-19):
  sabit tanımlı ama hiçbir yerde fırlatılmıyor (ölü sabit).
- `src/modules/users/services/user-access.policy.ts` — SITE_MANAGER'ın
  PATCH `/users/:id` üzerindeki tam kural seti (hangi hedef kullanıcılar).
- `src/modules/tickets/services/ticket-transition.service.ts` —
  `completedAt/cancelledAt` set etme ayrıntıları.
- `src/modules/contracts/services/contract.service.ts` (tam okuma) — PATCH
  hata kodu ↔ HTTP status birebir eşlemesi.
- `src/modules/attachments/security/storage-key.util.ts` — storage key düzeni
  (operasyonel ilgi; response'a çıkmaz).
- `src/modules/attachments/interceptors/attachment-upload-cleanup.interceptor.ts`
  — hata durumunda temp dosya temizliği ayrıntısı.
- `docs/manual-acceptance.md` + `manual-tests/bruno/**` — manuel akışların
  seed sabitleriyle eşleşmesi (frontend dev ortamı kurulumu için).
- `docs/operations-runbook.md` — ortam değişkenleri işletme notları.
- `test/e2e/http-body-limit.e2e-spec.ts`, `test/e2e/dev-sms-inbox.e2e-spec.ts`
  — ilgili davranışların ek test kanıtları.

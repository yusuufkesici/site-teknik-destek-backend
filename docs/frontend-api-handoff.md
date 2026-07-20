# Frontend API Handoff — Site Teknik Destek Sistemi

## 1. Belge amacı, kapsamı ve kaynak önceliği

Bu belge, frontend ekibinin backend API'sini entegre etmek için ihtiyaç
duyduğu **tek ve güvenilir sözleşme referansıdır**. Herhangi bir frontend
kodu, repository iskeleti, framework/state-management/BFF/cookie kararı
veya backend kod değişikliği içermez — yalnız dokümantasyondur.

**Kaynak önceliği** (çelişki durumunda üstteki alttakini geçersiz kılar):

1. Çalışan backend kaynak kodu ve testler (unit/integration/E2E)
2. `docs/frontend-backend-facts.md`
3. `docs/manual-acceptance.md`
4. `docs/implementation-overrides.md`
5. `docs/frontend-enablement-plan.md`
6. `docs/architecture.md` — **yalnız tarihsel referans**; Bölüm 17'de
   listelenen tüm sapmalar (örn. signed URL, teknisyen için `GET /tickets`,
   global başarı zarfı) geçersizdir ve bu belgede **uygulanmış gibi
   gösterilmemiştir**.

Bu belge, `docs/frontend-backend-facts.md` (2026-07-19, keşif uçları dahil
güncelleme) ve `docs/frontend-enablement-plan.md`'nin frontend'e yönelik
damıtılmış, uygulama-hazır (implementation-ready) halidir. Kod veya test ile
bir önceki belge çelişirse **kod/test esas alınmıştır**; bu incelemede
`docs/manual-acceptance.md` ile kod arasında bir çelişki **bulunmamıştır**
(bkz. Bölüm 16).

**İncelenen commit:** `13da24e4e23730aeb10b1e1daebb87d2d90c94be` (branch:
`main`, dört keşif ucu dahil — bkz. `docs/frontend-enablement-plan.md`).
**İnceleme tarihi:** 2026-07-20.

Belirsiz veya kodda doğrulanamayan davranışlar `BELİRSİZ`, kodda
bulunmayan/planlanmayan davranışlar `UYGULANMAMIŞ` olarak işaretlenmiştir.
Örneklerdeki tüm UUID ve telefon numaraları **kurgusaldır**, gerçek bir
kayda karşılık gelmez.

---

## 2. API temeli

### Base URL ve prefix

Tüm route'lar global prefix `api/v1` altındadır:
`https://<host>/api/v1/<resource>`.
Kanıt: `src/main.ts` — `app.setGlobalPrefix(apiPrefix)`,
`src/config/configuration.ts` — `appConfig.apiPrefix = 'api/v1'`.
API versioning header/media-type bazlı **UYGULANMAMIŞ** — yalnız URL prefix'i
vardır.

### Authorization

Token, `Authorization: Bearer <accessToken>` header'ı ile taşınır.
`@Public()` işaretli uçlar (`/auth/otp/request`, `/auth/otp/verify`,
`/auth/token/refresh`, `/health/*`, dev SMS inbox) hariç **her istek** bu
header'ı gerektirir; eksik/geçersizse **401 `UNAUTHORIZED`**.
Kanıt: `src/common/guards/jwt-auth.guard.ts`.

### Başarı yanıtlarında global zarf YOKTUR

Başarı yanıtları **çıplak JSON** döner — `{ success: true, data: ... }` gibi
bir zarf **hiçbir uçta yoktur**. Liste uçları kendi içinde
`{ items: [...], nextCursor }` biçimindedir (Bölüm 5, 7); tekil kaynak uçları
doğrudan nesne/dizi döner. Frontend HTTP client'ında `data` unwrap katmanı
**yazılmamalıdır**.
Kanıt: hiçbir controller `{success:true,...}` üretmez;
`docs/architecture.md` Bölüm 11'deki "Tüm cevaplar zarflıdır" ifadesi
Bölüm 17 satır #1'de açıkça geçersiz kılınmıştır.

### Standart hata zarfı

Tüm hatalar (validation dahil) tek biçimdedir:

```json
{
  "success": false,
  "error": {
    "code": "TICKET_NOT_FOUND",
    "message": "Ticket bulunamadi.",
    "requestId": "3f9c2e10-38a1-4c3d-9a11-000000000001",
    "timestamp": "2026-07-20T09:15:32.104Z",
    "details": null
  }
}
```

`details` yalnız validation hatalarında (class-validator mesaj dizisi) veya
bazı domain hatalarında (`{from,to}` gibi) doludur; yoksa alan hiç
bulunmayabilir. `requestId`, `x-request-id` isteği header'ından gelir ya da
sunucu tarafından üretilir; başarı yanıtlarında bu id'nin response header'ı
olarak döndüğüne dair kod kanıtı yoktur → **BELİRSİZ** (frontend `requestId`'yi
yalnız hata gövdesinden okuyabileceğini varsaymalıdır).
Kanıt: `src/common/filters/global-exception.filter.ts`,
`src/common/types/error-response.type.ts`.

### JSON body limiti — 100 KB

`app.useBodyParser('json', { limit: '100kb' })` ve aynı limit `urlencoded`
için. Aşımda **413** + `{code:"VALIDATION_ERROR"}` (özel bir `PAYLOAD_TOO_LARGE`
kodu **yoktur** — express body-parser hatası genel VALIDATION_ERROR'a eşlenir).
Multipart (attachment) istekleri bu limitten **etkilenmez**.
Kanıt: `src/common/constants/http-body-limit.constant.ts`, `src/main.ts:31-32`,
`global-exception.filter.ts:82-94`, `test/e2e/http-body-limit.e2e-spec.ts`.

### Attachment boyut limiti — 10 MB

Multer dosya sınırı `MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024`. Aşımda
**413** + `{code:"ATTACHMENT_TOO_LARGE"}` (bu, JSON body limitinden **farklı**
bir kod — kanıt: `global-exception.filter.ts:145-146` `mapStatusToCode`).
Kanıt: `src/common/constants/attachment.constant.ts`,
`test/e2e/attachments.e2e-spec.ts:360`.

### Tarih serialization

`Date` alanları Express `res.json()` üzerinden **ISO-8601 UTC** string döner
(ör. `"2026-07-20T09:15:32.104Z"`). İstisna: takvim tarihi alanları
(`Contract.startDate/endDate`, invoice `billingPeriodStart/End`,
`issueDate`, `dueDate`) mapper'da **`"YYYY-MM-DD"`** stringine indirgenir
(saat/dilim bilgisi yoktur).
Kanıt: `src/modules/contracts/mappers/contract.mapper.ts`,
`src/modules/billing/mappers/invoice.mapper.ts`.

### Decimal serialization

Para/miktar alanları her zaman **string**, sabit ölçekle:

| Alan tipi | Format | Örnek |
|---|---|---|
| `quantity` (assignment material) | `toFixed(3)` | `"3.000"` |
| `unitPrice` / `totalPrice` / `monthlyFee` / `amount` | `toFixed(2)` | `"37.50"` |

Request'te de aynı biçimde **string** gönderilir (regex doğrulamalı DTO
alanları — Bölüm 6). Frontend hiçbir zaman `number` tipine cast edip
toplama/çarpma yapmamalıdır (Bölüm 12).
Kanıt: `assignment-material.mapper.ts`, `contract.mapper.ts`,
`invoice.mapper.ts`, `AddMaterialDto`.

---

## 3. Roller ve frontend erişim matrisi

Prisma `UserRole`: `RESIDENT | SITE_MANAGER | OPERATIONS | TECHNICIAN`.
`PLATFORM_ADMIN` **UYGULANMAMIŞ** (MVP kararı, `implementation-overrides.md` §10).

| Rol | Amaç | Frontend'de erişebileceği ana özellikler | Frontend'in GÖSTERMEMESİ gereken işlemler | Tenant/liste kapsamı |
|---|---|---|---|---|
| **RESIDENT** | Kendi dairesi için arıza kaydı açmak/takip etmek | OTP login; `GET /users/me/units`; `POST /tickets`; kendi ticket'larını listeleme/okuma/PATCH(OPEN)/iptal; ticket history; kendi ticket'ına attachment upload(assignmentId'siz)/liste/download | `operationNote` alanı (response'tan zaten kırpılır); teknisyen/atama/malzeme/contract/invoice/facility-yönetim ekranları; `GET /users/technicians`, `GET /materials`, current-assignment — **403 döner, UI'da hiç gösterilmemeli** | Yalnız kendi oluşturduğu ticket'lar ve kendi aktif unit'i |
| **SITE_MANAGER** | Kendi sitesinin sakin/ticket/sözleşme görünürlüğü + sakin yönetimi | Login (MANAGER üyeliği şart); site ticket listesi/detay (siteId zorunlu); OPEN/TRIAGED PATCH+iptal; sakin onboarding, site kullanıcı listesi, profil güncelleme, pasifleştirme; `GET /sites/:siteId/contracts`/`invoices` (salt-okuma); `GET /assignments/:id/materials` (kendi sitesi); attachment upload/list/download (kendi sitesi, assignmentId'siz); facility ağacı | Contract/invoice yazma; teknisyen atama/durum geçişi; global kullanıcı pasifleştirme; `GET /users/technicians`, `GET /materials`, `GET /users/me/units`, current-assignment — 403 | Yalnız MANAGER üyeliği olduğu site(ler); başka `siteId` → uniform 404 |
| **OPERATIONS** | Cross-site operasyon otoritesi | Facility CRUD; kullanıcı yönetimi (global pasifleştirme dahil, telefon **değiştiremez**); tüm ticket'ları listeleme/okuma/güncelleme (`operationNote` dahil); `OPEN→TRIAGED`, `COMPLETED→CLOSED`; ticket iptali; **`GET /users/technicians`** ile teknisyen keşfi + atama/yeniden atama; **`GET /tickets/:ticketId/assignments/current`**; `POST /assignments/:id/cancel`; `WAIT_MATERIAL`/`RESUME` event'leri; malzeme ekleme/listeleme; her ticket'a attachment; contract/invoice CRUD+durum geçişleri; site contract/invoice listeleri | `GET /users/me/units` — RESIDENT-only, 403 döner | Kapsamsız (cross-site); yalnız `SiteScopeGuard` OPERATIONS'ı koşulsuz geçirir |
| **TECHNICIAN** | Kendisine atanan işleri yürütmek | Login (üyelik şartsız); `GET /assignments/my`; accept/reject; durum event'leri; **`GET /materials`** ile katalog keşfi + malzeme ekleme; kendi assignment'ına fotoğraf upload; atandığı ticket'ın detay/history/attachment'larını okuma | **`GET /tickets` genel listesine erişemez (403 FORBIDDEN)** — UI teknisyen için asla genel ticket listesi göstermemeli, yalnız `/assignments/my`; ticket oluşturma/PATCH/iptal; `GET /users/technicians`, `GET /users/me/units`, current-assignment — 403 | Yalnız kendi assignment'ları/atandığı ticket'lar; başka teknisyenin kaydı → uniform 404 |

**Genel kural:** yetkisiz rol denemesi çoğunlukla **403 `FORBIDDEN`**
(`RolesGuard`), yetkisiz *kaynak* erişimi ise **404** (uniform — Bölüm 11).
Bu ikisi farklı katmanlardır; frontend ikisini de aynı "erişilemez" mesajıyla
ele alabilir ama HTTP status ayrımını (403 vs 404) beklemelidir.

---

## 4. Authentication sözleşmesi

Kaynak: `src/modules/auth/**`. Tüm route'lar `/api/v1/auth/*`.

### OTP request

`POST /auth/otp/request` (Public) — body `RequestOtpDto { phoneNumber }`
(E.164, ör. `"+905551234567"`; sunucu `+90XXXXXXXXXX` formatına normalize
eder, geçersiz format **422**). Yanıt **her koşulda** aynıdır (enumeration
koruması):

```json
{ "message": "Numara sistemde kayitliysa dogrulama kodu gonderildi." }
```

200 dönmesi kullanıcının var olduğu/uygun olduğu anlamına **gelmez**.
Rate limit: telefon başına 3/600 sn, IP başına 10/600 sn, cooldown (env
`OTP_RESEND_COOLDOWN_SECONDS`, örnek 60 sn) — limit aşımı da **sessizce aynı
200 mesajını döndürür**, ayrı bir 429 sinyali yalnız `/auth/otp/verify`
ucunda vardır (aşağıda).

### Development OTP inbox

`GET /dev/sms/:phone/last-otp` (Public) — **yalnız**
`NODE_ENV=development` **ve** `DEV_SMS_INBOX_ENABLED=true` iken mount edilir;
aksi halde route hiç yoktur (**404**, production'da her zaman). Başarı:
`{ "phoneNumber": "+905551234567", "code": "482913", "createdAt": "2026-07-20T09:10:00.000Z" }`.
Kod hiçbir yerde loglanmaz/DB'ye yazılmaz, yalnız process belleğinde TTL'li
tutulur. **Bu uç yalnız development entegrasyon/manuel test içindir; production
frontend akışında asla çağrılmamalıdır.**

### OTP verify

`POST /auth/otp/verify` (Public) — body
`VerifyOtpDto { phoneNumber, code(6 hane), deviceId? }`. Başarı **200**:

```json
{
  "accessToken": "eyJhbGciOi...",
  "refreshToken": "5f2a9c...opaque-base64url",
  "expiresIn": 900,
  "user": { "id": "3f9c2e10-38a1-4c3d-9a11-000000000001", "role": "RESIDENT", "fullName": "Ayşe Yılmaz" }
}
```

`expiresIn` saniye cinsinden access token ömrüdür. Hatalı kod / uygun
olmayan kullanıcı / süresi dolmuş challenge → **401 `AUTH_INVALID_OTP`**
(tek generic hata — hangi sebep olduğu sızmaz). IP başına 20/600 sn aşımı →
**429 `AUTH_RATE_LIMITED`**.

### `GET /auth/me`

Bearer gerektirir, tüm roller. Başarı **200**:

```json
{
  "id": "3f9c2e10-38a1-4c3d-9a11-000000000001",
  "role": "RESIDENT",
  "fullName": "Ayşe Yılmaz",
  "memberships": [{ "siteId": "11111111-1111-4111-8111-111111111101", "membershipRole": "RESIDENT" }]
}
```

**Unit/daire bilgisi İÇERMEZ** — bunun için `GET /users/me/units` kullanılır
(Bölüm 6). `memberships` boş dizi olabilir (OPERATIONS/TECHNICIAN için
her zaman `[]`).

### Refresh rotation

`POST /auth/token/refresh` (Public) — body `RefreshTokenDto { refreshToken }`.
Başarı **200**:

```json
{ "accessToken": "eyJhbGciOi...", "refreshToken": "9d1e...yeni-opaque", "expiresIn": 900 }
```

**Refresh yanıtında `user` alanı YOKTUR** — verify yanıtından bu farkla
ayrılır; frontend refresh sonrası kullanıcı profilini güncellemek isterse
ayrıca `GET /auth/me` çağırmalıdır. Her refresh token **tek kullanımlıktır**
(rotation) — kullanılan token bir daha geçerli değildir.

**Aynı refresh token ile paralel/eşzamanlı çağrı yasağı:** kullanılmış/rotate
edilmiş bir token tekrar sunulursa **reuse detection** tetiklenir, kullanıcının
**tüm aktif refresh session'ları revoke edilir** ve **401 `AUTH_INVALID_REFRESH`**
döner — yalnız o istek değil, **tüm cihazlardaki oturumlar** kapanır.
Bu nedenle frontend, aynı refresh token'la **eşzamanlı iki refresh isteği
göndermemelidir** (mutex/kuyruk ile serileştirilmelidir); aksi halde ikinci
istek kullanıcıyı beklenmedik şekilde tüm cihazlarda logout eder.
Kanıt: `token.service.ts:105-114`, `implementation-overrides.md` §8.

### Logout

`POST /auth/logout` — **Bearer gerektirir** + body `{ refreshToken }` →
**204** (gövdesiz). Yalnız o session revoke edilir.

### Cookie kullanılmıyor

Token'lar **yalnız JSON body'de** taşınır; `Set-Cookie` üreten hiçbir kod
yoktur. CORS `credentials: true` açık olsa da mevcut auth akışı cookie'ye
bağlı **değildir** — bu bir olgu tespitidir, cookie-tabanlı bir çözüm
**önerilmemektedir/tartışılmamaktadır** (kapsam dışı, Bölüm 1).

---

## 5. Ortak TypeScript sözleşmeleri

Aşağıdaki tipler, backend'in ürettiği/beklediği değer kümelerinin **birebir**
karşılığıdır (Prisma enum'ları ve sabit response şekilleri). Bu bir kod
üretimi değil, sözleşme referansıdır.

```typescript
type UserRole = "RESIDENT" | "SITE_MANAGER" | "OPERATIONS" | "TECHNICIAN";

type MembershipRole = "MANAGER" | "RESIDENT";

type TicketCategory =
  | "ELECTRICAL" | "PLUMBING" | "HVAC" | "PUMP" | "POOL"
  | "SECURITY_SYSTEM" | "GENERAL_MAINTENANCE" | "OTHER";

type TicketUrgency = "STANDARD" | "URGENT" | "EMERGENCY";

type TicketStatus =
  | "OPEN" | "TRIAGED" | "ASSIGNED" | "ACCEPTED" | "REJECTED"
  | "EN_ROUTE" | "ARRIVED" | "IN_PROGRESS" | "WAITING_MATERIAL"
  | "COMPLETED" | "CLOSED" | "CANCELLED";

type AssignmentStatus =
  | "PENDING" | "ACCEPTED" | "REJECTED" | "ACTIVE"
  | "COMPLETED" | "CANCELLED" | "REASSIGNED";

// POST /assignments/:id/status body.event değerleri — Prisma enum DEĞİL,
// sabit bir liste (assignment-status-event.map.ts).
type AssignmentStatusEvent =
  | "EN_ROUTE" | "ARRIVED" | "START" | "WAIT_MATERIAL" | "RESUME" | "COMPLETE";

type AttachmentType =
  | "ISSUE" | "BEFORE_WORK" | "AFTER_WORK" | "MATERIAL" | "DOCUMENT" | "OTHER";
// TECHNICIAN yalnız BEFORE_WORK | AFTER_WORK | MATERIAL kullanabilir (Bölüm 9).

type SuppliedBy = "COMPANY" | "SITE_MANAGEMENT" | "RESIDENT" | "TECHNICIAN" | "OTHER";

type ContractStatus = "DRAFT" | "ACTIVE" | "SUSPENDED" | "EXPIRED" | "TERMINATED";

type InvoiceStatus = "DRAFT" | "ISSUED" | "PAID" | "OVERDUE" | "CANCELLED";
// OVERDUE'ya manuel/API geçiş HER ZAMAN 409'dur (Bölüm 6 Billing).

type PaymentMethod = "BANK_TRANSFER" | "CASH" | "MANUAL_OTHER";

interface ErrorResponse {
  success: false;
  error: {
    code: ErrorCode;
    message: string;
    requestId: string;
    timestamp: string; // ISO-8601 UTC
    details?: unknown;
  };
}

interface CursorPage<T> {
  items: T[];
  nextCursor: string | null; // opak — Bölüm 7
}

// Kodda tanımlı tüm hata kodları (src/common/constants/error-codes.constant.ts).
// Frontend'in switch/case ile ele alması gereken tam küme budur.
type ErrorCode =
  | "VALIDATION_ERROR" | "NOT_FOUND" | "UNAUTHORIZED" | "FORBIDDEN"
  | "CONFLICT" | "INTERNAL_ERROR"
  | "AUTH_INVALID_OTP" | "AUTH_INVALID_REFRESH" | "AUTH_RATE_LIMITED"
  | "USER_PHONE_ALREADY_EXISTS" | "USER_PROFILE_CHANGE_FORBIDDEN"
  | "UNIT_NOT_FOUND" | "USER_NOT_FOUND"
  | "FACILITY_NOT_FOUND" | "FACILITY_CODE_CONFLICT" | "FACILITY_INVALID_PARENT"
  | "SITE_NOT_FOUND"
  | "RESIDENT_UNIT_ASSIGNMENT_CONFLICT" | "RESIDENT_UNIT_ASSIGNMENT_NOT_FOUND"
  | "TICKET_NOT_FOUND" | "TICKET_UPDATE_FORBIDDEN" | "TICKET_UPDATE_EMPTY"
  | "TICKET_STATUS_UNCHANGED" | "TICKET_INVALID_STATUS_TRANSITION"
  | "TICKET_TRANSITION_FORBIDDEN" | "TICKET_TRANSITION_REASON_REQUIRED"
  | "CONCURRENT_MODIFICATION" | "TICKET_SITE_CONTRACT_INACTIVE"
  | "ASSIGNMENT_NOT_FOUND" | "ASSIGNMENT_TECHNICIAN_INVALID"
  | "ASSIGNMENT_STATUS_CONFLICT" | "ASSIGNMENT_MATERIAL_NOT_ALLOWED"
  | "ASSIGNMENT_CONCURRENT_CONFLICT" // tanımlı ama kodda hiç fırlatılmıyor — bkz. Bölüm 16
  | "MATERIAL_NOT_FOUND" | "MATERIAL_INACTIVE"
  | "ATTACHMENT_NOT_FOUND" | "ATTACHMENT_FILE_REQUIRED" | "ATTACHMENT_TOO_LARGE"
  | "ATTACHMENT_UNSUPPORTED_TYPE" | "ATTACHMENT_TYPE_NOT_ALLOWED"
  | "ATTACHMENT_UPLOAD_NOT_ALLOWED" | "ATTACHMENT_ASSIGNMENT_MISMATCH"
  | "ATTACHMENT_STORAGE_FAILED"
  | "CONTRACT_NOT_FOUND" | "CONTRACT_INVALID_DATE_RANGE" | "CONTRACT_OVERLAP"
  | "CONTRACT_INVALID_STATUS_TRANSITION" | "CONTRACT_STATUS_UNCHANGED"
  | "CONTRACT_IMMUTABLE_FIELD" | "CONTRACT_UPDATE_EMPTY"
  | "CONTRACT_TERMINATION_DETAILS_REQUIRED" | "CONTRACT_TERMINATION_INVOICE_CONFLICT"
  | "INVOICE_NOT_FOUND" | "INVOICE_CONTRACT_NOT_BILLABLE" | "INVOICE_INVALID_PERIOD"
  | "INVOICE_INVALID_DUE_DATE" | "INVOICE_PERIOD_OUT_OF_CONTRACT"
  | "INVOICE_PERIOD_OVERLAP" | "INVOICE_CURRENCY_MISMATCH"
  | "INVOICE_INVALID_STATUS_TRANSITION" | "INVOICE_STATUS_UNCHANGED"
  | "INVOICE_PAYMENT_DETAILS_REQUIRED";
```

**Not:** `TicketSource` (`RESIDENT|SITE_MANAGER|OPERATIONS|PHONE_CALL`) ve
`FacilityType` (`SITE|BLOCK|UNIT|COMMON_AREA`) da response'larda görünür
(sırasıyla `TicketRow.source`, `FacilityRow.type`) ama kullanıcı isteğinin
istediği listede açıkça sayılmadığı için burada yalnız bilgi amaçlı anıldı.

---

## 6. Endpoint kataloğu

Her endpoint için sabit şablon kullanılmıştır. Örneklerdeki id/telefon
değerleri kurgusaldır.

### 6.1 Health

#### `GET /health/liveness`
- **Roller:** herkes · **Auth:** gerekmez (`@Public`)
- **Path/Query:** yok · **Body:** yok
- **Başarı:** 200 — `{ "status": "ok" }`
- **Hatalar:** yok (süreç ayaktaysa her zaman 200)
- **Tenant/kaynak:** yok · **Empty-state:** yok
- **Frontend notu:** yalnız süreç ayakta mı kontrolü; DB durumunu göstermez.

#### `GET /health/readiness`
- **Roller:** herkes · **Auth:** gerekmez (`@Public`)
- **Başarı:** 200 — `{ "status": "ok", "database": "ok" }`
- **Hatalar:** DB erişilemezse **503** — `ServiceUnavailableException` da
  diğer tüm exception'lar gibi `GlobalExceptionFilter`'dan geçer, yani
  **standart hata zarfını kullanır**:
  `{ "success": false, "error": { "code": "INTERNAL_ERROR", "message": "Veritabani baglantisi kurulamadi.", "requestId": "...", "timestamp": "..." } }`
  (503, `mapStatusToCode`'un switch'inde ayrı bir case olmadığından
  `default: INTERNAL_ERROR` koduna düşer — status yine de 503 kalır)
- **Frontend notu:** SMS provider durumu **raporlanmaz** (architecture.md'nin
  aksine) — yalnız DB `SELECT 1` kontrolü yapılır.

---

### 6.2 Auth

Ayrıntılı sözleşme Bölüm 4'tedir; burada yalnız şablon özeti verilir.

#### `POST /auth/otp/request`
- **Roller:** herkes (login öncesi) · **Auth:** gerekmez (`@Public`)
- **Body:** `{ phoneNumber: string }` (E.164)
- **Başarı:** 200 — `{ "message": string }` (her koşulda aynı)
- **Hatalar:** 422 `VALIDATION_ERROR` (format)
- **Empty-state:** yok · **Not:** enumeration koruması — 200 ≠ kullanıcı var.

#### `POST /auth/otp/verify`
- **Roller:** herkes · **Auth:** gerekmez
- **Body:** `{ phoneNumber, code(6 hane), deviceId? }`
- **Başarı:** 200 — Bölüm 4'teki örnek gövde
- **Hatalar:** 401 `AUTH_INVALID_OTP`, 429 `AUTH_RATE_LIMITED`, 422
- **Not:** başarılı yanıtta `user` nesnesi vardır (refresh'te yoktur).

#### `POST /auth/token/refresh`
- **Roller:** herkes · **Auth:** gerekmez
- **Body:** `{ refreshToken }`
- **Başarı:** 200 — `{ accessToken, refreshToken, expiresIn }` (**`user` YOK**)
- **Hatalar:** 401 `AUTH_INVALID_REFRESH`
- **Not:** eşzamanlı çağrı yasağı — Bölüm 4.

#### `POST /auth/logout`
- **Roller:** tüm roller · **Auth:** **Bearer gerekir**
- **Body:** `{ refreshToken }`
- **Başarı:** 204 (gövdesiz)
- **Hatalar:** 401

#### `GET /auth/me`
- **Roller:** tüm roller · **Auth:** Bearer
- **Başarı:** 200 — Bölüm 4'teki örnek
- **Hatalar:** 401

---

### 6.3 Dev tools

#### `GET /dev/sms/:phone/last-otp`
- **Roller:** herkes · **Auth:** gerekmez (`@Public`)
- **Path:** `phone` (ham string, normalize edilmeden route param olarak alınır)
- **Başarı:** 200 — `{ phoneNumber, code, createdAt }`
- **Hatalar:** 404 (kayıt yok VEYA `DEV_SMS_INBOX_ENABLED≠true`/production —
  ikisi de aynı 404, ayırt edilemez)
- **Frontend notu:** **Yalnız development entegrasyon ortamında** kullanılır;
  production build'inde bu uca hiçbir referans olmamalıdır.

---

### 6.4 Users

#### `GET /users/technicians` — **YENİ (frontend enablement)**
- **Roller:** yalnız `OPERATIONS` · **Auth:** Bearer
- **Path/Query:** yok · **Body:** yok
- **Başarı:** 200 —
  ```json
  [
    { "id": "22222222-2222-4222-8222-000000000010", "firstName": "Mehmet", "lastName": "Demir" },
    { "id": "22222222-2222-4222-8222-000000000011", "firstName": "Ali", "lastName": "Kaya" }
  ]
  ```
  **`phoneNumber` bilinçli olarak dönmez.** Pagination YOK; sıralama
  `lastName asc, firstName asc, id asc`; repository içi üst sınır 500 kayıt.
- **Hatalar:** 401, 403 (diğer roller)
- **Tenant/kaynak:** kapsamsız — teknisyenler site üyeliği olmayan şirket
  personelidir; sorgu sabittir (`role=TECHNICIAN AND isActive=true AND deletedAt IS NULL`)
- **Empty-state:** aktif teknisyen yoksa `200 []`
- **Frontend notu:** atama ekranındaki teknisyen seçim listesi **yalnız bu
  uçtan** doldurulmalı; önceden seed/sabit id varsayımı yapılmamalı. Global
  pasifleştirme sonrası kullanıcı bu listeden düşer (E2E kanıtlı:
  `test/e2e/discovery.e2e-spec.ts`).

#### `GET /users/me/units` — **YENİ (frontend enablement)**
- **Roller:** yalnız `RESIDENT` · **Auth:** Bearer
- **Path/Query:** yok (kimlik token'dan) · **Body:** yok
- **Başarı:** 200 —
  ```json
  [
    {
      "id": "77777777-7777-4777-8777-000000000001",
      "unitId": "11111111-1111-4111-8111-111111111103",
      "isPrimary": true,
      "startsAt": "2026-01-05T10:00:00.000Z",
      "unit": { "id": "11111111-1111-4111-8111-111111111103", "name": "Daire 1", "code": "1", "siteId": "11111111-1111-4111-8111-111111111101" }
    }
  ]
  ```
  Pagination YOK.
- **Hatalar:** 401, 403 (RESIDENT dışı roller)
- **Tenant/kaynak:** parametre alınmaz — sorgu her zaman `userId = actor.id`;
  IDOR yüzeyi yoktur (başkasının unit'i sorgulanamaz)
- **Empty-state:** aktif unit kaydı yoksa `200 []` (**404 değil**)
- **Frontend notu:** `POST /tickets` formundaki `facilityId` alanı **yalnız
  bu uçtan dönen `unitId`** ile doldurulmalıdır (vertical slice — Bölüm 14).
  Dizi teorik olarak >1 eleman taşıyabilir ama backend "tek aktif unit"
  varsayımıyla çalışır (`resident-unit-assignment.repository.ts` yorumu);
  frontend yine de dizi üzerinde çalışmalı, ilk elemana sabit varsaymamalıdır.

#### `POST /sites/:siteId/residents`
- **Roller:** `SITE_MANAGER`, `OPERATIONS` · **Auth:** Bearer + `SiteScopeGuard`
- **Path:** `siteId` (UUID)
- **Body:** `CreateResidentDto { phoneNumber, firstName(≤100), lastName(≤100), unitId(UUID), isPrimary?: boolean }`
- **Başarı:** 201 — ham `UserRow` (bkz. risk notu altta)
- **Hatalar:** 404 `UNIT_NOT_FOUND`/`SITE_NOT_FOUND`, 409
  `USER_PHONE_ALREADY_EXISTS`, 409 `RESIDENT_UNIT_ASSIGNMENT_CONFLICT`, 422
- **Tenant/kaynak:** `SiteScopeGuard` SM'i site üyeliğiyle sınırlar; `unitId`
  bu `siteId`'ye ait olmalı (aksi 404 `UNIT_NOT_FOUND`)
- **Empty-state:** n/a (create)
- **⚠ Risk:** response mapper YOK — `UserRow`
  `{id, phoneNumber, firstName, lastName, role, isActive, tokenVersion, createdAt, updatedAt, deletedAt}`
  **birebir** döner. `tokenVersion` ve `deletedAt` iç implementasyon
  detaylarıdır, frontend bunlara **bağımlı kod yazmamalıdır** (bkz. Bölüm 16).

#### `GET /sites/:siteId/users`
- **Roller:** `SITE_MANAGER`, `OPERATIONS` · **Auth:** Bearer + `SiteScopeGuard`
- **Path:** `siteId` · **Query:** `cursor?`, `limit?`(1-100, varsayılan 20)
- **Başarı:** 200 — `CursorPage<UserRow>` (aynı ⚠ risk — ham satır)
- **Hatalar:** 404 `SITE_NOT_FOUND`, 422 (geçersiz cursor)
- **Empty-state:** `{items:[],nextCursor:null}`

#### `PATCH /users/:id`
- **Roller:** `SITE_MANAGER`, `OPERATIONS` · **Auth:** Bearer
- **Path:** `id` (UUID) · **Body:**
  `UpdateUserDto { firstName?, lastName?, phoneNumber? }` — **OPERATIONS
  telefon değiştiremezse 403** (`USER_PROFILE_CHANGE_FORBIDDEN` değil, generic
  `FORBIDDEN` — kanıt: `users.service.ts:144-150`)
- **Başarı:** 200 — ham `UserRow`
- **Hatalar:** 404 `USER_NOT_FOUND`, 409 `USER_PHONE_ALREADY_EXISTS`, 403
- **Tenant/kaynak:** SM yalnız kendi sitesinin sakinini güncelleyebilir
  (`UserAccessPolicy` — tam kural seti bu incelemede satır satır
  doğrulanmadı → **BELİRSİZ**, bkz. Bölüm 16)
- **Not:** telefon değişimi `tokenVersion++` tetikler → kullanıcının **tüm
  eski access token'ları anında geçersiz olur**.

#### `POST /sites/:siteId/users/:userId/deactivate`
- **Roller:** `SITE_MANAGER`, `OPERATIONS` · **Auth:** Bearer + `SiteScopeGuard`
- **Body:** `{ reason(≤500, zorunlu) }`
- **Başarı:** 204 · **Hatalar:** 404 `USER_NOT_FOUND`
- **Not:** yalnız **site-scoped** pasifleştirme — refresh session'lara
  dokunmaz; global `isActive` değişmez.

#### `POST /users/:id/deactivate`
- **Roller:** yalnız `OPERATIONS` · **Auth:** Bearer
- **Body:** `{ reason(≤500, zorunlu) }`
- **Başarı:** 204 · **Hatalar:** 404 `USER_NOT_FOUND`
- **Not:** **global** pasifleştirme — kullanıcının tüm refresh session'ları
  revoke edilir, bir daha login olamaz.

#### `POST /sites/:siteId/units/:unitId/assignments/:assignmentId/deactivate`
- **Roller:** `SITE_MANAGER`, `OPERATIONS` · **Auth:** Bearer + `SiteScopeGuard`
- **Path:** `siteId`, `unitId`, `assignmentId` (ResidentUnitAssignment id)
- **Başarı:** 204 · **Hatalar:** 404 `RESIDENT_UNIT_ASSIGNMENT_NOT_FOUND`

---

### 6.5 Facilities

Tüm response'lar ham `FacilityRow`
`{id, type, name, code, parentId, siteId, isActive, createdAt, updatedAt, deletedAt}`
— response mapper **yoktur** (⚠ Bölüm 16).

#### `POST /facilities/sites`
- **Roller:** yalnız `OPERATIONS` · **Body:** `{ name(≤200), code(≤50) }`
- **Başarı:** 201 `FacilityRow` (`type:"SITE"`)
- **Hatalar:** 409 `FACILITY_CODE_CONFLICT`, 422

#### `POST /facilities/sites/:siteId/blocks`
- **Roller:** `OPERATIONS` · **Path:** `siteId` · **Body:** `{ name, code }`
- **Başarı:** 201 `FacilityRow` (`type:"BLOCK"`)
- **Hatalar:** 404 `SITE_NOT_FOUND`/`FACILITY_NOT_FOUND`, 409, 422
  `FACILITY_INVALID_PARENT`

#### `POST /facilities/blocks/:blockId/units`
- **Roller:** `OPERATIONS` · **Path:** `blockId` · **Body:** `{ code, name? }`
- **Başarı:** 201 `FacilityRow` (`type:"UNIT"`, `siteId` parent'tan devralınır)
- **Hatalar:** aynı desen

#### `POST /facilities/:parentId/common-areas`
- **Roller:** `OPERATIONS` · **Path:** `parentId` (SITE veya BLOCK)
- **Body:** `{ name, code }`
- **Başarı:** 201 `FacilityRow` (`type:"COMMON_AREA"`)
- **Hatalar:** aynı desen

#### `GET /facilities/sites/:siteId/tree`
- **Roller:** `SITE_MANAGER` (SiteScopeGuard), `OPERATIONS`
- **Başarı:** 200 —
  ```json
  {
    "id": "11111111-1111-4111-8111-111111111101", "type": "SITE", "name": "Panorama Evleri", "code": "PNR",
    "children": [
      { "id": "...", "type": "BLOCK", "name": "A Blok", "code": "A", "children": [
        { "id": "...", "type": "UNIT", "name": "Daire 1", "code": "1", "children": [] }
      ] }
    ]
  }
  ```
  (`FacilityTreeNode = FacilityRow & { children: FacilityTreeNode[] }`)
- **Hatalar:** 404 `SITE_NOT_FOUND`
- **Empty-state:** site'ın hiç alt kaydı yoksa `children: []`
- **Tenant/kaynak:** `SiteScopeGuard` SM'in üyeliğini doğrular, site'ın
  gerçekten var olduğunu **doğrulamaz** — bu kontrolü `FacilityService`
  ayrıca yapar (404 uniform).

---

### 6.6 Tickets

Response `TicketRow`: `{id, code, createdByUserId, siteId, facilityId, title,
description, category, urgency, status, source, slaTargetAt, isRecurring,
operationNote*, completedAt, cancelledAt, cancellationReason, version,
createdAt, updatedAt, deletedAt}`. *`operationNote` yalnız `OPERATIONS`'a
döner (mapper alanı kırpar — bu tek istisna dışında ham satırdır).

#### `POST /tickets`
- **Roller:** `RESIDENT`, `SITE_MANAGER`, `OPERATIONS` (TECHNICIAN → 403)
- **Body:** `CreateTicketDto { facilityId(UUID), title(5-150), description(10-4000), category, urgency? }`
- **Başarı:** 201 — `status:"OPEN"`, `code:"TKT-2026-000123"` biçiminde
- **Hatalar:** 404 `FACILITY_NOT_FOUND`, 409 `TICKET_SITE_CONTRACT_INACTIVE`
  (sitede aktif sözleşme yoksa), 403 (TECHNICIAN), 422
- **Tenant/kaynak:** `siteId` **client'tan alınmaz**, `facilityId`'den
  türetilir; RESIDENT yalnız kendi aktif unit'i, SM yalnız kendi sitesi
- **Frontend notu:** `facilityId` **RESIDENT için `GET /users/me/units`
  yanıtındaki `unitId`'den** alınmalıdır (Bölüm 6.4).

#### `GET /tickets`
- **Roller:** `RESIDENT`, `SITE_MANAGER`, `OPERATIONS` — **`TECHNICIAN` → 403
  `FORBIDDEN`** (mimari belgesinin aksine, bkz. Bölüm 1)
- **Query:** `cursor?`, `limit?`(1-100, varsayılan 20), `siteId?`
  (**SM için zorunlu**, aksi 422), `status?`, `urgency?`
- **Başarı:** 200 `CursorPage<TicketRow>`
- **Hatalar:** 404 `SITE_NOT_FOUND` (bilinmeyen siteId), 422 (SM siteId
  vermezse), 403 (TECHNICIAN)
- **Tenant/kaynak:** RESIDENT → yalnız kendi ticket'ları; SM → yalnız
  verdiği `siteId` (üyeliği doğrulanır); OPERATIONS → `siteId` opsiyonel
- **Empty-state:** `{items:[],nextCursor:null}`

#### `GET /tickets/:id`
- **Roller:** 4 rol (erişimi varsa)
- **Başarı:** 200 `TicketRow` · **Hatalar:** 404 `TICKET_NOT_FOUND` (uniform)

#### `PATCH /tickets/:id`
- **Roller:** `RESIDENT`(OPEN, kendi), `SITE_MANAGER`(OPEN/TRIAGED, kendi
  sitesi), `OPERATIONS`(koşulsuz)
- **Body:** `UpdateTicketDto { title?, description?, category?, urgency?, operationNote?, version!(zorunlu) }`
  — `operationNote` yalnız OPERATIONS yazabilir (aksi 403)
- **Başarı:** 200 `TicketRow`
- **Hatalar:** 409 `CONCURRENT_MODIFICATION` (version uyuşmazlığı), 422
  `TICKET_UPDATE_EMPTY` (hiçbir alan yoksa), 403 `TICKET_UPDATE_FORBIDDEN`
  (durum uygun değil) / `FORBIDDEN` (operationNote), 404
- **Not:** optimistic locking — Bölüm 10.

#### `POST /tickets/:id/status`
- **Roller:** yalnız `OPERATIONS`
- **Body:** `ChangeTicketStatusDto { toStatus: "TRIAGED"|"CLOSED", reason? }`
  — **DTO seviyesinde başka değer kabul edilmez**
- **Başarı:** **201** (NestJS POST varsayılanı — `@HttpCode` override yok,
  kanıt: `tickets.controller.ts` + `test/e2e/*.e2e-spec.ts` `.expect(HttpStatus.CREATED)`)
- **Hatalar:** 409 `TICKET_STATUS_UNCHANGED`/`TICKET_INVALID_STATUS_TRANSITION`,
  403 `TICKET_TRANSITION_FORBIDDEN`, 422 `TICKET_TRANSITION_REASON_REQUIRED`, 404
- **Not:** Bölüm 8 — yalnız `OPEN→TRIAGED` ve `COMPLETED→CLOSED` bu uçtan
  yürür.

#### `POST /tickets/:id/cancel`
- **Roller:** `RESIDENT`, `SITE_MANAGER`, `OPERATIONS`
- **Body:** `{ reason(zorunlu, ≤1000) }`
- **Başarı:** 201 (aynı gerekçeyle) · **Hatalar:** state machine hataları, 404

#### `GET /tickets/:id/history`
- **Roller:** 4 rol (erişimi varsa)
- **Başarı:** 200 — `TicketStatusHistoryRow[]`
  (`{id, ticketId, previousStatus, newStatus, changedByUserId, reason, metadata, createdAt}`),
  **pagination YOK**, `createdAt asc`
- **Hatalar:** 404 `TICKET_NOT_FOUND`
- **Empty-state:** teorik olarak imkânsız — create her zaman `null→OPEN`
  satırı yazar; dizi her zaman ≥1 elemanlıdır.

---

### 6.7 Assignments

Response `AssignmentRow`: `{id, ticketId, technicianId, assignedByUserId,
assignmentStatus, assignedAt, acceptedAt, rejectedAt, rejectionReason,
enRouteAt, arrivedAt, startedAt, completedAt, resolutionNote, isCurrent,
createdAt, updatedAt}`.

#### `POST /tickets/:ticketId/assignments`
- **Roller:** yalnız `OPERATIONS`
- **Body:** `{ technicianId(UUID) }`
- **Başarı:** 201 — `assignmentStatus:"PENDING"`
- **Hatalar:** 404 `TICKET_NOT_FOUND`, 409
  `TICKET_INVALID_STATUS_TRANSITION` (ticket `TRIAGED|REJECTED|ASSIGNED`
  dışındaysa), 422 `ASSIGNMENT_TECHNICIAN_INVALID`
- **Frontend notu:** `technicianId` **`GET /users/technicians`** listesinden
  seçilmelidir. Ticket zaten `ASSIGNED` ise bu çağrı **yeniden atamadır**
  (eski assignment `REASSIGNED` olur) — aynı endpoint hem ilk atama hem
  reassign için kullanılır.

#### `GET /tickets/:ticketId/assignments/current` — **YENİ (frontend enablement)**
- **Roller:** yalnız `OPERATIONS` · **Auth:** Bearer
- **Path:** `ticketId` (UUID)
- **Başarı:** 200 — mevcut `AssignmentRow` sözleşmesi **birebir** (yeni alan
  eklenmedi):
  ```json
  {
    "id": "88888888-8888-4888-8888-000000000001",
    "ticketId": "44444444-4444-4444-8444-000000000001",
    "technicianId": "22222222-2222-4222-8222-000000000010",
    "assignedByUserId": "99999999-9999-4999-8999-000000000001",
    "assignmentStatus": "ACTIVE",
    "assignedAt": "2026-07-20T09:00:00.000Z",
    "acceptedAt": "2026-07-20T09:02:00.000Z",
    "rejectedAt": null, "rejectionReason": null,
    "enRouteAt": "2026-07-20T09:05:00.000Z", "arrivedAt": "2026-07-20T09:20:00.000Z",
    "startedAt": "2026-07-20T09:25:00.000Z", "completedAt": null,
    "resolutionNote": null, "isCurrent": true,
    "createdAt": "2026-07-20T09:00:00.000Z", "updatedAt": "2026-07-20T09:25:00.000Z"
  }
  ```
- **Hatalar:**
  - **404 `TICKET_NOT_FOUND`** — ticket yok/soft-deleted/erişilemez
  - **404 `ASSIGNMENT_NOT_FOUND`** — ticket var ama şu an `isCurrent=true`
    bir assignment yok (bu, **normal bir akış durumudur**, hata değil):
    - ticket henüz `OPEN`/`TRIAGED` (hiç atanmamış)
    - son assignment `COMPLETE` olmuş (`isCurrent` kapanır)
    - ticket `CANCELLED`/`CLOSED`
  - 401, 403 (diğer roller)
- **Tenant/kaynak:** önce `TicketReadAccessService` ile ticket erişimi
  yeniden doğrulanır (OPERATIONS için koşulsuz ama ticket'ın var/silinmemiş
  olduğunu kontrol eder), sonra `isCurrent=true` satırı okunur.
  `uq_assignments_one_current_per_ticket` partial unique index'i en fazla
  1 satır garantiler.
- **Empty-state:** "boş" durum **200+null değil, 404
  `ASSIGNMENT_NOT_FOUND`** olarak modellenmiştir — frontend bu 404'ü
  hata banner'ı olarak GÖSTERMEMELİ, "henüz teknisyen atanmadı" gibi normal
  bir UI durumuna çevirmelidir (ticket'ın kendi `status` alanı zaten hangi
  aşamada olduğunu söyler).
- **Frontend notu:** reassign/iptal akışında hangi teknisyenin atanmış
  olduğunu göstermek için kullanılır; yalnız OPERATIONS'a açıktır — diğer
  roller teknisyen bilgisini bu uçtan **öğrenemez** (bilinçli tasarım
  kararı, `docs/frontend-enablement-plan.md` Bölüm 3/E4).

#### `POST /assignments/:id/accept`
- **Roller:** yalnız `TECHNICIAN` (kendi ataması, `PENDING`)
- **Başarı:** 201 — `assignmentStatus:"ACCEPTED"`
- **Hatalar:** 404 `ASSIGNMENT_NOT_FOUND` (yok veya başkasına ait —
  uniform), 409 `ASSIGNMENT_STATUS_CONFLICT`

#### `POST /assignments/:id/reject`
- **Roller:** `TECHNICIAN` · **Body:** `{ reason(zorunlu) }`
- **Başarı:** 201 — `assignmentStatus:"REJECTED"` · **Hatalar:** aynı desen

#### `POST /assignments/:id/status`
- **Roller:** `TECHNICIAN`, `OPERATIONS` (event'e göre fiili kısıt Bölüm 8)
- **Body:** `{ event: AssignmentStatusEvent, note? }` — `note` **yalnız**
  `event:"COMPLETE"` ile kabul edilir (aksi 422)
- **Başarı:** 201
- **Hatalar:** 404, 409 `ASSIGNMENT_STATUS_CONFLICT`, 403
  `TICKET_TRANSITION_FORBIDDEN`, 422 `VALIDATION_ERROR` (yanlış yerde `note`)

#### `POST /assignments/:id/cancel`
- **Roller:** yalnız `OPERATIONS` · **Body:** `{ reason(zorunlu) }`
- **Başarı:** 201 — assignment `CANCELLED`, ticket `CANCELLED`
- **Hatalar:** 404, 409 (ticket `ASSIGNED` dışındaysa)

#### `GET /assignments/my`
- **Roller:** yalnız `TECHNICIAN`
- **Query:** `cursor?`, `limit?`(varsayılan 20), `status?`
- **Başarı:** 200 `CursorPage<AssignmentRow & {ticket:{id,code,status}}>`
  (resident PII yok)
- **Empty-state:** `{items:[],nextCursor:null}`

#### `POST /assignments/:id/materials`
- **Roller:** `TECHNICIAN`(kendi `ACTIVE` assignment'ı), `OPERATIONS`
- **Body:** `AddMaterialDto { materialId(UUID), quantity(string, ≤3 ondalık), unitPrice(string, ≤2 ondalık), suppliedBy, note? }`
- **Başarı:** 201 —
  ```json
  { "id": "...", "assignmentId": "...", "material": {"id":"...","name":"16A Sigorta","code":"SGT-16A","unit":"adet"}, "quantity": "3.000", "unitPrice": "12.50", "totalPrice": "37.50", "suppliedBy": "COMPANY", "note": null, "createdByUserId": "...", "createdAt": "..." }
  ```
- **Hatalar:** 404 `MATERIAL_NOT_FOUND`/`ASSIGNMENT_NOT_FOUND`, 409
  `ASSIGNMENT_MATERIAL_NOT_ALLOWED` (assignment `ACTIVE` değilse), **409
  `MATERIAL_INACTIVE`** (materyal pasifse — doğrulandı,
  `material-lookup.service.ts`), 422
- **Frontend notu:** `materialId` **`GET /materials`** kataloğundan
  seçilmelidir; `totalPrice`'ı frontend **hesaplamaz**, backend'in
  döndürdüğü değeri gösterir (Bölüm 12).

#### `GET /assignments/:id/materials`
- **Roller:** `TECHNICIAN`, `SITE_MANAGER`, `OPERATIONS`
- **Başarı:** 200 — dizi (**pagination yok**) · **Empty-state:** `[]`
- **Hatalar:** 404 `ASSIGNMENT_NOT_FOUND`

---

### 6.8 Materials

#### `GET /materials` — **YENİ (frontend enablement)**
- **Roller:** `TECHNICIAN`, `OPERATIONS` · **Auth:** Bearer
- **Query:** `cursor?`, `limit?`(1-100, varsayılan 20) — **başka filtre
  yok**, `isActive` parametresi client'tan **alınmaz**
- **Başarı:** 200 —
  ```json
  {
    "items": [
      { "id": "44444444-4444-4444-8444-444444444401", "name": "16A Sigorta", "code": "SGT-16A", "unit": "adet", "description": null, "createdAt": "2026-01-01T00:00:00.000Z" }
    ],
    "nextCursor": null
  }
  ```
  Yalnız **aktif + silinmemiş** katalog döner; `isActive`, `updatedAt`,
  `deletedAt` alanları **dönmez**. Sıralama `createdAt DESC, id DESC`.
- **Hatalar:** 401, 403 (RESIDENT/SITE_MANAGER), 422 `VALIDATION_ERROR`
  (geçersiz cursor/limit)
- **Tenant/kaynak:** kapsamsız — `Material` şirket kataloğudur, site'a
  bağlı değildir
- **Empty-state:** `{items:[],nextCursor:null}`
- **Frontend notu:** `POST /assignments/:id/materials` formundaki
  `materialId` **yalnız bu uçtan** doldurulmalıdır. Katalog CRUD'u
  **UYGULANMAMIŞ** — malzeme ekleme/düzenleme/pasifleştirme yalnız DB/seed
  üzerinden yapılır, frontend bunun için bir uç beklememelidir.

---

### 6.9 Attachments

#### `POST /tickets/:ticketId/attachments`
- **Roller:** 4 rol (ticket'a erişimi varsa)
- **Multipart alanları:** `file`(tek dosya, zorunlu), `attachmentType`
  (`AttachmentType`, zorunlu), `assignmentId?`(UUID)
- **Başarı:** 201 —
  `{id, ticketId, assignmentId, attachmentType, originalFileName, mimeType, fileSize, uploadedByUserId, createdAt}`
- **Hatalar:** 422 `ATTACHMENT_FILE_REQUIRED` (boş/eksik dosya), 415
  `ATTACHMENT_UNSUPPORTED_TYPE` (MIME/magic-byte uyuşmazlığı), 413
  `ATTACHMENT_TOO_LARGE` (>10MB), 403 `ATTACHMENT_UPLOAD_NOT_ALLOWED`
  (RESIDENT/SM `assignmentId` gönderirse), 404 `ASSIGNMENT_NOT_FOUND`
  (TECHNICIAN uygun assignment'a sahip değilse), 409
  `ATTACHMENT_ASSIGNMENT_MISMATCH`, 422 `ATTACHMENT_TYPE_NOT_ALLOWED`
  (TECHNICIAN yasak tip), 403 `TICKET_UPDATE_FORBIDDEN` (CLOSED/CANCELLED
  ticket'a RESIDENT/SM upload denerse), 404 `TICKET_NOT_FOUND`
- **Tenant/kaynak:** Bölüm 9 ve 11'de ayrıntılı
- **Not:** Sunucu ayrıntısı `docs/frontend-backend-facts.md` §11'de tam.

#### `GET /tickets/:ticketId/attachments`
- **Roller:** 4 rol (erişimi varsa) · **Query:** `cursor?`, `limit?`
- **Başarı:** 200 `CursorPage<AttachmentResponse>`
- **Hatalar:** 404 `TICKET_NOT_FOUND` · **Empty-state:** `{items:[],nextCursor:null}`

#### `GET /attachments/:id/download`
- **Roller:** 4 rol (erişimi varsa)
- **Başarı:** 200 — **binary stream** (JSON değil); header'lar:
  `Content-Type`, `Content-Length`,
  `Content-Disposition: attachment; filename="..."; filename*=UTF-8''...`,
  `X-Content-Type-Options: nosniff`
- **Hatalar:** 404 `ATTACHMENT_NOT_FOUND` (uniform — yok/silinmiş/erişilemez
  ticket hepsi aynı), 500 `ATTACHMENT_STORAGE_FAILED`
- **Not:** Bölüm 9.

---

### 6.10 Contracts

Response `ContractResponse`: `{id, siteId, contractNumber, startDate("YYYY-MM-DD"),
endDate, monthlyFee("1000.00"), currency, billingDay, status, serviceScope,
standardResponseTargetHours, emergencyCoverage, notes, createdByUserId,
createdAt, updatedAt, terminatedAt, terminationReason}` — açık mapper'lı.

#### `POST /contracts`
- **Roller:** yalnız `OPERATIONS`
- **Body:** `CreateContractDto { siteId, startDate("YYYY-MM-DD"), endDate, monthlyFee(string), billingDay(1-28), currency?(3 harf), serviceScope?, standardResponseTargetHours?, emergencyCoverage?, notes? }`
  — `status`/`contractNumber` client'tan alınmaz (her zaman `DRAFT`)
- **Başarı:** 201 · **Hatalar:** 422 `VALIDATION_ERROR`/tarih hataları, 409
  `CONTRACT_OVERLAP`, 404 `SITE_NOT_FOUND`

#### `PATCH /contracts/:id`
- **Roller:** yalnız `OPERATIONS`
- **Body:** `UpdateContractDto { endDate?, monthlyFee?, billingDay?, currency?, serviceScope?, standardResponseTargetHours?, emergencyCoverage?, notes?, status?, terminationReason? }`
  — `siteId`/`startDate`/`contractNumber` **immutable**
- **Başarı:** 200 · **Hatalar:** 404 `CONTRACT_NOT_FOUND`, 409
  `CONTRACT_STATUS_UNCHANGED`/`CONTRACT_INVALID_STATUS_TRANSITION`/
  `CONTRACT_OVERLAP`/`CONTRACT_TERMINATION_INVOICE_CONFLICT`, 422
  `CONTRACT_UPDATE_EMPTY`/`CONTRACT_IMMUTABLE_FIELD`/
  `CONTRACT_TERMINATION_DETAILS_REQUIRED`

#### `GET /sites/:siteId/contracts`
- **Roller:** `SITE_MANAGER`(SiteScopeGuard, salt-okuma), `OPERATIONS`
- **Query:** `cursor?`, `limit?`, `status?`
- **Başarı:** 200 `CursorPage<ContractResponse>` · **Hatalar:** 404
  `SITE_NOT_FOUND` · **Empty-state:** `{items:[],nextCursor:null}`
- **Not:** durum filtresiz **geçmiş** (EXPIRED/TERMINATED) sözleşmeler de
  listelenir (Bölüm 12).

---

### 6.11 Billing (Invoices)

Response `InvoiceResponse`: `{id, contractId, invoiceNumber,
billingPeriodStart("YYYY-MM-DD"), billingPeriodEnd, issueDate, dueDate,
amount("1000.00"), currency, status, paidAt, paymentMethod, referenceNumber,
note, createdAt, updatedAt}`.

#### `POST /contracts/:id/invoices`
- **Roller:** yalnız `OPERATIONS` · **Path:** `id` (contractId)
- **Body:** `CreateInvoiceDto { billingPeriodStart, billingPeriodEnd, issueDate, dueDate, amount(string), note? }`
  — `currency`/`invoiceNumber`/`status` client'tan **alınmaz**; `currency`
  sözleşmeden snapshot kopyalanır
- **Başarı:** 201 (`status:"DRAFT"`) · **Hatalar:** 404 `CONTRACT_NOT_FOUND`,
  409/422: `INVOICE_CONTRACT_NOT_BILLABLE`, `INVOICE_INVALID_PERIOD`,
  `INVOICE_INVALID_DUE_DATE`, `INVOICE_PERIOD_OUT_OF_CONTRACT`,
  `INVOICE_PERIOD_OVERLAP`, `INVOICE_CURRENCY_MISMATCH`

#### `PATCH /invoices/:id/status`
- **Roller:** yalnız `OPERATIONS`
- **Body:** `ChangeInvoiceStatusDto { status, paymentMethod?, referenceNumber? }`
  — **`paidAt` client'tan asla alınmaz**; hedef `PAID` değilken
  `paymentMethod`/`referenceNumber` gönderilirse 422
- **Başarı:** 200 · **Hatalar:** 404 `INVOICE_NOT_FOUND`, 409
  `INVOICE_STATUS_UNCHANGED`/`INVOICE_INVALID_STATUS_TRANSITION`
  (**OVERDUE'ya manuel geçiş her koşulda 409** — Bölüm 5), 422
  `INVOICE_PAYMENT_DETAILS_REQUIRED`

#### `GET /sites/:siteId/invoices`
- **Roller:** `SITE_MANAGER`(SiteScopeGuard), `OPERATIONS`
- **Query:** `cursor?`, `limit?`, `status?`, `contractId?`
- **Başarı:** 200 `CursorPage<InvoiceResponse>` · **Hatalar:** 404
  `SITE_NOT_FOUND` · **Empty-state:** `{items:[],nextCursor:null}`

---

## 7. Cursor pagination sözleşmesi

Kullanan uçlar: `GET /tickets`, `GET /tickets/:ticketId/attachments`,
`GET /assignments/my`, `GET /sites/:siteId/users`,
`GET /sites/:siteId/contracts`, `GET /sites/:siteId/invoices`,
**`GET /materials`**. (`GET /users/technicians` ve `GET /users/me/units`
pagination KULLANMAZ — düz dizi döner, Bölüm 6.4.)

- **`cursor` opaktır.** Base64url kodlu `createdAt|id` çiftidir ama bu
  **implementasyon detayıdır**; frontend `cursor` string'ini **parse
  etmemeli, içeriğine göre dallanmamalı**, yalnız aynen bir sonraki isteğe
  geçirmelidir.
- **Filtre değişince cursor sıfırlanmalıdır.** `cursor` yalnız
  `(createdAt,id)` konumu taşır, aktif filtreleri (status/siteId/vb.)
  hatırlamaz — backend'de filtre-cursor tutarlılık kontrolü **yoktur**.
  Kullanıcı bir filtreyi değiştirdiğinde frontend eski `cursor`'ı **atmalı**,
  ilk sayfadan (cursor'sız) yeniden başlamalıdır.
- **Varsayılan limit 20, maksimum 100** (tüm liste DTO'larında sabit).
- **`totalCount` YOKTUR.** Sayfa numaralı UI (ör. "1/12") kurgulanamaz;
  yalnız "daha fazla yükle" / sonsuz kaydırma desenleri desteklenir.
- Geçersiz cursor → **422 `VALIDATION_ERROR`**.
- Sıralama tüm uçlarda `createdAt DESC, id DESC` (en yeni önce).

---

## 8. Ticket ve assignment workflow — yalnız erişilebilir HTTP yolları

**Ticket status'ları:** `OPEN, TRIAGED, ASSIGNED, ACCEPTED, REJECTED,
EN_ROUTE, ARRIVED, IN_PROGRESS, WAITING_MATERIAL, COMPLETED, CLOSED,
CANCELLED`.

### `POST /tickets/:id/status` — yalnız TRIAGED ve CLOSED

Bu **genel** ticket ucu, backend'de **yalnız iki** doğrudan geçişi kabul
eder:

| From | To | Kim |
|---|---|---|
| `OPEN` | `TRIAGED` | OPERATIONS |
| `COMPLETED` | `CLOSED` | OPERATIONS |

`ChangeTicketStatusDto.toStatus` **DTO seviyesinde** `"TRIAGED"|"CLOSED"`
dışında bir değeri kabul etmez (422). **Diğer tüm ticket durum
değişiklikleri assignment uçlarından yürür**, aşağıdaki tabloda:

| Ticket geçişi | Gerçek HTTP çağrısı | Kim |
|---|---|---|
| `OPEN→CANCELLED`, `TRIAGED→CANCELLED` | `POST /tickets/:id/cancel` | RESIDENT/SM/OP (duruma göre) |
| `TRIAGED→ASSIGNED`, `REJECTED→ASSIGNED` | `POST /tickets/:ticketId/assignments` | OPERATIONS |
| `ASSIGNED→ACCEPTED` | `POST /assignments/:id/accept` | TECHNICIAN |
| `ASSIGNED→REJECTED` | `POST /assignments/:id/reject` | TECHNICIAN |
| `ASSIGNED→CANCELLED` | `POST /assignments/:id/cancel` | OPERATIONS |
| `ACCEPTED→EN_ROUTE` | `POST /assignments/:id/status {event:"EN_ROUTE"}` | TECHNICIAN |
| `EN_ROUTE→ARRIVED` | `{event:"ARRIVED"}` | TECHNICIAN |
| `ARRIVED→IN_PROGRESS` | `{event:"START"}` | TECHNICIAN |
| `IN_PROGRESS→WAITING_MATERIAL` | `{event:"WAIT_MATERIAL"}` | TECHNICIAN, OPERATIONS |
| `WAITING_MATERIAL→IN_PROGRESS` | `{event:"RESUME"}` | TECHNICIAN, OPERATIONS |
| `IN_PROGRESS→COMPLETED` | `{event:"COMPLETE"}` | TECHNICIAN |

**Diğer yoldan denenirse** (ör. `POST /tickets/:id/status {toStatus:"ASSIGNED"}`)
**409 `TICKET_INVALID_STATUS_TRANSITION`** döner — bu bir hata değil, yanlış
uç kullanımıdır; frontend her ekranda **doğru uç/duruma göre doğru buton**
göstermelidir (Bölüm 3'teki rol matrisiyle birlikte).

### Reopen — UYGULANMAMIŞ, frontend aksiyonu olarak GÖSTERİLMEZ

`COMPLETED→IN_PROGRESS` (reopen) state machine tablosunda **tanımlı
görünse de**, hem genel ticket ucunun (`TicketDirectTransitionPolicy`
allowlist) hem de assignment workflow'unun izin verdiği bir yol
**değildir** — hiçbir HTTP çağrısıyla bu geçiş fiilen tetiklenemez (E2E
kanıtı: `assignments.e2e-spec.ts:329` "COMPLETED->IN_PROGRESS (reopen)
karar #2 geregi genel uctan reddedilir (409)"). **Frontend'de "işi yeniden
aç" gibi bir aksiyon eklenmemelidir** — böyle bir buton kullanıcıya 409
döndürür.

### Terminal durumlar

`CLOSED` ve `CANCELLED` — çıkış geçişi yoktur.

---

## 9. Attachment sözleşmesi

- **İzin verilen MIME'ler:** yalnız `image/jpeg`, `image/png`, `image/webp`
  (PDF/belge **UYGULANMAMIŞ**).
- **Magic-byte kontrolü:** sunucu dosyanın gerçek baytlarını okuyup
  algılanan tipi beyan edilen `Content-Type` ile karşılaştırır; uyuşmazsa
  **415 `ATTACHMENT_UNSUPPORTED_TYPE`** — yalnız uzantı/`Content-Type`
  header'ına güvenmek yetmez, frontend dosya seçici kısıtı (`accept="image/*"`)
  bunu **garanti etmez**, sunucu son sözü söyler.
- **Boyut:** 10 MB üst sınır (Bölüm 2).
- **Download Bearer ile binary'dir, signed URL DEĞİLDİR.**
  `GET /attachments/:id/download` her istekte
  `Authorization: Bearer <token>` header'ı gerektirir ve doğrudan dosya
  baytlarını stream eder.
- **Doğrudan `<img src="...">` KULLANILAMAZ.** Tarayıcı `<img>` etiketi
  özel header (Authorization) gönderemez; doğrudan URL verilirse istek
  401 ile döner ve görsel yüklenmez.
- **Gerekli desen:** `fetch(url, {headers:{Authorization:...}})` →
  `response.blob()` → `URL.createObjectURL(blob)` → bu object URL'i
  `<img src>`'e ata; kullanım bitince `URL.revokeObjectURL()` ile bellek
  serbest bırakılmalı. (Bu bir gerçek/kısıt tespitidir — belirli bir
  kütüphane/hook önerisi **değildir**, Bölüm 1 kapsam dışı.)
- Response `Content-Disposition: attachment; ...` header'ı taşır — tarayıcı
  varsayılan davranışı "indir"dir; galeri/inline önizleme için frontend
  object URL yaklaşımını kullanmak zorundadır.

---

## 10. Optimistic locking

- `PATCH /tickets/:id` isteğinde **`version` alanı zorunludur**
  (`UpdateTicketDto.version: number`) — DTO seviyesinde eksikse 422.
- Sunucudaki mevcut `version` ile eşleşmezse (başka biri araya girip
  güncellemişse) **409 `CONCURRENT_MODIFICATION`** döner; hiçbir alan
  yazılmaz.
- **Frontend akışı:** 409 alındığında (a) kaynağı **yeniden fetch etmeli**
  (`GET /tickets/:id`, taze `version` dahil), (b) **kullanıcının forma
  girdiği değerleri KAYBETMEMELİDİR** — yalnız sunucudaki güncel değerleri
  gösterip kullanıcıya "bu kayıt değişti, tekrar dener misiniz" gibi bir
  seçenek sunmalı, kullanıcının kendi girdiği metni bir yere (yerel state)
  saklayıp yeniden gönderim için hazır tutmalıdır. Backend bu davranışı
  **dayatmaz**; bu bir UX gerekliliğidir, veri kaybını önlemek frontend
  sorumluluğundadır.
- Diğer PATCH/durum uçlarında (`contracts`, `invoices`, assignment
  status/materials) `version` alanı **yoktur** — eşzamanlılık kontrolü
  DB satır kilidiyle (`FOR UPDATE`) sunucu içinde yapılır, frontend'in ek
  bir alan göndermesi gerekmez.

---

## 11. Uniform 404 ve IDOR

**Frontend, "kaynak yok" ile "kaynağa erişim yetkin yok" arasında HİÇBİR
AYRIM YAPMAMALIDIR** — backend bu ikisini kasıtlı olarak aynı **404** yanıtına
eşler (varlık sızdırmama / IDOR koruması):

- Başka sitenin `siteId`'si → 404 `SITE_NOT_FOUND` (403 değil)
- Başkasının ticket'ı → 404 `TICKET_NOT_FOUND`
- Başka teknisyenin assignment'ı → 404 `ASSIGNMENT_NOT_FOUND`
- Erişilemeyen attachment (yok/silinmiş/ticket'a erişim yok — üçü de aynı) →
  404 `ATTACHMENT_NOT_FOUND`
- Site dışı unit → 404 `UNIT_NOT_FOUND`

**403** yalnız iki dar durumda görülür: (a) rol tamamen yanlış
(`RolesGuard` — ör. TECHNICIAN `GET /tickets` çağırırsa), (b) kaynağı
**görebiliyor** ama belirli bir **işlemi yapamıyor** (ör.
`TICKET_UPDATE_FORBIDDEN`, `TICKET_TRANSITION_FORBIDDEN`,
`ATTACHMENT_UPLOAD_NOT_ALLOWED`).

**Sonuç:** frontend hata mesajlarında "bu kayıt bulunamadı" ile "bu kayda
erişiminiz yok" ifadelerini **birleştirmelidir** (aynı 404 için aynı genel
mesaj) — ayrı bir kod yolu yazmak, olmayan bir ayrımı simüle etmeye
çalışmak anlamına gelir ve backend davranışıyla tutarsız kalır.

---

## 12. Frontend'in yeniden uygulamaması gereken backend kuralları

Aşağıdakilerin **tek otoritesi backend'dir**; frontend en fazla UX için ön
kontrol (buton gizleme, format uyarısı) yapabilir, **asla nihai karar
vermemelidir**:

1. **State transition doğruluğu** — Bölüm 8'deki tüm geçiş tabloları.
2. **`siteId` türetme** — ticket create'te `siteId` client'tan gelmez.
3. **SLA hesabı** (`slaTargetAt`) — yalnız sunucuda, ticket oluşturma
   anındaki aktif sözleşmeden hesaplanır.
4. **Entitlement** ("aktif sözleşme var mı") — yalnız ticket create'te
   kontrol edilir; frontend sözleşme durumuna bakarak login veya devam eden
   iş akışlarını engellememelidir.
5. **Assignment-ticket eşleşmesi** (`ATTACHMENT_ASSIGNMENT_MISMATCH`) — DB
   composite FK + servis kontrolü.
6. **Decimal aritmetiği** — `totalPrice = quantity × unitPrice` backend'de
   Decimal ile hesaplanır (ROUND_HALF_UP, 2 hane); frontend bu çarpımı
   **kendi tarafında yeniden hesaplayıp göndermemeli**, yalnız backend'in
   döndürdüğü string'i göstermelidir.
7. **Contract/invoice tarih ve overlap kuralları.**
8. **Kaynak sahipliği ve uniform 404** (Bölüm 11).
9. **Optimistic locking** (Bölüm 10).
10. **OTP/token yaşam döngüsü** — deneme sayacı, cooldown, rotation, reuse
    tespiti tamamen backend'dedir; frontend yalnız hata kodlarına göre UI
    gösterir.

---

## 13. Uygulanmamış veya sınırlı özellikler

| Özellik | Durum |
|---|---|
| Swagger/OpenAPI | **UYGULANMAMIŞ** — `@nestjs/swagger` yok, `main.ts`'te kurulum yok. Tip sözleşmesi DTO dosyaları + bu belgedir. |
| Notification HTTP endpoint'i | **UYGULANMAMIŞ** — bildirimler tamamen backend içi outbox→dispatcher→delivery pipeline'ıdır; frontend'in erişebileceği hiçbir uç yoktur. |
| WebSocket/SSE (realtime) | **UYGULANMAMIŞ** — güncel veri için yalnız normal GET ile yeniden sorgulama (polling) mümkündür. |
| Gerçek SMS provider | **UYGULANMAMIŞ** — yalnız `MockSmsProvider` (log) ve development `DevInboxSmsProvider` vardır; `SMS_PROVIDER=external` env doğrulamasında **her ortamda** reddedilir. Production'da bugün gerçek SMS çıkmaz. |
| S3/harici storage | **UYGULANMAMIŞ** — yalnız `LocalStorageProvider`; `STORAGE_PROVIDER=s3` fail-fast ile reddedilir. |
| Assignment GEÇMİŞİ listesi | **UYGULANMAMIŞ** — `GET /tickets/:id/assignments` (tam liste) yoktur; yalnız `GET /tickets/:ticketId/assignments/current` (tek, güncel kayıt) vardır (Bölüm 6.7). |
| Tekil contract/invoice detay ucu | **UYGULANMAMIŞ** — `GET /contracts/:id`, `GET /invoices/:id` yoktur; yalnız liste uçlarından (`GET /sites/:siteId/contracts` vb.) filtrelenerek bulunabilir. |
| Genel kullanıcı arama (`GET /users`) | **UYGULANMAMIŞ** — yalnız dar `GET /users/technicians` (OPERATIONS) ve site-scoped `GET /sites/:siteId/users` vardır. |
| Material CRUD | **UYGULANMAMIŞ** — `GET /materials` salt-okunurdur; oluşturma/güncelleme/pasifleştirme ucu yoktur. |
| Signed URL / `GET /attachments/:id/url` | **UYGULANMAMIŞ** (architecture.md'nin tarihsel tasarımıdır) — yerine Bearer'lı stream download vardır (Bölüm 9). |
| `PLATFORM_ADMIN` rolü | **UYGULANMAMIŞ** (MVP kararı). |
| Reopen (`COMPLETED→IN_PROGRESS`) | **UYGULANMAMIŞ** (fiilen erişilemez — Bölüm 8). |

---

## 14. İlk vertical slice API sırası

Aşağıdaki sıra, backend'de **E2E testle kanıtlanmış** ve tüm ID'lerin
**yalnız API keşif uçlarından** elde edildiği tam akıştır (kanıt:
`test/e2e/discovery.e2e-spec.ts` "vertical slice discovery varyantı").

| # | Adım | Çağrı | Not |
|---|---|---|---|
| 1 | Resident login | `POST /auth/otp/request` → (dev) `GET /dev/sms/:phone/last-otp` → `POST /auth/otp/verify` | `accessToken` alınır |
| 2 | Unit keşfi | `GET /users/me/units` | `unitId` buradan alınır |
| 3 | Ticket oluştur | `POST /tickets { facilityId: unitId, title, description, category }` | `status:"OPEN"`, `id`/`code` döner |
| 4 | Operations ticket'ı görür | `GET /tickets?status=OPEN` (OPS token) | listede `ticketId` görünür |
| 5 | Triage | `POST /tickets/:id/status { toStatus:"TRIAGED" }` | ticket `TRIAGED` |
| 6 | Teknisyen keşfi | `GET /users/technicians` | `technicianId` buradan seçilir |
| 7 | Atama | `POST /tickets/:ticketId/assignments { technicianId }` | `assignmentId` döner, ticket `ASSIGNED` |
| 8 | Technician kendi işini bulur | `GET /assignments/my` (TECH token) | `assignmentId` doğrulanır |
| 9 | Kabul | `POST /assignments/:id/accept` | ticket `ACCEPTED` |
| 10 | Yola çıktı | `POST /assignments/:id/status {event:"EN_ROUTE"}` | ticket `EN_ROUTE` |
| 11 | Vardı | `{event:"ARRIVED"}` | ticket `ARRIVED` |
| 12 | Başladı | `{event:"START"}` | ticket `IN_PROGRESS` |
| 13 | Malzeme keşfi | `GET /materials` | `materialId` buradan seçilir |
| 14 | Malzeme ekle | `POST /assignments/:id/materials {materialId, quantity, unitPrice, suppliedBy}` | `totalPrice` sunucudan gelir |
| 15 | Fotoğraf yükle | `POST /tickets/:ticketId/attachments` (multipart, `attachmentType:"AFTER_WORK"`, `assignmentId`) | 201 |
| 16 | Tamamla | `POST /assignments/:id/status {event:"COMPLETE", note?}` | ticket `COMPLETED`; bu andan sonra `GET .../assignments/current` **404 ASSIGNMENT_NOT_FOUND** döner (normal) |
| 17 | Operations kapatır | `POST /tickets/:id/status {toStatus:"CLOSED"}` | ticket `CLOSED` |
| 18 | Resident sonucu görür | `GET /tickets/:id` + `GET /tickets/:id/history` + `GET /tickets/:ticketId/attachments` → `GET /attachments/:id/download` | Resident assignment/malzeme detayını **göremez** — sonuç görünürlüğü ticket status/history/attachment düzeyindedir |

**Ön koşul (adım 3'ten önce):** sitede `status:"ACTIVE"` bir sözleşme
olmalıdır, aksi halde `POST /tickets` **409 `TICKET_SITE_CONTRACT_INACTIVE`**
döner. Bu belge kapsamında sözleşme oluşturma bir OPERATIONS ön-adımıdır
(Bölüm 6.10), vertical slice'ın kendisine dahil değildir.

---

## 15. Global frontend hata işleme tablosu

| HTTP Status | Tipik `code` | Önerilen genel davranış |
|---|---|---|
| **401** | `UNAUTHORIZED`, `AUTH_INVALID_OTP`\*, `AUTH_INVALID_REFRESH`\* | Erişim token'ını temizle; login akışına yönlendir. `AUTH_INVALID_REFRESH` özel olarak **tüm** oturumların kapandığı anlamına gelebilir (reuse detection) — kullanıcıya "oturumunuz sonlandı, tekrar giriş yapın" mesajı uygun. |
| **403** | `FORBIDDEN`, `TICKET_UPDATE_FORBIDDEN`, `TICKET_TRANSITION_FORBIDDEN`, `ATTACHMENT_UPLOAD_NOT_ALLOWED`, `USER_PROFILE_CHANGE_FORBIDDEN` | "Bu işlem için yetkiniz yok" genel mesajı; **retry mantıksız**, aksiyon UI'dan zaten gizlenmiş olmalıydı (Bölüm 3). |
| **404** | `*_NOT_FOUND` | "Kayıt bulunamadı" genel mesajı — Bölüm 11, "erişim yok" ile ayrım yapılmaz. Genellikle listeye geri yönlendirme uygun. |
| **409** | `*_CONFLICT`, `*_STATUS_UNCHANGED`, `*_INVALID_STATUS_TRANSITION`, `CONCURRENT_MODIFICATION`, `*_OVERLAP` | Sunucudan gelen `message`'ı göster; ilgili kaynağı **yeniden fetch et** (özellikle `CONCURRENT_MODIFICATION` — Bölüm 10). Retry'dan önce state yenilenmeli. |
| **413** | `VALIDATION_ERROR` (JSON body >100KB) veya `ATTACHMENT_TOO_LARGE` (dosya >10MB) | İki farklı kod aynı status'u paylaşır — `code` alanına bakılmadan yalnız status'a göre dallanmak **yanlış mesaj** verebilir; `code` ile ayırt et. |
| **415** | `ATTACHMENT_UNSUPPORTED_TYPE` | "Desteklenmeyen dosya türü" — yalnız jpeg/png/webp kabul edilir (Bölüm 9). |
| **422** | `VALIDATION_ERROR` ve tüm alan-bazlı domain hataları (ör. `TICKET_TRANSITION_REASON_REQUIRED`) | `error.details` class-validator mesaj dizisiyse form alanlarına eşle; değilse genel mesajı göster. |
| **429** | `AUTH_RATE_LIMITED` | "Çok fazla deneme, lütfen bekleyin" — sabit bir geri-sayım süresi backend'den **dönmez** (`Retry-After` header'ı kod incelemesinde görülmedi → BELİRSİZ); sabit bir bekleme UI'ı (ör. 60 sn) önerilir. |
| **500** | `INTERNAL_ERROR` | Genel "beklenmeyen hata" mesajı; `error.requestId`'yi teşhis için loglayın/gösterin (destek talebi bağlantısı için kullanılabilir). |
| **503** | (readiness dışında frontend'in normalde görmeyeceği bir status) | Yalnız health-check bağlamında beklenir; genel API çağrılarında görülmemelidir. |

\* `AUTH_INVALID_OTP` login formunda kalınarak ele alınmalı (401 olsa da
logout tetiklememeli — kullanıcı henüz login olmamış durumda).

---

## 16. Bilinen riskler ve belirsizlikler

### Doğrulanmış riskler (kod okumasıyla kanıtlı)

- **Ham `UserRow` response'ları** — `POST /sites/:siteId/residents`,
  `GET /sites/:siteId/users`, `PATCH /users/:id` uçlarında response mapper
  **yoktur**; `phoneNumber`, `tokenVersion`, `isActive`, `deletedAt` alanları
  ham döner (`user.repository.ts:11-22`). Frontend bu alanlara **iş
  mantığı bağlamamalı** (özellikle `tokenVersion` tamamen iç detaydır); ileride
  backend bir mapper eklerse bu alanlar sessizce kaybolabilir.
- **Ham `FacilityRow` response'ları** — tüm facilities uçlarında aynı durum
  (`deletedAt` dahil ham döner). Aynı risk geçerlidir.
- **`ASSIGNMENT_CONCURRENT_CONFLICT`** hata kodu tanımlıdır
  (`error-codes.constant.ts`) ama kod tabanında **hiçbir yerde
  fırlatılmaz** (ölü kod) — frontend bu kodu bekleyen bir case yazabilir
  ama pratikte tetiklenmeyecektir.
- **`MATERIAL_INACTIVE` → 409** (doğrulandı, `material-lookup.service.ts`).
- **429 için `Retry-After` header'ı** — kodda böyle bir header set edildiği
  görülmedi → **BELİRSİZ**, doğrulanmadan varsayılmamalı.
- **`x-request-id`'nin başarı yanıtlarında header olarak dönüp dönmediği** →
  **BELİRSİZ** (yalnız hata gövdesinde kesin doğrulanmış).
- **`SITE_MANAGER`'ın `PATCH /users/:id` üzerindeki tam kural seti**
  (`UserAccessPolicy.assertSiteManagerCanUpdateGlobalProfile` /
  `assertManagerCanAccessResident`) satır satır doğrulanmadı →
  **BELİRSİZ**; frontend bu uçta SM için "her zaman izinli" varsaymamalı,
  403/404 olasılığına karşı hata işleme eklemelidir.

### `docs/manual-acceptance.md` ile kod karşılaştırması

Bu inceleme kapsamında `manual-acceptance.md`'deki tüm HTTP status
iddiaları (POST durum/cancel/accept/status-event uçları için **201**,
PATCH uçları için **200**, deactivate uçları için **204** vb.) doğrudan
controller kaynak kodundaki `@HttpCode` dekoratörleri (veya bunların
**yokluğunda** NestJS'in POST=201/PATCH=200 varsayılanı) ile
**karşılaştırıldı ve çelişki bulunmadı**. Belirtilmesi gereken tek nokta:
manual-acceptance.md'deki 201 durumların çoğu **açık bir `@HttpCode`
dekoratöründen değil, NestJS'in POST için varsayılan 201 davranışından**
kaynaklanır (ör. `POST /tickets/:id/status`, `POST /assignments/:id/accept`)
— bu belgede (Bölüm 6) bu ayrım açıkça not edilmiştir ki frontend "201
her zaman explicit bir create" varsaymasın.

### Kapsam dışı belirsizlikler

- CORS `credentials:true` açık olsa da cookie-tabanlı bir akış
  **kurgulanmamıştır** (Bölüm 4) — ileride bir BFF/cookie-proxy eklenirse bu
  belge güncellenmelidir.
- Rate limit sayaçları **in-memory**'dir (`rate-limiter-flexible`,
  tek-instance varsayımı) — yatay ölçekte (birden fazla API instance)
  tutarlılığı bu incelemenin kapsamı dışındadır.

---

## 17. Handoff kabul kontrol listesi

Frontend ekibi entegrasyona başlamadan önce aşağıdakileri teyit etmelidir:

- [ ] `/api/v1` prefix'i ve Bearer header'ı tüm istemci çağrılarına
      uygulanmış.
- [ ] HTTP client, başarı yanıtlarında `{success,data}` zarfı **beklemiyor**
      (Bölüm 2).
- [ ] Hata işleme, tek tip zarfı (`error.code/message/requestId`) merkezi
      bir yerde parse ediyor (Bölüm 2, 15).
- [ ] Refresh çağrıları **serileştirilmiş** (aynı token ile paralel istek
      yok) — Bölüm 4.
- [ ] Login/refresh sonrası kullanıcı profili gerektiğinde `GET /auth/me`
      ile ayrıca çekiliyor (refresh yanıtında `user` yok) — Bölüm 4.
- [ ] Ticket oluşturma formu `facilityId`'yi **`GET /users/me/units`**'ten
      alıyor, sabit/varsayılan bir id kullanmıyor — Bölüm 6.4, 14.
- [ ] Atama ekranı teknisyen listesini **`GET /users/technicians`**'tan
      dolduruyor — Bölüm 6.4.
- [ ] Malzeme ekleme formu `materialId`'yi **`GET /materials`**'tan
      dolduruyor, `quantity`/`unitPrice` **string** olarak gönderiyor —
      Bölüm 6.8, 2.
- [ ] OPERATIONS ekranında current-assignment gösterimi
      **`GET /tickets/:ticketId/assignments/current`**'ı kullanıyor ve
      404'ü "henüz atanmadı" olarak yorumluyor (hata banner'ı değil) —
      Bölüm 6.7.
- [ ] Attachment görüntüleme fetch+blob+object-URL deseniyle yapılıyor,
      doğrudan `<img src>` **kullanılmıyor** — Bölüm 9.
- [ ] `PATCH /tickets/:id` her zaman güncel `version`'ı gönderiyor;
      `CONCURRENT_MODIFICATION` sonrası kullanıcı verisi korunarak
      refetch yapılıyor — Bölüm 10.
- [ ] 404 ile 403 UI'da ayrı "sebep" metniyle **açıklanmıyor** (Bölüm 11).
- [ ] Cursor değerleri opak string olarak taşınıyor, parse edilmiyor;
      filtre değişince cursor sıfırlanıyor — Bölüm 7.
- [ ] Reopen, signed-URL, teknisyen için genel ticket listesi gibi
      **uygulanmamış** davranışlar için hiçbir UI elemanı eklenmemiş —
      Bölüm 8, 9, 13.
- [ ] Decimal alanlar (`quantity`, `unitPrice`, `totalPrice`, `monthlyFee`,
      `amount`) frontend'de yeniden hesaplanmıyor, backend'in döndürdüğü
      string aynen gösteriliyor — Bölüm 2, 12.
- [ ] Ham `UserRow`/`FacilityRow` alanlarına (`tokenVersion`, `deletedAt`
      vb.) iş mantığı bağlanmamış — Bölüm 16.

---

*Bu belge frontend kodu, kütüphane/framework seçimi veya backend değişikliği
içermez. Sonraki adım, bu sözleşmelere göre ayrı bir frontend repository'de
uygulama geliştirmektir (bu görevin kapsamı dışında).*

# Frontend Enablement Planı — Minimal Keşif Endpointleri

**Amaç:** `docs/frontend-backend-facts.md` Bölüm 16/17'de tespit edilen dört
keşif engelini, mevcut domain modelini ve iş kurallarını DEĞİŞTİRMEDEN,
yalnız salt-okunur (read-only) uçlarla kaldırmak. Bu belge bir PLANDIR; kod
içermez ve onay beklemektedir.

**İlkeler (bağlayıcı):** yeni iş kuralı yok; migration yok (Bölüm 10'da
kanıtıyla); ham Prisma satırı response'a çıkmaz; `tokenVersion`, `deletedAt`,
`phoneNumber` (gerekmedikçe), `storageKey` gibi iç alanlar dönmez; tenant
izolasyonu ve uniform 404 korunur; cursor pagination yalnız gerçekten büyüyen
listede kullanılır; modül sınırları ve mevcut export desenleri
(dar servis export'u, repository sızdırmama) korunur.

---

## 1. Mevcut engeller ve kod kanıtları

| # | Engel | Kod kanıtı |
|---|---|---|
| 1 | RESIDENT kendi aktif unit/daire kimliklerini API'den öğrenemiyor. Ticket formu `facilityId` (unit id) istiyor. | `src/modules/auth/services/auth.service.ts` — `AuthService.me()` yalnız `{ id, role, fullName, memberships[{siteId, membershipRole}] }` döner; `ActiveMembership` unit içermez (`site-membership.repository.ts:15-18`). Veri modelde mevcut: `ResidentUnitAssignmentRepository.findActiveForUser()` (`resident-unit-assignment.repository.ts:17-27`) ama hiçbir endpoint'e bağlı değil. Facility uçları RESIDENT'a kapalı (`facilities.controller.ts` — tree yalnız SM+OP). |
| 2 | OPERATIONS atanabilir teknisyenleri listeleyemiyor. `POST /tickets/:ticketId/assignments` `technicianId` istiyor. | Kullanıcı listeleme yalnız site-üyelik bazlı (`GET /sites/:siteId/users`, `users.controller.ts:43-48`); teknisyenlerin site üyeliği yok. Sorgu altyapısı mevcut: `UserRepository.listActiveByRole()` (`user.repository.ts:113-118`, `@@index([role, isActive])` kullanır) ama yalnız bildirim fan-out'u için ve sadece `{id, phoneNumber}` seçiyor. E2E bile teknisyeni DB'ye doğrudan yazıyor (`test/e2e/assignments.e2e-spec.ts` support). |
| 3 | TECHNICIAN/OPERATIONS aktif material kataloğunu listeleyemiyor. `AddMaterialDto.materialId` istiyor. | `MaterialsModule` controller'sız (`materials.module.ts`); `MaterialRepository` tek metotlu lookup (`material.repository.ts` — yalnız `findAliveById`, dosya yorumu: "material katalog CRUD/listeleme endpoint'i yok"). E2E kanıtı: `assignments.e2e-spec.ts:223` — materyal `prisma.material.create` ile doğrudan DB'ye yazılıyor. |
| 4 | OPERATIONS bir ticket'ın mevcut (current) assignment'ını sonradan keşfedemiyor; reassign/cancel için assignment id yalnız create yanıtından biliniyor. | `GET /tickets/:id` yanıtı `TicketRow`'dur, assignment içermez (`ticket.repository.ts:12-34`, `ticket.mapper.ts`); `GET /tickets/:id/assignments` yok (`tickets.controller.ts`); `GET /assignments/my` yalnız TECHNICIAN (`assignments.controller.ts:80-88`). Veri modelde mevcut ve tekil: `uq_assignments_one_current_per_ticket ON assignments (ticket_id) WHERE is_current = true` (`prisma/migrations/20260710000100_custom_constraints/migration.sql:11-13`); mevcut okuma yolu yalnız kilitli `findCurrentForUpdate` (`assignment.repository.ts:95-123`, transaction-only). |

---

## 2. Önerilen minimal endpointler

Toplam **4 yeni salt-okunur endpoint**; hepsi mevcut modüllerin içinde, hepsi
mevcut guard zincirini (JwtAuthGuard + RolesGuard global) kullanır. CRUD yok,
yazma yok, yeni iş kuralı yok.

| # | Endpoint | Kaldırdığı engel |
|---|---|---|
| E1 | `GET /users/me/units` | #1 — resident'ın aktif unit'leri |
| E2 | `GET /users/technicians` | #2 — atanabilir teknisyen listesi |
| E3 | `GET /materials` | #3 — aktif material kataloğu |
| E4 | `GET /tickets/:ticketId/assignments/current` | #4 — ticket'ın current assignment'ı |

---

## 3. Endpoint ayrıntıları

### E1 — `GET /users/me/units`

- **Method + route:** `GET /api/v1/users/me/units`
- **İzinli roller:** `@Roles(RESIDENT)` — engel yalnız resident akışında;
  diğer rollerin unit assignment'ı zaten yoktur (403 FORBIDDEN alırlar).
- **Request/query DTO:** yok (kimlik `@CurrentUser`'dan; parametre kabul
  edilmez — başkasının unit'i sorgulanamaz, IDOR yüzeyi hiç açılmaz).
- **Response DTO (`MyUnitResponse[]`, açık alan listesi):**
  ```
  [{ id,            // ResidentUnitAssignment.id
     unitId,
     isPrimary,
     startsAt,      // ISO-8601
     unit: { id, name, code, siteId } }]   // Facility özeti; SITE-dışı UNIT'te siteId her zaman dolu
  ```
  Dışarıda kalan iç alanlar: `isActive` (liste zaten yalnız aktifleri döner),
  `endsAt`, `userId`, facility'nin `parentId/isActive/deletedAt/createdAt/updatedAt` alanları.
- **Pagination:** YOK. Tek-aktif-unit varsayımı kodda mevcut
  (`resident-unit-assignment.repository.ts` yorum: "tek-aktif-unit varsayimi");
  dizi dönmesi ileriye dönük güvenlik içindir, kardinalite ~1'dir. Facility
  tree emsali gibi pagination'sız.
- **Tenant/kaynak kontrolü:** sorgu `WHERE userId = actor.id AND isActive = true`
  ile sınırlıdır; başka filtre/parametre yoktur. `@@index([userId, isActive])`
  mevcut (`schema.prisma:209`).
- **Uniform 404:** gerekmez — kaynak daima "kendi kayıtların"dır; kayıt yoksa
  **200 `[]`** döner (404 değil; boş liste hata değildir, `GET /tickets`
  emsali).
- **Beklenen hata kodları:** 401 `UNAUTHORIZED`, 403 `FORBIDDEN` (rol dışı).
- **Katmanlar:**
  - Controller: `src/modules/users/users.controller.ts` — yeni handler
    (statik `me/units` route'u; controller'da param route'lardan önce
    bildirilir — bugün `GET /users/:id` yok, gelecekte eklenirse çakışmasın).
  - Service: `UsersService.listMyUnits(actor)` (yeni metot).
  - Repository: `ResidentUnitAssignmentRepository.listActiveForUserWithUnit(client, userId)`
    (yeni salt-okunur metot; Prisma `include: { unit: { select: ... } }` —
    aynı repository zaten `findScopedForUpdate` içinde facilities'e join
    yapıyor, modül sınırı ihlali yok; MembershipsModule bu repository'yi
    zaten export ediyor).
  - Mapper: `src/modules/users/mappers/my-unit.mapper.ts` (yeni) —
    `toMyUnitResponse`.

### E2 — `GET /users/technicians`

- **Method + route:** `GET /api/v1/users/technicians`
- **İzinli roller:** `@Roles(OPERATIONS)` — atama yetkisi kimdeyse liste onda
  (`POST /tickets/:ticketId/assignments` OPERATIONS-only).
- **Request/query DTO:** yok (filtre yok; rol/aktiflik sabittir, client'tan
  rol parametresi ALINMAZ — anonim "kullanıcı arama" ucuna dönüşmez).
- **Response DTO (`TechnicianSummaryResponse[]`):**
  ```
  [{ id, firstName, lastName }]
  ```
  **Veri minimizasyonu:** `phoneNumber` bilinçli olarak DÖNMEZ (atama ekranı
  için gerekmez; mevcut `UserContactRow`'un telefonu yalnız SMS fan-out
  içindir). `tokenVersion/isActive/deletedAt/createdAt` dönmez.
- **Pagination:** YOK. Teknisyenler şirket personelidir (site üyeliği yok,
  OPERATIONS tarafından oluşturulur); kardinalite küçük ve sınırlıdır.
  Sıralama: `lastName asc, firstName asc, id asc` (deterministik). Kataloğun
  beklenmedik büyümesine karşı sabit üst sınır (ör. `take: 500`) repository
  içinde uygulanır ve yorumla belgelenir — cursor karmaşıklığı eklenmez
  ("pagination yalnız gerçekten gerekli listelerde" ilkesi).
- **Tenant/kaynak kontrolü:** tenant kapsamı yoktur (teknisyenler cross-site
  şirket kaynağıdır — `SiteScopeGuard`'ın OPERATIONS istisnasıyla tutarlı,
  `site-scope.guard.ts:38-40`). Sorgu sabit:
  `role='TECHNICIAN' AND isActive=true AND deletedAt IS NULL`
  (implementation-overrides.md §3'ün "OPERATIONS için açıkça adlandırılmış
  metot" deseni; `@@index([role, isActive])` mevcut).
- **Uniform 404:** gerekmez; boş katalog **200 `[]`**.
- **Beklenen hata kodları:** 401 `UNAUTHORIZED`, 403 `FORBIDDEN`.
- **Katmanlar:**
  - Controller: `users.controller.ts` — yeni handler (statik route).
  - Service: `UsersService.listActiveTechnicians()` (yeni metot).
  - Repository: `UserRepository.listActiveTechnicianSummaries(client)` (yeni,
    açıkça adlandırılmış metot; `listActiveByRole` DEĞİŞTİRİLMEZ — onun
    seçimi/sözleşmesi bildirim pipeline'ına aittir).
  - Mapper: `src/modules/users/mappers/technician-summary.mapper.ts` (yeni).

### E3 — `GET /materials`

- **Method + route:** `GET /api/v1/materials`
- **İzinli roller:** `@Roles(TECHNICIAN, OPERATIONS)` — malzemeyi bu iki rol
  ekleyebiliyor (`assignments.controller.ts:90-100`); katalog da onlara açık.
- **Request/query DTO (`ListMaterialsQueryDto`):** `cursor?`, `limit?`
  (1-100, default 20) — mevcut liste DTO'larının birebir deseni
  (`ListAttachmentsQueryDto` emsali). Başka filtre yok; `isActive` parametresi
  ALINMAZ (yalnız aktif döner, kural sabittir).
- **Response DTO:**
  ```
  { items: [{ id, name, code, unit, description, createdAt }], nextCursor }
  ```
  `isActive` (daima true), `updatedAt`, `deletedAt` dönmez. `createdAt`
  cursor'ın dayandığı sıralama alanı olduğu için şeffaflık adına dahildir
  (TicketRow emsali).
- **Pagination:** VAR — cursor (`createdAt DESC, id DESC`, `buildPage`).
  Gerekçe: katalog zamanla büyüyen tek listedir (teknisyen listesi ve unit
  listesi gibi doğal olarak sınırlı değildir); mevcut util değişmeden
  kullanılır.
- **Tenant/kaynak kontrolü:** tenant kapsamı yok — `Material` modeli site'a
  bağlı değildir (`schema.prisma:372-386`), şirket kataloğudur. Sorgu sabit:
  `isActive=true AND deletedAt IS NULL`.
- **Uniform 404:** gerekmez; boş katalog **200 `{ items: [], nextCursor: null }`**.
- **Beklenen hata kodları:** 401, 403, 422 `VALIDATION_ERROR` (geçersiz
  cursor/limit).
- **Katmanlar:**
  - Controller: `src/modules/materials/materials.controller.ts` (YENİ dosya;
    `MaterialsModule.controllers`'a eklenir).
  - Service: `MaterialLookupService.listActiveCatalog(query)` (mevcut
    servise yeni salt-okunur metot; modülün tek export'u olmaya devam eder —
    `materials.module.ts` deseni korunur, yeni servis sınıfı açılmaz).
  - Repository: `MaterialRepository.listActive(client, { cursor, limit })`
    (yeni metot; `ticket.repository.list`'in Prisma-where cursor deseniyle).
  - Mapper: `src/modules/materials/mappers/material.mapper.ts` (yeni) —
    `toMaterialResponse` (açık alan listesi).
  - DTO: `src/modules/materials/dto/list-materials-query.dto.ts` (yeni).
  - Not: `materials.isActive` üzerinde ayrı index yok; katalog kardinalitesi
    düşük olduğundan sorun değildir, migration GEREKTİRMEZ (Bölüm 10).

### E4 — `GET /tickets/:ticketId/assignments/current`

- **Method + route:** `GET /api/v1/tickets/:ticketId/assignments/current`
  (route `AssignmentsController`'da — `POST tickets/:ticketId/assignments`
  ile aynı controller/prefix deseni; assignment verisinin sahibi
  AssignmentsModule'dur).
- **İzinli roller:** `@Roles(OPERATIONS)`. Gerekçe: tespit edilen engel
  yalnız OPERATIONS'ın reassign/cancel akışıdır; TECHNICIAN kendi atamasını
  `GET /assignments/my`'dan zaten görür; RESIDENT/SITE_MANAGER'a teknisyen
  kimliği göstermek yeni bir ürün/PII kararıdır ve "yeni iş kuralı üretme"
  yasağı gereği bu plana ALINMAMIŞTIR (ileride ayrı karar).
- **Request/query DTO:** yok.
- **Response DTO:** mevcut `toAssignmentResponse` çıktısı birebir
  (`assignment.mapper.ts` — id, ticketId, technicianId, assignedByUserId,
  assignmentStatus, tüm zaman damgaları, rejectionReason, resolutionNote,
  isCurrent, createdAt, updatedAt). Yeni alan/mapper üretilmez.
- **Pagination:** yok (partial unique index gereği en fazla 1 satır —
  `uq_assignments_one_current_per_ticket`).
- **Tenant/kaynak kontrolü:** önce `TicketReadAccessService.assertReadableAndGet(actor, ticketId)`
  (TicketsModule'un AttachmentsModule için kurduğu dar export aynen yeniden
  kullanılır — `ticket-read-access.service.ts`; OPERATIONS için koşulsuz ama
  ticket'ın var/silinmemiş olduğunu doğrular); sonra yeni salt-okunur
  `findCurrentByTicketId`.
- **Uniform 404:**
  - Ticket yok/soft-deleted → **404 `TICKET_NOT_FOUND`** (mevcut davranış).
  - Ticket var ama current assignment yok (OPEN/TRIAGED/CANCELLED/CLOSED ya
    da REJECTED-sonrası) → **404 `ASSIGNMENT_NOT_FOUND`**. Gerekçe: "boş
    kaynak = 404" tekil-kaynak deseni (`dev-sms-inbox.controller.ts` emsali);
    200+null zarfı projede emsalsizdir. Frontend bu 404'ü "henüz atanmamış"
    olarak yorumlar — ticket status'u zaten hangi durumda olduğunu söyler.
- **Beklenen hata kodları:** 401, 403 (rol), 404 `TICKET_NOT_FOUND`,
  404 `ASSIGNMENT_NOT_FOUND`.
- **Katmanlar:**
  - Controller: `assignments.controller.ts` — yeni handler.
  - Service: `AssignmentService.getCurrentForTicket(actor, ticketId)` (yeni
    metot; salt-okunur uçların evi — `assignment.service.ts` deseni).
  - Repository: `AssignmentRepository.findCurrentByTicketId(client, ticketId)`
    (yeni; `findCurrentForUpdate`'in **FOR UPDATE'siz**, Prisma `findFirst`
    karşılığı — kilitli metot transaction dışında KULLANILMAZ).
  - Mapper: mevcut `toAssignmentResponse` (değişiklik yok).

---

## 4. Seçenek karşılaştırması: `/auth/me` genişletme vs ayrı resident endpoint'i

| Kriter | A) `/auth/me`'ye `units[]` ekle | B) Ayrı `GET /users/me/units` (önerilen) |
|---|---|---|
| Sözleşme etkisi | TÜM rollerin kullandığı auth sözleşmesi değişir; alan ekleme geriye uyumlu olsa da `/auth/me` her oturum açılışında çağrılır ve tüm istemci tiplerini etkiler | Mevcut hiçbir yanıt değişmez; yalnız ihtiyaç anında (ticket formu) çağrılır |
| Modül sınırı | `AuthService.me` unit verisine bağımlı olur; auth modülü bugün yalnız `MembershipQueryService` tüketiyor (`auth.service.ts`) — auth yüzeyini domain verisiyle şişirir | Unit verisi kendi domain'inde (users/memberships) kalır; auth dokunulmaz |
| Maliyet | Her `/auth/me` çağrısında ek sorgu — rol fark etmeksizin (OPERATIONS/TECHNICIAN için daima boş sonuç) | Sorgu yalnız RESIDENT ve yalnız gerektiğinde |
| Test etkisi | `auth.service.spec.ts` + `auth.e2e-spec.ts` mevcut senaryoları güncellenir | Yalnız yeni testler; mevcutlara dokunulmaz |
| Frontend ergonomisi | Tek çağrı (login sonrası her şey elde) | Ticket formu öncesi +1 çağrı |
| Faz disiplini | Auth Faz 2'de kapanmış hassas bir yüzey | Users Faz 3 yüzeyine ekleme |

**Sonuç:** B. Tek artısı "tek çağrı" olan A, kapanmış auth sözleşmesini ve
`AuthService` bağımlılık grafiğini değiştirme maliyetini haklı çıkarmıyor.

---

## 5. Seçenek karşılaştırması: ticket response'una current assignment gömme vs ayrı endpoint

| Kriter | A) `GET /tickets/:id` yanıtına `currentAssignment` göm | B) Ayrı `GET /tickets/:ticketId/assignments/current` (önerilen) |
|---|---|---|
| Sözleşme etkisi | `toTicketResponse` 6 uçtan dönüyor (create, list, findById, update, changeStatus, cancel — `tickets.controller.ts`); hepsi etkilenir, liste ucunda N+1 veya toplu join gerekir | Sıfır mevcut sözleşme değişikliği |
| Repository etkisi | `TicketRow` üreten TÜM yollar değişmeli — Prisma sorguları VE `findByIdForUpdate`'in raw SQL'i (`ticket.repository.ts:143-173`) aynı satır şeklini paylaşıyor; raw SQL'e join eklemek kilit yolunu karmaşıklaştırır | Tek yeni salt-okunur repository metodu |
| Rol/PII kararı | Alan RESIDENT/SITE_MANAGER/TECHNICIAN yanıtlarında da görünür → kime kırpılacağı YENİ iş kuralı gerektirir (mapper bugün yalnız `operationNote` kırpıyor) | Görünürlük `@Roles` ile açık ve dar (OPERATIONS) |
| Modül sınırı | TicketsModule assignment verisi okumak zorunda kalır — bugün bağımlılık tek yönlü Assignments→Tickets'tır (`assignments.module.ts` yorumu); tersine akış döngü riski yaratır | Assignment verisi sahibinde (AssignmentsModule) kalır |
| Test etkisi | Ticket unit/integration/E2E fixture'larının tamamında yanıt şekli değişir | Yalnız yeni testler |
| Frontend ergonomisi | Detay ekranı tek çağrı | Detay ekranında +1 çağrı (yalnız OPERATIONS ekranında) |

**Sonuç:** B. A seçeneği modül bağımlılık yönünü tersine çevirme ve yeni
PII-görünürlük kuralı üretme riskleri nedeniyle "mevcut pattern'leri koru /
yeni iş kuralı üretme" ilkeleriyle çelişiyor.

---

## 6. Önerilen nihai paket ve gerekçe

**E1 + E2 + E3 + E4, dördü de ayrı salt-okunur uç olarak** (Bölüm 3'teki
tasarımla). Ortak gerekçe:

1. Tamamı **additive** — hiçbir mevcut route, DTO, mapper, repository imzası
   değişmez; geriye dönük kırılma riski sıfıra yakın (Bölüm 10).
2. Her uç, verinin **sahibi modülde** yaşar; mevcut dar-export desenleri
   (`TicketReadAccessService`, `MaterialLookupService`) aynen yeniden
   kullanılır, hiçbir repository modül dışına yeni açılmaz.
3. Hepsi mevcut guard/policy/hata-zarfı düzenine oturur; yeni error code
   GEREKMEZ (mevcut `TICKET_NOT_FOUND`/`ASSIGNMENT_NOT_FOUND`/
   `VALIDATION_ERROR`/`FORBIDDEN` yeterli).
4. Veri minimizasyonu response DTO/mapper'larla garanti edilir (Bölüm 11).

---

## 7. Değiştirilecek ve eklenecek tam dosya listesi

**Yeni dosyalar (10):**

| Dosya | İçerik |
|---|---|
| `src/modules/users/mappers/my-unit.mapper.ts` | `MyUnitResponse` + `toMyUnitResponse` |
| `src/modules/users/mappers/technician-summary.mapper.ts` | `TechnicianSummaryResponse` + `toTechnicianSummaryResponse` |
| `src/modules/materials/materials.controller.ts` | E3 controller |
| `src/modules/materials/dto/list-materials-query.dto.ts` | cursor/limit query DTO |
| `src/modules/materials/mappers/material.mapper.ts` | `MaterialResponse` + `toMaterialResponse` |
| `src/modules/users/mappers/my-unit.mapper.spec.ts` | mapper unit testi |
| `src/modules/users/mappers/technician-summary.mapper.spec.ts` | mapper unit testi |
| `src/modules/materials/mappers/material.mapper.spec.ts` | mapper unit testi |
| `test/integration/discovery/` altında 1-2 spec | Bölüm 8'deki integration testleri |
| `test/e2e/discovery.e2e-spec.ts` | Bölüm 8'deki E2E senaryoları |

**Değiştirilecek dosyalar (8):**

| Dosya | Değişiklik |
|---|---|
| `src/modules/users/users.controller.ts` | `GET me/units` + `GET technicians` handler'ları (statik route'lar üstte) |
| `src/modules/users/services/users.service.ts` | `listMyUnits`, `listActiveTechnicians` |
| `src/modules/users/repositories/user.repository.ts` | `listActiveTechnicianSummaries` |
| `src/modules/memberships/repositories/resident-unit-assignment.repository.ts` | `listActiveForUserWithUnit` |
| `src/modules/materials/materials.module.ts` | `controllers: [MaterialsController]` kaydı |
| `src/modules/materials/services/material-lookup.service.ts` | `listActiveCatalog` |
| `src/modules/materials/repositories/material.repository.ts` | `listActive` |
| `src/modules/assignments/assignments.controller.ts` + `services/assignment.service.ts` + `repositories/assignment.repository.ts` | E4 handler + `getCurrentForTicket` + `findCurrentByTicketId` |

Değişmeyecek olanlar (bilinçli): `auth.*`, `ticket.mapper.ts`,
`ticket.repository.ts`, tüm DTO'lar, tüm state machine/policy dosyaları,
`prisma/schema.prisma`, migration'lar, `error-codes.constant.ts`.

---

## 8. Test planı

Mevcut araçlarla (Jest unit / Testcontainers integration / supertest+Testcontainers E2E — `package.json` script'leri); yeni araç yok.

**Unit (jest):**
- Mapper'lar: `toMyUnitResponse` / `toTechnicianSummaryResponse` /
  `toMaterialResponse` — iç alanların (`tokenVersion`, `phoneNumber`,
  `deletedAt`, `isActive`, `endsAt`, `userId`) çıktıda BULUNMADIĞININ negatif
  asserti (attachment mapper testi emsali).
- `UsersService.listMyUnits` / `listActiveTechnicians`,
  `MaterialLookupService.listActiveCatalog`,
  `AssignmentService.getCurrentForTicket` — mock repository ile: doğru
  filtre parametreleri, geçersiz cursor → 422, E4'te ticket-yok →
  `TICKET_NOT_FOUND`, current-yok → `ASSIGNMENT_NOT_FOUND`.

**Integration (Testcontainers, gerçek PostgreSQL):**
- `ResidentUnitAssignmentRepository.listActiveForUserWithUnit`: yalnız
  `isActive=true` ve yalnız ilgili user; pasifleştirilmiş assignment dönmez;
  unit alanları doğru join'lenir.
- `UserRepository.listActiveTechnicianSummaries`: `isActive=false`,
  `deletedAt != null` ve TECHNICIAN-dışı roller hariç; sıralama deterministik.
- `MaterialRepository.listActive`: pasif/silinmiş materyal dönmez; cursor
  sayfalaması `limit+1` ve sıralama sözleşmesine uyar.
- `AssignmentRepository.findCurrentByTicketId`: REASSIGNED sonrası yalnız
  yeni `isCurrent=true` satırı döner; COMPLETE sonrası (isCurrent=false) null.

**E2E (supertest, tam uygulama):**
1. RESIDENT `GET /users/me/units` → 200, yalnız kendi aktif unit'i; site-scoped
   pasifleştirme sonrası boş liste; OPERATIONS/TECHNICIAN çağırırsa 403.
2. OPERATIONS `GET /users/technicians` → 200; global pasifleştirilen teknisyen
   listeden düşer; RESIDENT/SITE_MANAGER/TECHNICIAN → 403; `phoneNumber`
   yanıtında YOK.
3. TECHNICIAN/OPERATIONS `GET /materials` → 200 + cursor akışı; pasif
   materyal görünmez; RESIDENT → 403; bozuk cursor → 422 `VALIDATION_ERROR`.
4. E4: atama öncesi → 404 `ASSIGNMENT_NOT_FOUND`; atama sonrası → 200 doğru
   assignment; reassign sonrası → yeni assignment; bilinmeyen ticket → 404
   `TICKET_NOT_FOUND`; TECHNICIAN/RESIDENT/SITE_MANAGER → 403.
5. Regresyon: `assignments.e2e-spec.ts:176` "tam mutlu yol" testinin DB'ye
   doğrudan yazdığı teknisyen/materyal adımlarının yeni uçlarla da
   keşfedilebildiği bir varyant (Bölüm 9 akışının kanıtı).

---

## 9. İlk vertical slice bu değişikliklerden sonra

(`docs/frontend-backend-facts.md` Bölüm 17'deki ⚠ işaretli üç boşluk kapanır.)

1. Resident login (OTP + dev inbox) — değişmedi.
2. **YENİ:** Resident `GET /users/me/units` → `unitId`'yi alır →
   `POST /tickets { facilityId: unitId, ... }`.
3. Operations `GET /tickets?status=OPEN` → ticket'ı görür →
   `POST /tickets/:id/status { toStatus: TRIAGED }`.
4. **YENİ:** Operations `GET /users/technicians` → `technicianId` seçer →
   `POST /tickets/:ticketId/assignments`.
5. Technician `GET /assignments/my` → accept → EN_ROUTE/ARRIVED/START.
6. **YENİ:** Technician `GET /materials` → `materialId` seçer →
   `POST /assignments/:id/materials`.
7. Fotoğraf: `POST /tickets/:ticketId/attachments` (assignmentId elinde) —
   değişmedi.
8. COMPLETE → **YENİ:** Operations ticket detayında
   `GET /tickets/:id/assignments/current` ile atamayı/teknisyeni görür →
   `POST /tickets/:id/status { toStatus: CLOSED }`.
9. Resident `GET /tickets/:id` + history + attachments — değişmedi.

Kalan bilinen dış kısıt: production'da gerçek SMS provider'ının olmaması
(login akışı yalnız development'ta uçtan uca) — bu planın kapsamı dışındadır.

---

## 10. Migration ve geriye dönük uyumluluk

**Migration: GEREKMİYOR.** Kanıt:
- E1: `resident_unit_assignments @@index([userId, isActive])` mevcut
  (`schema.prisma:209`).
- E2: `users @@index([role, isActive])` mevcut (`user.repository.ts:111-112`
  yorumu ve şema).
- E3: `materials` küçük katalog; `deletedAt IS NULL AND isActive=true` taraması
  index'siz kabul edilebilir — index ihtiyacı doğarsa ayrı, bağımsız bir
  migration olarak ertelenir (bu plan önermez).
- E4: `uq_assignments_one_current_per_ticket (ticket_id) WHERE is_current`
  partial unique index'i hem performansı hem "en fazla 1 satır" garantisini
  veriyor (`20260710000100_custom_constraints/migration.sql:11-13`).
- Şema/enum/kolon değişikliği yok; `prisma migrate` çalıştırılmaz.

**Geriye dönük uyumluluk riski: DÜŞÜK.**
- Dört uç da yenidir; mevcut hiçbir route/DTO/response değişmez.
- Route çakışma analizi: `GET /users/me/units` ve `GET /users/technicians`
  statik path'lerdir; bugün `GET /users/:id` YOKTUR (`users.controller.ts`),
  çakışma imkânsız. Yine de handler'lar controller içinde param route'lardan
  önce bildirilecek (savunmacı sıra). `GET /tickets/:ticketId/assignments/current`
  yalnız POST'u olan bir path'e GET ekler; `GET /materials` yeni prefix'tir.
- Mevcut repository metotlarının imzaları değişmez (yalnız yeni metot eklenir);
  `listActiveByRole` ve `findCurrentForUpdate` sözleşmeleri aynen kalır.
- Tek davranışsal etkileşim riski: yok — yeni uçlar yazma yapmaz, transaction
  açmaz, kilit almaz.

---

## 11. Güvenlik ve veri minimizasyonu kontrolü

| Kontrol | Sağlanma biçimi |
|---|---|
| Tenant izolasyonu | E1 yalnız `actor.id` ile sorgular (parametre almaz); E4 `TicketReadAccessService` üzerinden ticket erişimini yeniden doğrular; E2/E3 tenant'sız şirket kaynaklarıdır ve yalnız ilgili rollere açıktır |
| Uniform 404 | E4: ticket yok/erişilemez → `TICKET_NOT_FOUND`; current yok → `ASSIGNMENT_NOT_FOUND`; hiçbir uç başka tenant'ın kaynağının varlığını sızdırmaz |
| IDOR yüzeyi | Yeni uçlarda id parametresi yalnız E4'te var, o da mevcut ticket policy zincirinden geçer; E1/E2/E3 kimlik-türevli veya global-katalog sorgularıdır |
| Veri minimizasyonu | `tokenVersion`, `deletedAt`, `isActive`, `endsAt`, `userId` hiçbir yeni response'ta yok; teknisyen `phoneNumber`'ı dönmez; material'de yalnız katalog alanları; E4 mevcut assignment response sözleşmesinin dışına alan eklemez |
| Rol daralması | Her uç en dar yeterli rol setiyle açılır (E1 RESIDENT, E2/E4 OPERATIONS, E3 TECHNICIAN+OPERATIONS); genişletme ileride ayrı karardır |
| Loglama | Yeni uçlar salt-okunur; secret/PII loglanmaz (mevcut pino redact düzeni yeterli, değişiklik gerekmez) |
| Rate limit | Mevcut düzen (yalnız OTP uçları) değişmez; yeni uçlar auth'lu ve okumadır |

---

## 12. Uygulama sırası ve doğrulama komutları

Dört uç bağımsızdır; önerilen sıra (her adım kendi testiyle kapanır):

1. **E3 Materials** (en izole modül) → 2. **E2 Technicians** → 3. **E1 My
   Units** → 4. **E4 Current Assignment** (TicketReadAccessService entegrasyonu
   içerdiği için en son) → 5. E2E `discovery.e2e-spec.ts` + vertical-slice
   varyantı → 6. `docs/frontend-backend-facts.md` Bölüm 5/16/17 güncellemesi
   (yeni uçlar katalog'a işlenir).

Her adımın sonunda (CLAUDE.md doğrulama düzeni):

```
npm run lint
npm run build
npm run prisma:format     # şema değişmediğinin teyidi (diff çıkmamalı)
npm run prisma:validate
docker compose config -q
npm test
npm run test:integration
npm run test:e2e
```

---

## 13. Kapsam dışı işler

- Swagger/OpenAPI üretimi (görev talimatı gereği).
- Material/teknisyen/kullanıcı **CRUD** uçları (yalnız keşif; yazma yok).
- `/auth/me` sözleşme değişikliği (Bölüm 4'te reddedildi).
- Ticket response'una assignment gömme (Bölüm 5'te reddedildi).
- RESIDENT/SITE_MANAGER'a current-assignment görünürlüğü (yeni PII/ürün
  kararı gerektirir).
- Arama/filtre parametreleri (`q`, ad filtresi vb.) — ihtiyaç kanıtlanmadan
  eklenmez.
- Users/Facilities uçlarının mevcut ham-satır yanıtlarının mapper'a alınması
  (`frontend-backend-facts.md` Bölüm 16 #4) — ayrı, kırıcı-potansiyelli iş.
- SMS provider, S3, realtime/notification uçları.
- Yeni index/migration (Bölüm 10'da gereksizliği kanıtlandı).

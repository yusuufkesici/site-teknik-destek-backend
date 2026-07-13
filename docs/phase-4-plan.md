# Faz 4 Plan Özeti — Ticket Çekirdeği

Bu dosya, Faz 4 (Ticket çekirdeği) için onaylanmış ve uygulanmış kararların
**tam ve bağımsız** kaydıdır. Başka hiçbir dosyaya (özellikle Git'e alınmayan
`.claude/plans/...` altındaki taslak plan dosyalarına) bağımlı değildir.

## 1. Kapsam

**İçinde:**
- `TicketsModule` (`src/modules/tickets/`): `TicketService`, `TicketRepository`,
  `TicketAuthorizationPolicy`, `TicketStateMachine`, `Phase4TicketTransitionPolicy`,
  `TicketMapper`, `ContractQueryService` (dar, salt-okunur), ilgili DTO'lar.
- İlk kez yazılan altyapı: `OutboxService` (`src/infrastructure/events/`) —
  yalnız `publishInTx`; PENDING satırları işleyen relay yok.
- 7 endpoint (bkz. Bölüm 2).
- Cursor pagination (createdAt DESC, id DESC).
- Yeni environment değişkeni: `EMERGENCY_SLA_HOURS`.
- Unit, gerçek PostgreSQL integration ve E2E testleri (bkz. Bölüm 9).

**Dışında (bilinçli olarak ertelenmiş, sonraki fazlar):**
- `AssignmentService`/`AssignmentsModule`, teknisyenin assignment accept/reject
  ve çalışma durumu akışları (`ACCEPTED/EN_ROUTE/ARRIVED/IN_PROGRESS/
  WAITING_MATERIAL/COMPLETED`).
- `Materials`, `Attachments` modülleri.
- Tam `ContractsModule` (CRUD, yaşam döngüsü) — bu fazda yalnız dar bir
  salt-okunur sorgu servisi var (Bölüm 7).
- `Billing`, `NotificationDispatcher`, `OutboxRelay`.
- `TicketAssignmentWorkflowService` (Assignment + Ticket'ı birlikte
  güncelleyen orkestrasyon servisi).
- `TRIAGED→ASSIGNED` ve sonrası tüm durumlara gerçek geçiş: `TicketStateMachine`
  bu geçişleri saf/test edilebilir biçimde tanımlar ama hiçbir Faz 4
  endpoint'i bunları çalıştıramaz (Bölüm 4).
- Fotoğraf/attachment endpoint'leri.

## 2. Endpointler ve DTO'lar

| Method | URL | Roller | DTO |
|---|---|---|---|
| POST | `/tickets` | RESIDENT, SITE_MANAGER, OPERATIONS | `CreateTicketDto{facilityId, title(5-150), description(10-4000), category, urgency?}` |
| GET | `/tickets` | RESIDENT, SITE_MANAGER, OPERATIONS | `ListTicketsQueryDto{cursor?, limit?(1-100), siteId?, status?, urgency?}` |
| GET | `/tickets/:id` | RESIDENT, SITE_MANAGER, OPERATIONS, TECHNICIAN | — |
| PATCH | `/tickets/:id` | RESIDENT, SITE_MANAGER, OPERATIONS | `UpdateTicketDto{title?, description?, category?, urgency?, operationNote?, version}` |
| POST | `/tickets/:id/status` | yalnız OPERATIONS | `ChangeTicketStatusDto{toStatus:'TRIAGED', reason?}` |
| POST | `/tickets/:id/cancel` | RESIDENT, SITE_MANAGER, OPERATIONS | `CancelTicketDto{reason (zorunlu)}` |
| GET | `/tickets/:id/history` | RESIDENT, SITE_MANAGER, OPERATIONS, TECHNICIAN | — |

`siteId`, `CreateTicketDto`'da **yoktur** — facility kaydından türetilir,
client girdisine güvenilmez. `source` alanı da client'tan gelmez, aktörün
rolünden sunucu tarafında türetilir (RESIDENT/SITE_MANAGER/OPERATIONS).

`GET /tickets`'te `siteId`, SITE_MANAGER için **zorunludur** (yoksa
`422 VALIDATION_ERROR`); OPERATIONS için opsiyoneldir; RESIDENT gönderse bile
yok sayılır (yalnız kendi ticket'ları döner). Her iki rol için de `siteId`
verildiğinde site'ın gerçekten var olduğu (`facility.type==='SITE'` +
`deletedAt IS NULL`) ayrıca doğrulanır — bilinmeyen `siteId` sessizce boş
liste dönmez, `404 SITE_NOT_FOUND` döner.

**Yanıt kırpma:** Tüm ticket-döndüren endpoint'ler (`create`, `list`,
`findById`, `update`, `changeStatus`, `cancel`) yanıtı `TicketMapper.
toTicketResponse(row, actor)` üzerinden döner: `operationNote` alanı yalnız
OPERATIONS rolüne dönen yanıtta bulunur, diğer tüm rollerde (RESIDENT,
SITE_MANAGER, TECHNICIAN) yanıttan tamamen çıkarılır. `GET /tickets/:id/history`
`TicketStatusHistoryRow[]` döndürür; bu tipte `operationNote` alanı hiç
yoktur, kırpma gerekmez.

## 3. Rol, tenant ve kaynak yetki matrisi

| İşlem | RESIDENT | SITE_MANAGER | OPERATIONS | TECHNICIAN | Kaynak koşulu |
|---|---|---|---|---|---|
| Ticket oluştur | ✔ | ✔ | ✔ | ✖ | R: aktif unit assignment facility ile eşleşir; SM: facility kendi sitesinde; **hepsi**: sitede tarih-aralığı geçerli `ACTIVE` sözleşme yoksa 409 |
| Ticket oku (tekil) | ✔ (kendi + aktif üyelik) | ✔ (kendi yönettiği site) | ✔ (koşulsuz) | ✔ (kendi assignment'ı — Faz 4'te hiçbir zaman gerçekleşmez, hep 404) | — |
| Ticket listele | ✔ (kendi + aktif üyelik) | ✔ (`?siteId` zorunlu + üyelik + site varlığı) | ✔ (tümü; `?siteId` verilirse site varlığı doğrulanır) | ✖ (Faz 5) | repository filtresi zorunlu, parametresiz `findAll` yok |
| Ticket güncelle | ✔ (yalnız OPEN, kendi) | ✔ (site, OPEN/TRIAGED) | ✔ (durum kısıtı yok) | ✖ | `operationNote` yalnız OP yazar/görür; boş PATCH reddedilir |
| Ticket iptal | ✔ (kendi, yalnız OPEN) | ✔ (site, yalnız OPEN/TRIAGED) | ✔ (yalnız OPEN/TRIAGED — ASSIGNED koşulsuz reddedilir) | ✖ | reason zorunlu |
| Durum geçişi (`/status`) | ✖ | ✖ | ✔ (yalnız OPEN→TRIAGED fiilen çalışır) | ✖ | — |
| Durum geçmişi oku | ✔ (kendi) | ✔ (site) | ✔ | ✔ (kendi işi — Faz 4'te hep 404) | — |

**Üç katmanlı yetki kuralı:**
- Rol seviyesi → `RolesGuard` (global, `@Roles(...)`) → 403 `FORBIDDEN`.
- Tenant/kaynak seviyesi → `TicketAuthorizationPolicy` → 404 `TICKET_NOT_FOUND`
  (ticket için, IDOR-safe) veya 404 `FACILITY_NOT_FOUND` (oluşturma sırasında,
  ticket henüz yokken — "ticket bulunamadı" semantik olarak yanlış olurdu).
- Alan/durum seviyesi (kaynağa erişim var ama şu an düzenlenemez) → 403
  `TICKET_UPDATE_FORBIDDEN` / `TICKET_TRANSITION_FORBIDDEN`.
- Faz-kapsamı seviyesi (yeni, bu faza özgü) → `Phase4TicketTransitionPolicy`
  → 409 `TICKET_INVALID_STATUS_TRANSITION`.

`TicketAuthorizationPolicy` üç metot sunar:
- `assertCanCreate(actor, facility, client)`: TECHNICIAN → genel `FORBIDDEN`;
  RESIDENT → facility `UNIT` değilse veya aktif unit assignment'ı eşleşmezse
  `FACILITY_NOT_FOUND`; SITE_MANAGER → `hasActiveManagerMembership` false ise
  `FACILITY_NOT_FOUND`; OPERATIONS → koşulsuz.
- `assertCanRead(actor, ticket, client)`: RESIDENT → sahiplik + aktif site
  üyeliği; SITE_MANAGER → aktif manager üyeliği; TECHNICIAN →
  `TicketRepository.existsAssignmentForTechnician`; OPERATIONS → koşulsuz
  (bkz. Bölüm 7, overrides §5 kararı).
- `assertCanUpdateFields(actor, ticket, dto)`: senkron/saf — `operationNote`
  yalnız OPERATIONS gönderebilir; içerik alanı (title/description/category/
  urgency) değişikliği RESIDENT için yalnız kendi OPEN ticket'ında, SITE_MANAGER
  için yalnız OPEN/TRIAGED durumunda serbest; OPERATIONS durum kısıtı olmadan
  değiştirebilir.

## 4. TicketStateMachine ve Phase4TicketTransitionPolicy

`TicketStateMachine`, ticket'ın **tüm** olası yaşam döngüsünü (16 geçiş) saf
ve bağımsız (DB'ye erişmez) biçimde tanımlar — ileriki fazlar (Assignment,
teknisyen akışları) için de doğru olsun diye eksiksiz tutulur:

| From | To | İzinli roller | Reason zorunlu mu |
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

`CLOSED` ve `CANCELLED` terminal durumlardır (hiçbir çıkış geçişi yok).
`assertTransition(from, to, role, reason?)`:
1. `from === to` → `409 TICKET_STATUS_UNCHANGED`.
2. Tabloda tanımsız çift → `409 TICKET_INVALID_STATUS_TRANSITION`.
3. Tanımlı ama rol uygun değil → `403 TICKET_TRANSITION_FORBIDDEN`.
4. Reason zorunlu ama boş/eksik → `422 TICKET_TRANSITION_REASON_REQUIRED`.

**`Phase4TicketTransitionPolicy` (bu faza özgü, koşulsuz sınır):** Yukarıdaki
tam tablo gelecek fazlar için doğru olsa da, Faz 4'ün hiçbir endpoint'i buna
doğrudan güvenmez. Yalnız şu üç çifte izin verir, gerisini **veritabanındaki
gerçek duruma bakılmaksızın** (seed data, manuel müdahale, ileride başka bir
yol dahil) `409 TICKET_INVALID_STATUS_TRANSITION` ile reddeder:

- `OPEN → TRIAGED`
- `OPEN → CANCELLED`
- `TRIAGED → CANCELLED`

Bu, özellikle "ticket ASSIGNED durumuna bir şekilde ulaşırsa (assignment
oluşturulmadan) iptal edilebilir mi" sorusunu kapatır: `ASSIGNED → CANCELLED`
teorik olarak `TicketStateMachine`'de OPERATIONS için tanımlı olsa da,
`Phase4TicketTransitionPolicy` bunu allowlist dışı olduğu için koşulsuz
reddeder — aktif assignment'ı kapatan `TicketAssignmentWorkflowService` Faz
5'e kadar yok, bu yüzden yarım/tutarsız bir iptal davranışı üretilmez.

**Çağrı sırası (önemli):** `TicketService.applyTransition` (changeStatus ve
cancel'in ortak uygulaması), ticket satırını `FOR UPDATE` ile kilitledikten
ve `assertCanRead` ile tenant kontrolünü yaptıktan sonra, **önce**
`TicketStateMachine.assertTransition`'ı, **ardından**
`Phase4TicketTransitionPolicy.assertAllowedInThisPhase`'i çağırır. Bu sıra
kasıtlıdır: `stateMachine` önce çalıştığı için `from === to` durumu doğru
şekilde `409 TICKET_STATUS_UNCHANGED` olarak sınıflandırılır (aksi halde,
örneğin ticket zaten TRIAGED iken tekrar `toStatus=TRIAGED` gönderilirse,
`TRIAGED→TRIAGED` çifti Faz 4 allowlist'inde olmadığından yanlışlıkla
`TICKET_INVALID_STATUS_TRANSITION` dönerdi). Faz 4'ün koşulsuz sınırı bu
sıradan etkilenmez: her iki kontrol de herhangi bir veritabanı yazımından
**önce** çalışır, bu yüzden allowlist dışı hiçbir geçiş asla kalıcı hale
gelemez.

`POST /tickets/:id/status`, yalnız OPERATIONS'a açık olduğundan ve
`ChangeTicketStatusDto.toStatus` DTO seviyesinde de yalnız `'TRIAGED'`
değerini kabul ettiğinden (çift savunma hattı), bu uç pratikte yalnız
`OPEN→TRIAGED`'i çalıştırabilir.

## 5. TicketRepository ve zorunlu scope filtreleri

Parametresiz "tüm ticket'ları getir" metodu yoktur; `list()` her zaman bir
`TicketListFilter` (RESIDENT/SITE_MANAGER/OPERATIONS ayrımlı, discriminated
union) alır. RESIDENT dalı, `TicketAuthorizationPolicy.assertCanRead` ile
tutarlı kalmak için yalnız `createdByUserId` filtresi değil, aynı zamanda
ticket'ın sitesine karşı **aktif site üyeliği** filtresini de (Prisma'nın
nested `site.siteMembers.some{...}` ilişki filtresiyle) uygular — taşınmış
bir sakin listede gördüğü bir ticket'ı açtığında 404 alan "hayalet satır"
sorunu bu şekilde önlenir.

`findByIdForUpdate` (raw SQL, `FOR UPDATE`) PATCH/durum-değişikliği/iptal
transaction'larında ticket satırını kilitler; `findAliveById` (kilitsiz)
salt-okuma (`GET`) uçlarında kullanılır. `existsAssignmentForTechnician`,
zaten var olan `Assignment` Prisma modelini doğrudan okur — ayrı bir
`AssignmentRepository`/`AssignmentModule` açılmadan (Faz 5'e bırakılır).

## 6. Transaction ve concurrency kuralları

**Oluşturma:** Yetki (`assertCanCreate`) ve entitlement (aktif sözleşme)
kontrolleri transaction **dışında**; ticket kodu üretimi + insert + ilk
`OPEN` history kaydı + audit + outbox satırı **tek transaction içinde**.

**Güncelleme (PATCH):** Ticket satırı `FOR UPDATE` ile kilitlenir. İki katmanlı
optimistic locking: (1) kilitlenmiş satırın `version`'ı, client'ın gönderdiği
`dto.version` ile erken karşılaştırılır — uyuşmazlıkta mutasyon uygulanmadan
`409 CONCURRENT_MODIFICATION`; (2) `TicketRepository.updateFields`'in kendi
`WHERE id=? AND version=?` koşulu, eşleşme olmazsa (0 satır) ikinci bir
savunma hattı olarak yine `409 CONCURRENT_MODIFICATION` üretir. Değiştirilecek
en az bir içerik alanı (title/description/category/urgency/operationNote)
yoksa — yalnız `version` gönderilmişse — `422 TICKET_UPDATE_EMPTY` ile erken
reddedilir, transaction hiç açılmaz, DB'ye gidilmez.

**Durum değişikliği/iptal:** Aynı `applyTransition` yardımcı metodu; ticket
`FOR UPDATE` ile kilitlenir, `TicketStateMachine` → `Phase4TicketTransitionPolicy`
sırasıyla doğrulanır (Bölüm 4), `updateStatus` de aynı `WHERE version=?`
korumasını kullanır, ardından history + audit + outbox aynı transaction'da
yazılır.

**Kilit sırası:** Her zaman ticket satırı önce kilitlenir; Faz 4'te
Assignment'a hiç dokunulmadığından ek bir kilit sırası kuralı gerekmez (Faz
5'te Assignment eklendiğinde ticket → assignment sırası korunmalı).

## 7. SLA ve dar ContractQueryService

`ContractQueryService.findActiveForSite(siteId, client)`, `TicketsModule`
içinde kalan dar/salt-okunur bir servistir (ayrı bir `ContractsModule` bu
fazda açılmaz — CRUD Faz 7'ye ait). Raw SQL ile şunu doğrular:
`status = 'ACTIVE' AND start_date <= CURRENT_DATE AND end_date >= CURRENT_DATE`
(DB'nin `CURRENT_DATE`'i kullanılır, uygulama saat dilimine bağımlı kalınmaz —
`Contract.startDate/endDate` `@db.Date` date-only kolonlardır). Aktif
sözleşme yoksa ticket oluşturma `409 TICKET_SITE_CONTRACT_INACTIVE` ile
reddedilir.

`computeSlaTargetAt(createdAt, urgency, contract, emergencySlaHours)` saf bir
fonksiyondur:
- `urgency === 'EMERGENCY' && contract.emergencyCoverage === true` →
  `createdAt + emergencySlaHours` (env değişkeninden).
- Diğer tüm durumlar (EMERGENCY + coverage=false dahil) →
  `contract.standardResponseTargetHours` doluysa `createdAt + o kadar saat`,
  boşsa `null`.

`slaTargetAt`, ticket oluşturulurken tam olarak SLA hesabında kullanılan aynı
`createdAt` değeriyle (uygulama tarafında üretilen `Date`, DB'nin
`@default(now())`'ına bırakılmadan, açıkça `INSERT`'e geçirilerek) birlikte
yazılır — böylece iki alan arasında milisaniye düzeyinde bile tutarsızlık
oluşmaz.

**`PATCH` ile urgency değişimi:** SLA yalnız `urgency` **gerçekten** değişmişse
(`dto.urgency !== undefined && dto.urgency !== ticket.urgency`) aynı
transaction içinde `ticket.createdAt` baz alınarak ve taze bir sözleşme
sorgusuyla yeniden hesaplanır. Aynı urgency tekrar gönderilirse
`contractQuery` hiç çağrılmaz, `slaTargetAt` alanına dokunulmaz (gereksiz
sorgu/güncelleme yapılmaz).

**Yeni environment değişkeni:** `EMERGENCY_SLA_HOURS` (pozitif tam sayı,
Zod şemasında zorunlu) — `src/config/validation.schema.ts`,
`src/config/configuration.ts` (`ticketsConfig`), `.env.example` ve
`test/integration/setup/postgres-testcontainer.ts`'nin `configureBaseTestEnv()`
fonksiyonuna eklenmiştir. Bu değişken eksikse uygulama (yalnız ticket
endpoint'leri değil, tamamı) `validateEnv` fail-fast hatasıyla hiç açılmaz.

## 8. History, audit ve outbox

`TicketStatusHistory` append-only'dir (güncelleme/silme metodu yok); her
oluşturma/durum-değişikliği/iptal işleminde bir satır ekler
(`previousStatus`, `newStatus`, `changedByUserId`, `reason`, `metadata`).
`reason` alanı ham metni bu tabloda saklamaya devam eder.

**Audit action'ları** (`DOMAIN_AUDIT_ACTIONS`'a additive eklendi):
`TICKET_CREATED`, `TICKET_UPDATED` (`metadata: {changedFields}` — yalnız
değişen alan adları, değer yok), `TICKET_STATUS_CHANGED`, `TICKET_CANCELLED`
(ikisi de `metadata: {from, to, reasonProvided: boolean}` — **ham `reason`
metni asla audit'e yazılmaz**).

**`OutboxService.publishInTx`** (ilk kez bu fazda yazıldı, yalnız PENDING
satır ekler, hiç okuma/tüketim yapmaz — relay Faz 8'e ait):
- `TicketCreated` / `EmergencyTicketCreated` (urgency'ye göre): payload
  `{ticketId, ticketCode, siteId, facilityId, category, urgency, createdByUserId}`.
- `TicketStatusChanged` (hem `/status` hem `/cancel` için): payload
  `{ticketId, ticketCode, siteId, previousStatus, newStatus, actorUserId}`.

Hiçbir payload serbest metin (title/description/operationNote/reason)
içermez — yalnız kimlik ve durum alanları.

`ChangeTicketStatusDto`'da mimari dokümanın örnek koduna aksine sınırsız bir
`metadata: Record<string, unknown>` alanı **yoktur** — Faz 4'ün tek anlamlı
geçişi (`OPEN→TRIAGED`) için gerekli değildir, keyfi JSON kabul edilmez.

## 9. Hata kodları

Additive olarak `ERROR_CODES`'a eklenenler:

| Kod | HTTP | Anlam |
|---|---|---|
| `TICKET_NOT_FOUND` | 404 | Ticket yok veya aktörün erişimi yok (IDOR-safe) |
| `TICKET_UPDATE_FORBIDDEN` | 403 | Kaynağa erişim var ama mevcut durum/rol PATCH'e izin vermiyor |
| `TICKET_UPDATE_EMPTY` | 422 | PATCH'te `version` dışında hiçbir alan gönderilmemiş |
| `TICKET_STATUS_UNCHANGED` | 409 | `toStatus === mevcut status` |
| `TICKET_INVALID_STATUS_TRANSITION` | 409 | State machine'de tanımsız geçiş **veya** Faz 4 allowlist dışı geçiş |
| `TICKET_TRANSITION_FORBIDDEN` | 403 | Geçiş var ama rol uygun değil |
| `TICKET_TRANSITION_REASON_REQUIRED` | 422 | Reason zorunlu ama boş/eksik |
| `CONCURRENT_MODIFICATION` | 409 | `version` uyuşmazlığı |
| `TICKET_SITE_CONTRACT_INACTIVE` | 409 | Sitenin tarih-aralığı geçerli `ACTIVE` sözleşmesi yok |

Yeniden kullanılan mevcut kodlar: `FACILITY_NOT_FOUND` (facilityId
geçersiz/erişilemez/tip SITE — ticket oluşturma reddi dahil), `SITE_NOT_FOUND`
(`GET /tickets` `?siteId` var olmayan/erişilemeyen site), `VALIDATION_ERROR`
(cursor decode hatası, SITE_MANAGER için eksik siteId), `FORBIDDEN` (rol-only
ihlaller: TECHNICIAN'ın POST/PATCH denemesi, operationNote'u OP-dışı rolün
göndermesi).

## 10. Test kapsamı

**Unit** (`src/modules/tickets/**/*.spec.ts`, mock bağımlılıklarla):
`TicketStateMachine` (16 geçerli geçiş, tüm geçersiz çiftler, yanlış rol,
reason zorunluluğu, `from===to`); `Phase4TicketTransitionPolicy` (yalnız 3
izinli çift, `TRIAGED→ASSIGNED`/`ASSIGNED→CANCELLED`/`ASSIGNED→ACCEPTED` dahil
her şey reddedilir); `TicketAuthorizationPolicy` (create/read/update-fields
için her rol dalı, IDOR/moved-resident/cross-site/technician-without-
assignment senaryoları); `TicketService` (create'in facility/contract/SLA/
outbox davranışı, update'in boş-PATCH reddi + version-conflict + SLA
yeniden-hesaplama + aynı-urgency-değişmez davranışı, changeStatus/cancel'in
çağrı sırası ve audit/outbox içerik kısıtları, list'in rol bazlı filtre ve
site-doğrulama davranışı); `computeSlaTargetAt` (tüm urgency/coverage
kombinasyonları); `toTicketResponse` (operationNote kırpma).

**Integration** (`test/integration/tickets/`, gerçek PostgreSQL,
Testcontainers): ticket code üretiminin atomikliği; soft-delete filtresi;
RESIDENT `list()` ile `assertCanRead` tutarlılığı (üyelik pasifleşince
"hayalet satır" oluşmadığı); `existsAssignmentForTechnician`'ın doğrudan seed
edilen `Assignment` satırıyla doğrulanması; ASSIGNED durumuna manuel seed
edilmiş bir ticket'ın iptalinin koşulsuz 409 alması; sözleşme tarih-aralığı
dışı senaryonun 409 vermesi; OPERATIONS'ın bilinmeyen `siteId` ile listeleme
denemesinin 404 alması; SLA/urgency-değişimi senaryoları (STANDARD↔EMERGENCY,
`emergencyCoverage=false`, `standardResponseTargetHours=null`); gerçek
`Promise.all` ile eşzamanlı PATCH (biri 409) ve eşzamanlı durum değişikliği
(biri `TICKET_STATUS_UNCHANGED`); `ticket_code_seq`'in atomikliği.

**E2E** (`test/e2e/tickets.e2e-spec.ts`, tam uygulama + Testcontainers +
supertest): resident kendi dairesi için ticket oluşturur → başka resident
göremez (404); site manager kendi sitesini listeler, başka site 404; resident
kendi OPEN ticket'ını PATCH eder, aynı version'la ikinci PATCH 409, boş PATCH
422; resident iptali (reason'sız 422, reason'lı başarılı); OPERATIONS
OPEN→TRIAGED, tekrarı 409 `TICKET_STATUS_UNCHANGED`; sözleşmesiz sitede
oluşturma 409; EMERGENCY ticket'ın SLA'sının doğru hesaplanması ve
urgency değişince yeniden hesaplanması; geçersiz/başka-site facility'sine
oluşturma denemesinin 404 `FACILITY_NOT_FOUND` alması.

Faz 1-3'ün tüm unit/integration/E2E test suite'leri bu faz boyunca değişmeden
yeşil kalmıştır.

## 11. Kapsam dışı bırakılan işler (sonraki fazlar)

- `AssignmentService`/`AssignmentsModule`, teknisyen accept/reject ve çalışma
  durumu akışları, `TicketAssignmentWorkflowService` (Faz 5).
- `Materials`, `Attachments` (Faz 5/6).
- Tam `ContractsModule` CRUD, sözleşme yaşam döngüsü yönetimi (Faz 7).
- `Billing` (Faz 7).
- `NotificationDispatcher`, `OutboxRelay` (Faz 8).
- `Phase4TicketTransitionPolicy`, Faz 5'te `TicketAssignmentWorkflowService`
  geldiğinde tamamen kaldırılacak geçici bir sınırlama katmanıdır.

# Faz 6 — Attachments: Uygulama Planı

## Context

Faz 1-5 ile ticket/assignment/material domain'leri tamamlandı. Ticket ve
assignment akışlarında teknisyen/sakin fotoğraf eklemesi henüz yok;
`TicketAttachment` modeli şemada mevcut ama hiçbir servis/controller onu
kullanmıyor. Faz 6'nın amacı: ticket'a (ve gerektiğinde assignment'a)
fotoğraf/görsel yükleme, güvenli saklama (yerel disk), listeleme ve indirme
akışını, mevcut Faz 1-5 mimari kurallarına (tenant izolasyonu, 404-not-403
IDOR yaklaşımı, dar port/export deseni, transaction-aware repository/audit/
outbox kullanımı) birebir uyumlu şekilde eklemek. Bu plan onaylandıktan sonra
`docs/phase-6-plan.md` olarak kaydedilecek; implementasyon ayrı bir adımda
yapılacak.

Kaynaklar: `prisma/schema.prisma` (TicketAttachment modeli, satır 409-431),
`docs/implementation-overrides.md` §3-4, `docs/phase-5-plan.md` (şablon),
mevcut `src/modules/tickets/**`, `src/modules/assignments/**`,
`src/infrastructure/sms/**` (provider seçim deseni), `src/common/**`.

Bu revizyon, ilk taslağın kullanıcı tarafından verilen 12 kesin karar/düzeltme
ve ardından gelen 6 ek güvenlik/cleanup düzeltmesine göre nihai hale
getirilmiş halidir.

---

## 1. Kapsam / kapsam dışı

**Kapsam:**
- Ticket'a (opsiyonel olarak assignment'a bağlı) **yalnız JPEG/PNG/WEBP
  görsel** yükleme.
- Attachment metadata'sının PostgreSQL'de saklanması (mevcut `TicketAttachment`
  modeli).
- Dosya içeriğinin `StorageProvider` üzerinden yerel diskte saklanması.
- `LocalStorageProvider` implementasyonu (bu fazdaki **tek** provider).
- Attachment listeleme (cursor pagination) ve indirme/stream.
- Tenant izolasyonu, IDOR koruması, upload güvenliği.
- DB/storage tutarsızlığında compensating cleanup (her başarısızlık noktası
  için, bkz. §9).
- Unit + gerçek PostgreSQL integration + E2E testleri.

**Kapsam dışı:**
- S3 implementasyonu. `STORAGE_PROVIDER=s3` seçilirse bootstrap sırasında
  açık hata verilir; sahte/yarım `S3StorageProvider` yazılmaz.
- PDF ve diğer belge türleri (mimaride "belge" geçse de bu fazda desteklenmez;
  `AttachmentType` enum'undaki `DOCUMENT`/`OTHER` değerleri metadata
  sınıflandırması olarak kalır ama gerçek dosya içeriği yine de yalnız
  jpeg/png/webp olmak zorundadır — enum şemadan çıkarılmaz, yalnız MIME
  allowlist tüm attachmentType'lar için aynı 3 formatla sınırlıdır).
- Attachment silme endpoint'i (mimaride yok, eklenmiyor).
- Virus scanner (mimaride extension point olarak anılıyor, bu fazda yok).
- Contracts, billing, notifications, outbox relay, material katalog CRUD.
- Thumbnail/resize/transcode.
- Signed URL / presigned URL mekanizması (yalnız local provider bu fazda —
  bkz. §10 gerekçe).

---

## 2. Mevcut şema ve açık kararlar

`TicketAttachment` modeli (schema.prisma:409-431) yeterli, migration ile yeni
alan eklenmeyecek:

```
id, ticketId, assignmentId (nullable), uploadedByUserId, attachmentType,
storageProvider (String), storageKey (String), originalFileName, mimeType,
fileSize (Int), checksum (String, 64), createdAt, deletedAt (nullable)
@@index([ticketId])
```

- `assignmentId` zaten nullable → assignment'sız ticket-only attachment
  destekleniyor.
- `deletedAt` mevcut ama bu fazda hiçbir akış onu set etmiyor (silme endpoint'i
  yok); ileride admin-silme fazı için ayrılmış alan olarak bırakılıyor.
- **Eksik olan tek DB seviyeli kural:** `(assignment_id, ticket_id)` →
  `assignments(id, ticket_id)` composite FK. `Assignment` üzerinde
  `(id, ticket_id)` non-partial unique constraint Faz 5'te eklendi (overrides
  §4). Prisma şeması `assignment` ilişkisini tek kolonla (`assignmentId →
  Assignment.id`) modelliyor; aynı `ticketId` kolonu zaten `Ticket`
  ilişkisinde kullanıldığı için Prisma seviyesinde ikinci bir navigasyonel
  composite ilişki tanımlanamaz.

  **Migration prosedürü (Prisma CLI'nin boş migration üretmesine
  güvenilmez — mevcut custom constraint migration yöntemi izlenir):**
  1. İmplementasyon başında önce Faz 5'in `(id, ticket_id)` unique
     constraint'ini ekleyen migration dosyası açılır; gerçek constraint adı
     ve o migration'ın hangi teknikle (elle mi, `--create-only` ile mi)
     oluşturulduğu doğrulanır — varsayım yapılmaz, aynı teknik tekrarlanır.
  2. `prisma/migrations/<timestamp>_ticket_attachment_composite_fk/` klasörü
     ve içindeki `migration.sql` dosyası, Faz 5'teki migration ile birebir
     aynı yöntemle (klasör adı formatı, `migration_lock.toml` ile uyum)
     oluşturulur.
  3. Dosyaya elle, adım 1'de doğrulanmış gerçek isimlerle:
     `ALTER TABLE ticket_attachments ADD CONSTRAINT fk_attachment_assignment_ticket FOREIGN KEY (assignment_id, ticket_id) REFERENCES assignments (id, ticket_id) ON DELETE RESTRICT;`
     yazılır. `ON DELETE RESTRICT` seçildi çünkü `ticket_attachments` üzerindeki
     mevcut iki FK (`ticketId`, `assignmentId`) de `onDelete: Restrict`
     kullanıyor (schema.prisma) — composite FK aynı silme davranışıyla
     tutarlı olur. `ON UPDATE` için Postgres/Prisma varsayılanı (`NO ACTION`)
     korunur, şemadaki diğer FK'ler de açık bir `ON UPDATE` tanımlamıyor.
  4. Doğrulama proje konvansiyonuna göre yapılır: `prisma migrate deploy`
     (test container'ın zaten kullandığı komut, `test/integration/setup/
     postgres-testcontainer.ts`) + `prisma validate` + gerçek PostgreSQL
     integration testleri (§13) — `prisma migrate dev` implementasyon
     sürecinde kullanılmaz, yalnız CI/test'in de kullandığı `deploy` akışı
     doğrulanır.

---

## 3. Modül bağımlılık yönü

```
AttachmentsModule → TicketsModule      (yalnız yeni export edilecek servis)
AttachmentsModule → AssignmentsModule  (yalnız yeni export edilecek servis)
AttachmentsModule → AuditModule, EventsModule, StorageModule
```

Tek yönlü, `forwardRef` yok. `TicketRepository`/`AssignmentRepository`/
`TicketAuthorizationPolicy` hiçbir zaman dışa export edilmiyor (mevcut kural
korunuyor). Bunun yerine iki **yeni dar export** eklenecek (MaterialLookupService
ile aynı desen — concrete servis export, Symbol-token port değil, çünkü tek
implementasyon var ve takas ihtiyacı yok):

- `TicketsModule` → `TicketReadAccessService`
  (`src/modules/tickets/services/ticket-read-access.service.ts`, YENİ dosya)
  — `assertReadableAndGet(actor, ticketId, client): Promise<TicketRow>`.
  İçeride mevcut `TicketRepository.findById` + `TicketAuthorizationPolicy.
  assertCanRead` çağrılıyor; ikisi de dışarı sızmıyor. Erişim reddi her zaman
  `TICKET_NOT_FOUND`/404 (mevcut politika ile birebir). `TicketRow` ticket'ın
  `status` alanını da içerir (upload'ta CLOSED/CANCELLED kontrolü için, §7).

- `AssignmentsModule` → `AssignmentLookupService`
  (`src/modules/assignments/services/assignment-lookup.service.ts`, YENİ
  dosya) — `findForAttachmentCheck(client, assignmentId): Promise<{ id,
  ticketId, technicianId, status, isCurrent } | null>`. İçeride mevcut
  `AssignmentRepository.findByIdWithTicket` yeniden kullanılır; `isCurrent`
  alanı da select edilerek sonuç nesnesine eklenir.

---

## 4. Dosya ağacı

```
src/infrastructure/storage/
  storage-provider.interface.ts   # STORAGE_PROVIDER Symbol token + interface
  local-storage.provider.ts       # tek implementasyon bu fazda
  storage.module.ts               # config.storage.provider'a göre factory

src/modules/tickets/services/
  ticket-read-access.service.ts   # YENİ, TicketsModule export listesine eklenir

src/modules/assignments/services/
  assignment-lookup.service.ts    # YENİ, AssignmentsModule export listesine eklenir

src/modules/attachments/
  attachments.module.ts
  controllers/
    ticket-attachments.controller.ts  # POST/GET altında /tickets/:ticketId/attachments
    attachment-download.controller.ts # GET /attachments/:id/download
  dto/
    upload-attachment.dto.ts
    list-attachments-query.dto.ts
  mappers/attachment.mapper.ts
  policies/attachment-authorization.policy.ts
  repositories/ticket-attachment.repository.ts
  services/attachment.service.ts
  interceptors/
    attachment-upload-cleanup.interceptor.ts  # DI destekli, temp cleanup safety-net
  security/
    file-signature.util.ts        # magic-byte doğrulama (bağımlılıksız)
    storage-key.util.ts           # güvenli storageKey üretimi / path traversal guard

src/common/constants/attachment.constant.ts
  # MAX_FILE_SIZE_BYTES, ALLOWED_ATTACHMENT_MIME_TYPES,
  # TECHNICIAN_ALLOWED_ATTACHMENT_TYPES

prisma/migrations/<ts>_ticket_attachment_composite_fk/migration.sql  # elle SQL

test/integration/attachments/*.integration-spec.ts
test/e2e/attachments.e2e-spec.ts
```

**Neden iki controller:** Endpoint sözleşmesi gereği (§6) upload/list
`/tickets/:ticketId/attachments` altında, download ise üst seviye
`/attachments/:id/download` altında. NestJS'te controller-seviyesi path
prefix'i route bazında ezilemediği için iki ayrı controller dosyası (aynı
modül içinde) kullanılır; ikisi de `AttachmentService`'i çağırır, iş kuralı
controller'da olmaz.

Değişecek mevcut dosyalar: `src/app.module.ts` (import + config load),
`src/config/configuration.ts` (yeni `storageConfig` slice),
`src/common/constants/error-codes.constant.ts`,
`src/common/constants/domain-audit-actions.constant.ts`,
`src/common/filters/global-exception.filter.ts` (MulterError eşlemesi, §8),
`src/modules/tickets/tickets.module.ts` (export listesi),
`src/modules/assignments/assignments.module.ts` (export listesi),
`package.json` (bkz. aşağıdaki bağımlılık notu).

**Bağımlılık ön kontrolü (implementasyon öncesi zorunlu adım):**
Önceki keşifte `@nestjs/platform-express` (^11) mevcut ve Multer desteğini
native sağlıyor, ancak `multer`/`@types/multer` doğrudan bağımlılık olarak
`package.json`'da **yok** — yalnız transitive olarak geliyor. `MulterError`
runtime import'u (`import { MulterError } from 'multer'`, §8'deki filter
eşlemesi için) ve `Express.Multer.File` TypeScript tipi (interceptor/DTO
parametre tipleri için) transitive bağımlılığa bilinçsizce güvenilerek
yazılmaz. İmplementasyon başında `package.json` tekrar kontrol edilir; eğer
derleme/runtime import gerçekten `multer`/`@types/multer`'ı doğrudan
gerektiriyorsa yalnız bu iki minimal paket (mevcut `@nestjs/platform-express`
sürümüyle uyumlu, `package-lock.json`'daki mevcut transitive sürümle aynı
majör) eklenir — gereksiz/geniş bağımlılık eklenmez.

---

## 5. StorageProvider tasarımı

Buffer tabanlı değil, **temp-file + rename** tabanlı (RAM'e tüm dosyayı almamak
için — CLAUDE.md kısıtı).

```typescript
// storage-provider.interface.ts
export const STORAGE_PROVIDER = Symbol('STORAGE_PROVIDER');
export interface StorageProvider {
  finalize(input: { tempPath: string; mimeType: string }):
    Promise<{ storageKey: string; checksum: string; size: number }>;
  openReadStream(storageKey: string): Promise<Readable>;
  delete(storageKey: string): Promise<void>;
  deleteTemp(tempPath: string): Promise<void>;
}
```

`LocalStorageProvider`:
- `finalize`: temp dosyayı stream ederek SHA-256 checksum hesaplar,
  `STORAGE_LOCAL_PATH/attachments/<uuid>` hedefine `fs.rename` (atomic, aynı
  filesystem) ile taşır; `storageKey` = göreli path (`attachments/<uuid>`).
- `openReadStream`: `path.resolve(STORAGE_LOCAL_PATH, storageKey)` sonucunun
  `STORAGE_LOCAL_PATH` altında kaldığını doğrular (path traversal guard —
  `storage-key.util.ts`), sonra `fs.createReadStream`.
- `delete`: finalize edilmiş dosyayı `fs.unlink` ile siler, `ENOENT`
  durumunda sessizce yutar (idempotent).
- `deleteTemp`: henüz finalize edilmemiş `tmp/` dosyasını siler, aynı şekilde
  idempotent.
- Dizinler (`tmp/`, `attachments/`) yoksa `fs.mkdir(recursive:true)` ile
  otomatik oluşturulur.

**Multer konfigürasyonu DI-uyumlu tasarlanır** (§8'de detay): `FileInterceptor`
dekoratörü içinde doğrudan `ConfigService` kullanılmaz. `AttachmentsModule`
içinde `MulterModule.registerAsync({ inject: [ConfigService], useFactory: ... })`
ile `STORAGE_LOCAL_PATH/tmp` yolu config'ten okunur; controller'lar yalnız
`@UseInterceptors(FileInterceptor('file'))` kullanır (local override yok),
options modül seviyesinde merge edilir.

`storage.module.ts`: `sms.module.ts` ile aynı desen — config'teki
`storage.provider` değerine göre factory; `local` → `LocalStorageProvider`;
`s3` seçilirse bootstrap'ta açık hata fırlatılır ("S3StorageProvider bu
fazda implement edilmedi"), sahte/yarım S3 provider yazılmaz.

`StorageModule` global değil, yalnız `AttachmentsModule` tarafından import
edilir.

---

## 6. Endpoint ve DTO/multipart sözleşmesi

| Method | Path | Roller | Başarı |
|---|---|---|---|
| POST | `/tickets/:ticketId/attachments` | RESIDENT, SITE_MANAGER, OPERATIONS, TECHNICIAN | 201 |
| GET | `/tickets/:ticketId/attachments` | RESIDENT, SITE_MANAGER, OPERATIONS, TECHNICIAN | 200 |
| GET | `/attachments/:id/download` | RESIDENT, SITE_MANAGER, OPERATIONS, TECHNICIAN | 200 (stream) |

Silme endpoint'i eklenmiyor (mimaride yok). Download endpoint'i **ticketId
path param'ı almaz** — attachment metadata'sından `ticketId` bulunur, sonra
parent ticket üzerinden yetki tekrar doğrulanır (§10).

**Upload multipart alanları:**
- `file` — tek dosya, modül seviyesinde `MulterModule.registerAsync` ile
  ayarlı `diskStorage` + `limits: { fileSize: MAX_FILE_SIZE_BYTES, files: 1 }`.
- `attachmentType` — body alanı, `AttachmentType` enum, zorunlu.
- `assignmentId` — body alanı, opsiyonel UUID.

`upload-attachment.dto.ts`: yalnız `attachmentType` (enum) + `assignmentId`
(opsiyonel UUID) validasyonu; mevcut global `ValidationPipe`
(`whitelist: true, forbidNonWhitelisted: true`) sayesinde DTO'da tanımlı
olmayan body alanları otomatik `422 VALIDATION_ERROR` ile reddedilir — ek kod
gerekmez, "yok sayılır" davranışı **yok**.

`list-attachments-query.dto.ts`: mevcut `pagination.util.ts` cursor
sözleşmesiyle uyumlu `{ cursor?: string; limit?: number }`.

**Response mapper alanları** (`toAttachmentResponse`): `id, ticketId,
assignmentId, attachmentType, originalFileName, mimeType, fileSize,
uploadedByUserId, createdAt`. `storageProvider`, `storageKey`, `checksum`
asla response'a girmez.

---

## 7. Yetkilendirme ve tenant izolasyonu

Her attachment erişimi `TicketReadAccessService.assertReadableAndGet` üzerinden
geçer (ticket bulunamama/erişim reddi → her zaman `404 TICKET_NOT_FOUND`,
mevcut politika ile birebir aynı: RESIDENT kendi ticket'ı + aktif üyelik,
SITE_MANAGER kendi sitesi, TECHNICIAN kendisine atanmış ticket, OPERATIONS
koşulsuz).

**Upload akışında sıra (`AttachmentService.upload`) — assignment lookup
artık evrensel/önce değil, role göre koşullu çağrılır** (bir rolün erişemediği
bir assignment hakkında var/yok, kime ait, hangi durumda bilgisi asla
sızdırılmamalı):

1. `ticket = TicketReadAccessService.assertReadableAndGet(actor, ticketId, client)`.
2. `AttachmentAuthorizationPolicy.assertCanUpload(actor, ticket, rawAssignmentId, attachmentType, lookupAssignment)`
   — `lookupAssignment` yalnız gerektiğinde çağrılan bir callback
   (`AssignmentLookupService.findForAttachmentCheck`):

   - **RESIDENT / SITE_MANAGER**:
     a. `ticket.status ∈ {CLOSED, CANCELLED}` → `403 TICKET_UPDATE_FORBIDDEN`
        (ticket modülünde zaten tanımlı, yeni kod icat edilmedi).
     b. `rawAssignmentId` verilmişse → **assignment lookup hiç yapılmadan**
        doğrudan `403 ATTACHMENT_UPLOAD_NOT_ALLOWED` (sakin/site yöneticisi
        fotoğrafı assignment'a bağlı olamaz; var olup olmadığı, kime ait
        olduğu sorgulanmaz — bilgi sızıntısı önlenir).
     c. Aksi halde izin verilir.

   - **TECHNICIAN**:
     a. `rawAssignmentId` yoksa → `404 ASSIGNMENT_NOT_FOUND` (lookup
        yapılmadan; teknisyen için assignmentId fiilen zorunludur).
     b. `assignment = lookupAssignment(rawAssignmentId)`.
     c. **Tek ve kesin sonuç** — aşağıdakilerden **herhangi biri** doğruysa
        `404 ASSIGNMENT_NOT_FOUND` (hangisi olduğu ayrım gözetmeksizin, aynı
        kod/status): `assignment === null` **veya**
        `assignment.technicianId !== actor.id` **veya**
        `assignment.isCurrent !== true` **veya**
        `assignment.status ∉ {ACCEPTED, ACTIVE}` (dolayısıyla `COMPLETED`,
        `PENDING`, `REJECTED`, `CANCELLED`, `REASSIGNED` hepsi bu sonuca
        girer).
     d. Yalnız (c)'nin tamamı geçtiyse (yani kendisine ait, current, kabul
        edilmiş/aktif bir assignment doğrulandıysa) `assignment.ticketId
        !== ticket.id` kontrolü yapılır → `409
        ATTACHMENT_ASSIGNMENT_MISMATCH` (overrides §4). Bu kontrol (c)'den
        **sonra** gelir — aksi halde "assignment var ama başka ticket'a ait"
        bilgisi, assignment'a hiç erişimi olmayan bir teknisyene sızabilir.
     e. Ardından `attachmentType` kontrolü: `TECHNICIAN_ALLOWED_ATTACHMENT_TYPES`
        (`BEFORE_WORK, AFTER_WORK, MATERIAL`) dışındaysa `422
        ATTACHMENT_TYPE_NOT_ALLOWED`.

   - **OPERATIONS**: ticket durumu ve attachmentType'tan bağımsız izin
     verilir. `rawAssignmentId` verilmişse (OPERATIONS güvenilir rol olduğu
     için lookup yapılır): `assignment = lookupAssignment(rawAssignmentId)`;
     `null` ise `404 ASSIGNMENT_NOT_FOUND`; `assignment.ticketId !==
     ticket.id` ise `409 ATTACHMENT_ASSIGNMENT_MISMATCH`. Teknisyene özgü
     ownership/isCurrent/status kısıtları OPERATIONS'a uygulanmaz.

Ticket entitlement: yeni bağımsız iş için aktif sözleşme şartı attachment
upload'a **uygulanmaz** — açık ticket'ı tamamlama işlemi sayılır (overrides
§5, "mevcut açık işi tamamlamak için gerekli işlemler devam edebilir").

Download endpoint'inde ticket policy **tekrar** çalışır (cache'lenmez, §10).

---

## 8. Upload güvenliği

- `MAX_FILE_SIZE_BYTES = 10_485_760` (10 MB), `ALLOWED_ATTACHMENT_MIME_TYPES
  = ['image/jpeg','image/png','image/webp']` — sabit domain constant
  (`src/common/constants/attachment.constant.ts`), env değil.
- Dosya adı asla kullanıcı girdisinden üretilmez; storage key `crypto.
  randomUUID()` tabanlı.
- Boş dosya (`size === 0`) reddi → `422 ATTACHMENT_FILE_REQUIRED`.
- Tek dosya/istek (`limits.files = 1`).
- Uzantıya güvenilmez: `file-signature.util.ts` ilk baytları okuyup magic
  number doğrular (JPEG `FFD8FF`, PNG `89504E47`, WEBP `RIFF....WEBP`) —
  yeni npm bağımlılığı eklenmez (yalnız 3 sabit format olduğu için). Beyan
  edilen `mimetype` ile sniff sonucu uyuşmazsa `415
  ATTACHMENT_UNSUPPORTED_TYPE`.
- SVG/HTML/script/exe zaten allowlist dışında (default-deny).

**Sorumluluk ayrımı — HTTP eşlemesi ile temp-dosya cleanup'ı iki ayrı
mekanizmaya bölünür:**

1. **`GlobalExceptionFilter` yalnız HTTP hata eşlemesi yapar, cleanup
   sorumluluğu filter'a verilmez.** Dosya boyutu hatası (`MulterError`)
   controller metodu çalışmadan, Multer'ın interceptor/pipe aşamasında
   oluşur; eşleme `GlobalExceptionFilter`'a (`@Catch()`, zaten her şeyi
   yakalıyor) yeni bir branch olarak eklenir:
   - `MulterError` + `code === 'LIMIT_FILE_SIZE'` → `413
     ATTACHMENT_TOO_LARGE`.
   - `MulterError` + `code === 'LIMIT_UNEXPECTED_FILE'` → `422
     VALIDATION_ERROR`.
   - Diğer `MulterError`/bozuk multipart → `422 VALIDATION_ERROR`.

   Global `ValidationPipe`'ın `forbidNonWhitelisted` davranışı sayesinde
   tanınmayan multipart body alanları, geçersiz UUID (`assignmentId`) ve
   geçersiz `attachmentType` enum değeri de otomatik `422 VALIDATION_ERROR`
   ile reddedilir (§6) — bu da `GlobalExceptionFilter`'ın mevcut
   `HttpException`→kod eşleme dalıyla zaten çalışır, yeni kod gerekmez.

2. **Temp dosya cleanup, yeni bir DI destekli `AttachmentUploadCleanupInterceptor`
   ile yapılır** (`src/modules/attachments/interceptors/
   attachment-upload-cleanup.interceptor.ts`), **filter'da değil.** Upload
   route'unda `@UseInterceptors(FileInterceptor('file'),
   AttachmentUploadCleanupInterceptor)` sırasıyla kullanılır. Bu interceptor,
   `next.handle()` zincirini (DTO/`ValidationPipe` doğrulaması + controller +
   `AttachmentService` çağrısı dahil tüm alt akışı) sarar; herhangi bir hata
   (DTO validation hatası, bilinmeyen multipart alanı, geçersiz UUID,
   geçersiz `attachmentType`, controller/service hatası) yukarı fırlarsa,
   `request.file?.path` üzerinden `storageProvider.deleteTemp()`'i
   **idempotent** şekilde çağırır (dosya zaten servis tarafından silinmişse
   `ENOENT` sessizce yutulur — hem interceptor hem service güvenle aynı yolu
   silebilir), ardından orijinal hatayı **değiştirmeden** yeniden fırlatır
   (`GlobalExceptionFilter` HTTP eşlemesini bu orijinal hata üzerinden
   yapmaya devam eder). Bu interceptor bir "safety net"tir: `AttachmentService`
   içindeki kendi cleanup adımları (§9) zaten çoğu durumda temp dosyayı
   temizler; interceptor yalnız servis hiç çalışmadan (ör. DTO pipe hatası)
   biten durumlarda temp dosyanın kesin temizlendiğini garanti eder.
   Finalize sonrası DB transaction hatasında **final storage dosyasının**
   silinmesi sorumluluğu yine `AttachmentService`'te kalır (interceptor bunu
   yapmaz — yalnız `request.file?.path`'i, yani ham temp yolu bilir, finalize
   edilmiş `storageKey`'i bilmez).

JSON/diğer endpointler etkilenmez (multipart limiti yalnız modül seviyesinde
kayıtlı Multer options'ında, global body parser değişmiyor).

Virus scanner bu fazda yok; production öncesi gereksinim olarak not
düşülecek (`docs/phase-6-plan.md` §15'te).

**Loglama:** Audit/outbox/log içine dosya içeriği, orijinal dosya adı,
`storageKey` veya fiziksel path yazılmaz. Storage hatalarında (§9, §10) dahi
yalnız `attachmentId, ticketId` ve hata sınıfı (`error.constructor.name` /
`error.code` gibi) loglanır — `storageKey` sunucu loglarına da yazılmaz.

---

## 9. DB-storage tutarlılığı ve cleanup

Seçilen model: **önce storage finalize → sonra DB insert → DB başarısızsa
compensating delete**. Şemada "pending" state alanı yok ve bu fazda
eklenmiyor (yeni kolon icat edilmiyor); bu yüzden pending-metadata modeli
yerine en basit güvenli model seçildi.

Akış (`AttachmentService.upload`), her aşamada **best-effort cleanup**
("best-effort" = cleanup hatası yalnız loglanır, asıl domain hatasını asla
ezmez/maskelemez):

1. Multer zaten dosyayı `tmp/<uuid>` altına yazmış olur (multipart alım
   sırasında ayrı bir "storage save" adımı değil, tek adım).
2. Magic-byte + boyut doğrulama (tmp dosya üzerinde). **Başarısız olursa**:
   `storageProvider.deleteTemp(tempPath)` çağrılır, ardından ilgili
   `DomainError` (`ATTACHMENT_UNSUPPORTED_TYPE`/`ATTACHMENT_FILE_REQUIRED`)
   fırlatılır.
3. `TicketReadAccessService.assertReadableAndGet` ve ardından
   `AttachmentAuthorizationPolicy.assertCanUpload` (assignment lookup'ı yalnız
   §7'de tanımlanan role-özel sırayla, gerektiğinde kendi içinde çağırır).
   **Herhangi biri başarısız olursa**: `storageProvider.deleteTemp(tempPath)`
   çağrılır, ardından ilgili `DomainError` fırlatılır (temp dosya asla
   yetkisiz bir işlem sonrası diskte kalmaz).
4. `storageProvider.finalize()` → tmp dosya `attachments/<uuid>`'e rename
   edilir. **`finalize` hata verirse** (ör. disk I/O hatası): kalan temp
   dosya `deleteTemp` ile temizlenir, `500 ATTACHMENT_STORAGE_FAILED`
   fırlatılır.
5. `prisma.$transaction`: `ticketAttachmentRepository.create(tx, {...})` +
   `auditWriter.log(tx, ATTACHMENT_UPLOADED)` + `outboxService.publishInTx(tx,
   AttachmentUploaded)`. **Başarısız olursa** (constraint ihlali, mismatch
   vb.): `storageProvider.delete(storageKey)` (finalize edilmiş final dosya,
   artık temp değil) best-effort compensating delete edilir, orijinal
   `DomainError` yeniden fırlatılır.
6. Response/stream sonrası hata: DB commit zaten tamamlandığı için ek işlem
   gerekmez (attachment kalıcı olarak oluşmuştur).
7. Aynı isteğin tekrarı: idempotency key yok (istenmedi); her tekrar yeni bir
   attachment satırı + yeni storage key üretir.
8. **Süreç çökmesi (crash) senaryoları — açıkça iki farklı orphan türü var,
   bu fazda ikisi için de otomatik reconciliation yazılmaz:**
   - Normal (çökme olmayan) request hatalarında temp veya final dosya §9
     adım 2-5'teki gibi senkron olarak cleanup edilir (artı §8'deki
     `AttachmentUploadCleanupInterceptor` safety-net'i).
   - Süreç, Multer temp dosyayı **yazarken** kapanırsa: `tmp/` altında
     DB'ye hiç girmemiş, referanssız, zararsız bir orphan kalır.
   - Süreç, **finalize sonrasında fakat DB commit'ten önce** kapanırsa:
     `attachments/` altında metadata satırı olmayan bir final-dosya orphan'ı
     kalır (bu senaryo öncekinden farklı ve ayrıca belirtilir — dosya zaten
     "kalıcı" konumuna taşınmış ama hiçbir `TicketAttachment` satırı ona
     işaret etmiyor).
   - Bu fazda ne `tmp/` ne de `attachments/` için otomatik cleanup/
     reconciliation job'ı yazılır. Periyodik temp **ve** final orphan
     reconciliation, operasyonel hardening kapsamına (gelecek faz/ops görevi)
     bırakılır.

---

## 10. Download/stream davranışı

`GET /attachments/:id/download` (ticketId path param'ı **yok**):

**IDOR/varlık sızıntısı önleme — üç farklı başarısızlık senaryosunun hepsi
aynı sonucu üretir: `404 ATTACHMENT_NOT_FOUND`.** Attachment bulunamaması,
soft-deleted olması ve parent ticket'ın actor tarafından okunamaması
birbirinden ayırt edilmez (aksi halde `TICKET_NOT_FOUND` farklı bir kod
döndürüp attachment'ın var olduğunu ima ederdi).

1. `attachment = ticketAttachmentRepository.findById(client, id)` —
   `deletedAt IS NULL`; bulunamazsa (yok veya soft-deleted) `404
   ATTACHMENT_NOT_FOUND`.
2. `TicketReadAccessService.assertReadableAndGet(actor, attachment.ticketId,
   client)` — metadata'dan bulunan `ticketId` üzerinden **tekrar** çalışır
   (cache yok). Bu çağrı erişim reddinde kendi iç sözleşmesi gereği `404
   TICKET_NOT_FOUND` fırlatır (ticket modülünün genel davranışı); **download
   akışı bu belirli hatayı yakalayıp `404 ATTACHMENT_NOT_FOUND` olarak
   yeniden fırlatır** — böylece dışarıya hep aynı kod çıkar, "ticket mi yok
   yoksa attachment'a mı erişilemiyor" ayrımı sızmaz. Bu dönüşüm **yalnız
   download endpoint'inde** yapılır; `GET /tickets/:ticketId/attachments`
   listeleme endpoint'i `TICKET_NOT_FOUND`'u aynen kullanmaya devam eder
   (orada zaten path'te ticketId var, ayrım sızıntısı söz konusu değil).
3. `storageProvider.openReadStream(attachment.storageKey)` — dosya yoksa
   (`ENOENT`) → `500 ATTACHMENT_STORAGE_FAILED` (metadata var, fiziksel
   dosya yok — entegrasyon bozukluğu, client hatası değil; yalnız
   `attachmentId, ticketId` ve hata sınıfı loglanır, §8).
4. Response header'ları: `Content-Type: attachment.mimeType`,
   `Content-Length: attachment.fileSize`, `Content-Disposition: attachment;
   filename="<ascii-safe>"; filename*=UTF-8''<encodeURIComponent>` (RFC 5987
   escaping — orijinal dosya adı header injection'a karşı sanitize edilir),
   `X-Content-Type-Options: nosniff`.
5. Stream hata verirse (`error` event) response zaten başlamışsa bağlantı
   kapatılır, başlamamışsa 500 döner; local path/storage key hiçbir zaman
   response'a veya header'a yazılmaz.

**Gerekçe (mimarideki "signed URL" fikri neden uygulanmıyor):** Mimari
dokümanı `GET /attachments/:id/url` + 5 dakikalık signed URL öneriyor; bu S3
için doğaldır (native presigned URL). Bu fazda yalnız local storage
uygulandığından, kendi imzalı-token mekanizmamızı icat etmek yerine — zaten
her istekte JWT ile authenticate olan, ticket policy'yi her erişimde tekrar
çalıştıran doğrudan stream endpoint'i tercih edildi. S3 eklendiğinde native
presigned URL bu endpoint'in yanına ayrı bir opsiyon olarak eklenebilir.

---

## 11. Audit/outbox

`DOMAIN_AUDIT_ACTIONS`'a eklenecek: `ATTACHMENT_UPLOADED`.
(`ATTACHMENT_DOWNLOADED` eklenmiyor — mevcut kodda okuma/indirme işlemleri
zaten audit'lenmiyor, hacim ve PII riski nedeniyle bu fazda da eklenmiyor.)

Audit metadata: `{ attachmentId, ticketId, assignmentId, mimeType, fileSize,
attachmentType, storageProvider }` — orijinal dosya adı, path, storage key,
checksum, dosya içeriği asla yazılmaz.

Outbox event: `AttachmentUploaded` — aynı minimal payload, relay bu fazda
yapılmaz (`OutboxService.publishInTx` mevcut davranışıyla yalnızca `PENDING`
satır yazar).

---

## 12. Config ve hata kodları

**`src/config/configuration.ts`** — yeni `registerAs('storage', ...)` slice'ı
mevcut doğrulanmış env alanlarını gruplar (yeni env eklenmez):
`{ provider, localPath, s3: { endpoint, region, bucket, accessKey, secretKey,
forcePathStyle } }`. `src/app.module.ts`'in `ConfigModule.forRoot({ load:
[...] })` dizisine eklenir; `imports` dizisine `AttachmentsModule` eklenir.

**Yeni hata kodları** (`error-codes.constant.ts`):

| Kod | HTTP | Kullanım |
|---|---|---|
| `ATTACHMENT_NOT_FOUND` | 404 | attachment yok / soft-deleted / **download'da** parent ticket actor tarafından okunamıyor (bkz. §10, `TICKET_NOT_FOUND`'dan dönüştürülür) |
| `ASSIGNMENT_NOT_FOUND` | 404 | (mevcut, Faz 5) assignment yok/erişilemez/isCurrent=false/uygun olmayan durum |
| `ATTACHMENT_FILE_REQUIRED` | 422 | dosya yok veya boş |
| `ATTACHMENT_TOO_LARGE` | 413 | boyut limiti aşıldı (MulterError → filter eşlemesi) |
| `ATTACHMENT_UNSUPPORTED_TYPE` | 415 | MIME allowlist dışı / sniff uyuşmazlığı |
| `ATTACHMENT_TYPE_NOT_ALLOWED` | 422 | teknisyen izinli olmayan `attachmentType` seçti |
| `ATTACHMENT_UPLOAD_NOT_ALLOWED` | 403 | resident/site_manager assignment'lı upload denemesi |
| `TICKET_UPDATE_FORBIDDEN` | 403 | (mevcut, ticket modülü) resident/site_manager CLOSED/CANCELLED ticket'a upload denemesi |
| `ATTACHMENT_ASSIGNMENT_MISMATCH` | 409 | assignment başka ticket'a ait |
| `ATTACHMENT_STORAGE_FAILED` | 500 | storage altyapı hatası (dosya kayıp/erişilemez/finalize hatası) |
| `VALIDATION_ERROR` | 422 | (mevcut) MulterError LIMIT_UNEXPECTED_FILE, bozuk multipart, whitelist-dışı alan |

---

## 13. Unit/integration/E2E testleri

**Unit:**
- `storage-key.util.ts` path traversal guard (`../` denemeleri reddedilir).
- `file-signature.util.ts` — 3 izinli format + uyuşmayan içerik senaryoları.
- `AttachmentAuthorizationPolicy` — rol × ticket durumu × assignment
  (var/yok, isCurrent, status) × attachmentType kombinasyonları; her
  kombinasyonun ürettiği kesin kod/HTTP status doğrulanır.
- `attachment.mapper.ts` — `storageKey/storageProvider/checksum` sızmıyor.
- `AttachmentService.upload` — sırasıyla: (a) MIME/boyut hatasında
  `deleteTemp` çağrıldığı, (b) authorization hatasında `deleteTemp` çağrıldığı,
  (c) `finalize` hatasında `deleteTemp` çağrıldığı, (d) DB transaction
  hatasında `delete` (final storageKey) çağrıldığı — her senaryoda cleanup
  hatası yutulup orijinal `DomainError`'ın değişmeden fırlatıldığı (mock
  storage/repo ile).
- `AttachmentUploadCleanupInterceptor` — DTO/pipe hatası simüle edilip
  `deleteTemp`'in çağrıldığı; servis zaten `deleteTemp` çağırmışsa
  interceptor'ın ikinci çağrısının hata vermediği (idempotency) test edilir.
- RESIDENT/SITE_MANAGER + `assignmentId` verilen senaryoda
  `AssignmentLookupService`'in **hiç çağrılmadığı** (mock ile invoke
  sayısı 0) doğrulanır.
- Download akışında `TicketReadAccessService`'in fırlattığı
  `TICKET_NOT_FOUND`'ın `ATTACHMENT_NOT_FOUND`'a çevrildiği test edilir.

**Integration (gerçek PostgreSQL, `postgres-testcontainer.ts` reused —
`STORAGE_PROVIDER=local` zaten `configureBaseTestEnv`'de ayarlı):**
- Attachment metadata insert + `ticketId` ilişkisi.
- `assignmentId`/`ticketId` composite FK — yanlış kombinasyon DB seviyesinde
  reddediliyor mu.
- Cross-site erişim → 404.
- Başka teknisyenin assignment'ına yükleme → 404 `ASSIGNMENT_NOT_FOUND`.
- `isCurrent=false` assignment'a yükleme → 404 `ASSIGNMENT_NOT_FOUND`.
- `COMPLETED` assignment'a yükleme → 404 `ASSIGNMENT_NOT_FOUND` (409 değil —
  tek ve kesin sonuç, §7).
- Teknisyenin kendisine ait, current, `ACCEPTED`/`ACTIVE` durumundaki ama
  **başka ticket'a ait** assignment'a yükleme → 409
  `ATTACHMENT_ASSIGNMENT_MISMATCH` (404 değil — §7 adım (c) geçtikten sonra
  (d) kontrolü).
- DB insert başarısızlığında final storage dosyasının silindiği (gerçek
  dosya sistemi ile, geçici test dizini kullanılır).
- Orphan metadata/dosya oluşmadığının doğrulanması.
- Composite FK migration: yanlış `(assignment_id, ticket_id)` kombinasyonu
  ile doğrudan SQL insert denemesinin DB seviyesinde reddedildiği; FK'nin
  `ON DELETE RESTRICT` davranışının mevcut iki FK ile tutarlı olduğu.

**E2E (gerçek HTTP + multipart, `test/e2e/attachments.e2e-spec.ts`):**
- Geçerli küçük JPEG upload → 201, response şekli doğru.
- Listeleme (cursor pagination).
- Download (`GET /attachments/:id/download`) → doğru header'lar +
  byte-eşleşmesi.
- Yetkisiz tenant → 404 (listeleme: `TICKET_NOT_FOUND` anlamıyla; download:
  `ATTACHMENT_NOT_FOUND`, §10).
- Başka teknisyen → 404 `ASSIGNMENT_NOT_FOUND`.
- RESIDENT kendi ticket'ı → 201; başkasının ticket'ı → 404.
- RESIDENT/SITE_MANAGER `CLOSED`/`CANCELLED` ticket'a upload → 403
  `TICKET_UPDATE_FORBIDDEN`.
- RESIDENT `assignmentId` ile upload dener → 403
  `ATTACHMENT_UPLOAD_NOT_ALLOWED` (assignment gerçekten var olsa bile lookup
  yapılmadığı, yalnız HTTP sonucu üzerinden doğrulanır).
- Gerçek HTTP isteğiyle büyük dosya → 413 `ATTACHMENT_TOO_LARGE` (Multer
  `LIMIT_FILE_SIZE` → filter eşlemesi uçtan uca doğrulanır) **ve** tmp
  dosyasının diskte kalmadığı doğrulanır.
- İzinsiz MIME (örn. `text/plain`) → 415, tmp dosyası temizlenir.
- Boş dosya → 422.
- Assignment-ticket mismatch (teknisyenin kendi current/active
  assignment'ı başka ticket'a ait) → 409.
- Bilinmeyen multipart body alanı → 422, tmp dosyası temizlenir
  (`AttachmentUploadCleanupInterceptor` DTO pipe hatasında devreye girer).
- Geçersiz UUID (`assignmentId`) / geçersiz `attachmentType` → 422, tmp
  dosyası temizlenir.
- Download endpoint'i attachment yok / soft-deleted / ticket okunamıyor —
  üçü de → 404 `ATTACHMENT_NOT_FOUND` (aynı response şekli, ayırt edilemez).
- Storage dosyasının gerçekten diskte oluştuğu, test sonunda temp/attachment
  dizinlerinin temizlendiği.
- Faz 1-5 regresyon (mevcut e2e suite'in bozulmadığı).

Test fixture'ları: küçük in-memory buffer'lardan üretilen sahte JPEG/PNG
(gerçek zararlı dosya kullanılmaz).

---

## 14. Doğrulama komutları

```
npm ci
npm run lint
npm run build
npm run prisma:format
npm run prisma:validate
docker compose config
npm test
npm run test:integration
npm run test:e2e
```

---

## 15. Açık kararlar (kalan, kullanıcı düzeltmeleriyle çözülmeyenler)

1. **`ATTACHMENT_ASSIGNMENT_MISMATCH` → 409 seçildi** (422 de savunulabilir);
   mevcut kodda benzer "geçerli iki kaynağın birbiriyle uyuşmaması"
   durumları (`ASSIGNMENT_MATERIAL_NOT_ALLOWED`) 409 kullanıyor, tutarlılık
   için 409 seçildi.
2. **RESIDENT/SITE_MANAGER + CLOSED/CANCELLED ticket** durumunda yeni bir kod
   icat etmek yerine mevcut `TICKET_UPDATE_FORBIDDEN` (403, ticket modülü)
   yeniden kullanıldı — semantik olarak aynı "rol + ticket durumu
   değişikliğe izin vermiyor" kuralı.
3. **Idempotency/dedupe yok.** Aynı dosyanın tekrar yüklenmesi yeni bir satır
   + yeni storage key üretir; checksum bazlı dedupe istenmedi, eklenmedi.
4. **Otomatik `tmp/` ve `attachments/` reconciliation job'ı (process-crash
   senaryoları için) bu fazda yazılmadı.** Senkron request-lifecycle
   cleanup (§9 adım 2-5 + `AttachmentUploadCleanupInterceptor` safety-net'i)
   zorunlu ve uygulanıyor; yalnız süreç çökmesi gibi request-dışı iki orphan
   türü (temp-yazım-sırasında ve finalize-sonrası-commit-öncesi, §9 madde 8)
   için periyodik reconciliation ops/gelecek-faz notu olarak düşülüyor.
5. **`ATTACHMENT_DOWNLOADED` audit action'ı eklenmedi** (hacim/PII kaygısı,
   mevcut kodda okuma işlemleri zaten audit'lenmiyor). Gerekirse eklenebilir.
6. **Composite FK migration'ının tam olarak hangi teknikle (elle dosya
   oluşturma vs. `--create-only`) yazılacağı, Faz 5'in `(id, ticket_id)`
   unique constraint migration'ının implementasyon sırasında incelenmesine
   bağlıdır** (§2) — bu plan yalnız "aynı teknik izlenecek ve `ON DELETE
   RESTRICT` mevcut FK'lerle tutarlı olacak" ilkesini koyar; kaynak dosya
   şu an yeniden incelenmediği için tam adım adım komut burada
   sabitlenmedi.
7. **`multer`/`@types/multer` paketlerinin gerçekten eklenmesi gerekip
   gerekmediği implementasyon başında `package.json` kontrolüyle netleşecek**
   (§4) — önceki keşif bunların yalnız transitive olduğunu gösterdi; kesin
   ekleme kararı derleme/import denemesiyle doğrulanacak.

---

## İmplementasyon notları (plan onayından sonra, gerçek kodla doğrulanan düzeltmeler)

Bu bölüm, planın onaylanmış halinden implementasyon sırasında ortaya çıkan ve
plan metnini değil yalnız gerçekleştirme detayını etkileyen iki bulguyu
kayıt altına alır:

1. **Composite FK zaten mevcuttu, yeni migration yazılmadı (§2, Açık Karar
   6'nın çözümü).** `prisma/migrations/20260710000100_custom_constraints/
   migration.sql` incelendiğinde, `assignments (id, ticket_id)` non-partial
   unique constraint'in VE `ticket_attachments (assignment_id, ticket_id) →
   assignments (id, ticket_id)` composite FK'nin bu migration'da **halihazırda
   yazılmış** olduğu görüldü (10. madde, overrides #4 referansıyla). Bu
   migration önceki bir fazda, Faz 6'yı önceden öngörerek eklenmiş. Sonuç:
   Faz 6 kapsamında yeni bir migration dosyası oluşturulmadı; composite FK
   gerçek PostgreSQL integration testleriyle doğrulandı (bkz.
   `test/integration/attachments/attachment-upload.integration-spec.ts`,
   "composite FK" testi). `ON DELETE` için mevcut kısıt `RESTRICT` değil
   varsayılan `NO ACTION` kullanıyor (constraint zaten committed/applied
   olduğundan değiştirilmedi — geriye dönük migration değişikliği riskli
   kabul edildi); pratikte iki davranış bu deferrable-olmayan constraint için
   ayırt edilemez.
2. **`GlobalExceptionFilter`'da ham `MulterError` yakalama mantığı kaldırıldı
   (§8, §12).** `@nestjs/platform-express`'in `FileInterceptor`'ı, multer
   hatalarını filtre'ye ulaşmadan ÖNCE kendi `transformException` yardımcısıyla
   standart `HttpException` alt sınıflarına çeviriyor
   (`LIMIT_FILE_SIZE` → `PayloadTooLargeException` /413, diğerleri →
   `BadRequestException`/400) — ham `MulterError` filtreye hiçbir zaman
   ulaşmıyor. Bu yüzden planın öngördüğü "filter'da `instanceof MulterError`
   kontrolü" yerine, `mapStatusToCode`'a `HttpStatus.PAYLOAD_TOO_LARGE →
   ATTACHMENT_TOO_LARGE` eşlemesi eklendi (413'ün bu fazdaki tek kaynağı bu
   olduğundan generic status-eşleme yeterli); `LIMIT_UNEXPECTED_FILE`/bozuk
   multipart zaten mevcut `BAD_REQUEST → VALIDATION_ERROR` dalına düşüyor.
   Gerçek HTTP e2e testiyle doğrulandı (413/`ATTACHMENT_TOO_LARGE` senaryosu).

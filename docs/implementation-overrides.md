# Site Teknik Destek Sistemi — Implementation Overrides

Bu dosya, `docs/architecture.md` içindeki çelişkili veya eski teknik hükümleri
geçersiz kılar. Yeni iş kuralı üretmez. Burada açıkça değiştirilmeyen mimari
kararlar geçerliliğini korur.

## 1. Araç zinciri

- Node.js 24 LTS kullanılacak.
- Docker taban imajları `node:24-alpine` ailesinden seçilecek.
- PostgreSQL 16 kullanılacak.
- Güncel ve birbirleriyle uyumlu NestJS paketleri kurulacak.
- Prisma 7 kullanılacak.
- PostgreSQL bağlantısı için `@prisma/adapter-pg`, `pg` ve gerekli TypeScript
  tipleri kurulacak.
- Prisma bağlantı URL'si `schema.prisma` içinde değil, `prisma.config.ts`
  içinde tanımlanacak.
- Prisma Client güncel `prisma-client` generator yaklaşımıyla açık bir output
  dizinine üretilecek.
- Kurulan paket sürümleri `package-lock.json` ile sabitlenecek.

## 2. PostgreSQL tarih türleri

Anlık zamanı ifade eden bütün Prisma `DateTime` alanları açıkça:

`@db.Timestamptz(6)`

kullanacak.

Yalnız aşağıdaki takvim tarihi alanları `@db.Date` olarak kalacak:

- `Contract.startDate`
- `Contract.endDate`
- `ContractInvoice.billingPeriodStart`
- `ContractInvoice.billingPeriodEnd`
- `ContractInvoice.issueDate`
- `ContractInvoice.dueDate`

`paidAt`, `createdAt`, `updatedAt`, `expiresAt`, `revokedAt`, `acceptedAt`,
`completedAt` ve benzeri alanlar `@db.Timestamptz(6)` olacak.

## 3. Tenant izolasyonu ve siteId

`siteId` her operasyonel tabloya kopyalanmayacak.

Doğrudan site kapsamı taşıyan temel modeller:

- `SiteMembership.siteId`
- SITE dışındaki `Facility.siteId`
- `Ticket.siteId`
- `Contract.siteId`
- `AuditLog.siteId` nullable

Aşağıdaki modeller site kapsamını üst ilişkilerinden türetir:

- `ResidentUnitAssignment` → `unit.siteId`
- `Assignment` → `ticket.siteId`
- `AssignmentMaterial` → `assignment.ticket.siteId`
- `TicketAttachment` → `ticket.siteId`
- `ContractInvoice` → `contract.siteId`

Repository metotları anonim bir "tüm kayıtlar" sorgusu sunmayacak.

- Site kapsamlı metotlar `siteId` veya doğrulanmış bir `SiteScope` nesnesi
  almak zorunda olacak.
- Assignment ve attachment sorguları ticket üzerinden site filtresi uygulayacak.
- Invoice sorguları contract üzerinden site filtresi uygulayacak.
- Siteler arası sorgular yalnız OPERATIONS için açıkça adlandırılmış ayrı
  repository metotlarında bulunacak.
- Controller'dan gelen `siteId` güvenilir kabul edilmeyecek.

## 4. Attachment, assignment ve ticket bütünlüğü

Bir `TicketAttachment` içinde `assignmentId` verilmişse assignment aynı
`ticketId` değerine ait olmak zorundadır.

Uygulama katmanı:

- Attachment oluşturulurken assignment transaction içinde okunacak.
- `assignment.ticketId === attachment.ticketId` doğrulanacak.
- Uyuşmazlık `ATTACHMENT_ASSIGNMENT_MISMATCH` hatasıyla reddedilecek.

Veritabanı katmanı:

- `assignments` üzerinde `(id, ticket_id)` için non-partial unique constraint
  oluşturulacak.
- `ticket_attachments (assignment_id, ticket_id)` alanlarından
  `assignments (id, ticket_id)` alanlarına composite foreign key eklenecek.
- `assignment_id` nullable kalacak. Null olduğunda attachment yalnız ticket'a
  bağlıdır.
- Prisma'nın ifade edemediği veya migration üretmediği kısım özel PostgreSQL
  migration SQL'iyle uygulanacak.

## 5. Authentication ve sözleşme entitlement ayrımı

Aktif sözleşme, kullanıcının OTP alıp sisteme giriş yapmasının şartı değildir.

Login uygunluğu:

- OPERATIONS ve TECHNICIAN için aktif, silinmemiş kullanıcı hesabı yeterlidir.
- RESIDENT ve SITE_MANAGER için aktif, silinmemiş kullanıcı hesabı ve en az
  bir aktif site üyeliği gerekir.
- Contract durumu authentication kontrolünde kullanılmaz.

Feature entitlement kuralları:

- Geçmiş ticket, fatura ve sözleşme kayıtlarını görüntüleme, aktif üyelik ve
  kaynak erişimi varsa sözleşme sona ermiş olsa da mümkündür.
- Yeni ticket oluşturmak aktif sözleşme gerektirir.
- Yeni ve bağımsız bir iş başlatmak aktif sözleşme gerektirir.
- Sözleşme askıya alınmış, sona ermiş veya feshedilmiş olsa bile daha önce
  açılmış ve henüz kapanmamış işler tamamlanabilir.
- Mevcut açık işi tamamlamak için gerekli kabul, durum geçişi ve gerektiğinde
  yeniden atama işlemleri devam edebilir.
- SLA hedefi yalnız ticket oluşturulduğu anda geçerli aktif sözleşmeden
  hesaplanır.

Bu kurallar ayrı bir entitlement/policy katmanında uygulanacak. Auth service
contract repository'sine bağımlı olmayacak.

## 6. OTP hatalı deneme transaction modeli

Beklenen authentication başarısızlıklarında transaction callback'i içinden
exception fırlatılarak yapılan güncellemeler rollback ettirilmeyecek.

OTP verify transaction'ı discriminated-result döndürecek. Örnek sonuç türleri:

- `SUCCESS`
- `INVALID_OTP`
- `MAX_ATTEMPTS_REACHED`
- `USER_INACTIVE`

Hatalı kodda transaction içinde:

1. Challenge satırı `FOR UPDATE` ile kilitlenir.
2. `attemptCount` artırılır.
3. Limit dolduysa challenge invalid edilir.
4. Audit kaydı transaction client ile yazılır.
5. Transaction bir hata sonucu döndürerek normal biçimde commit edilir.

Transaction tamamlandıktan sonra service sonucu uygun `DomainError` hatasına
çevirir. Yalnız beklenmeyen altyapı hataları exception fırlatıp rollback
yaptırabilir.

## 7. Başarılı OTP doğrulamasının atomikliği

Başarılı login sırasında aşağıdaki veritabanı işlemleri aynı transaction içinde
yapılacak:

- OTP challenge satırını kilitleme ve tüketme
- Kullanıcı aktifliği ve login uygunluğunu yeniden doğrulama
- Refresh session oluşturma
- `lastLoginAt` güncelleme
- Başarılı login audit kaydı

Raw refresh token ve session UUID transaction öncesinde güvenli rastgele
üretilebilir. Yalnız token hash'i veritabanına yazılır.

Access JWT üretimi veritabanı transaction'ından sonra yapılır. JWT üretimi
başarısız olursa yeni refresh session ayrı bir güvenli telafi işlemiyle revoke
edilir.

## 8. Refresh-token reuse detection

Kullanılmış veya revoke edilmiş refresh token yeniden sunulduğunda:

1. Session satırı `FOR UPDATE` ile okunur.
2. Kullanıcının bütün aktif refresh session'ları revoke edilir.
3. Reuse-detection audit kaydı aynı transaction içinde yazılır.
4. Transaction `REUSE_DETECTED` sonucu döndürerek commit edilir.
5. Commit sonrasında `AUTH_INVALID_REFRESH` döndürülür.

`revokeAllForUser` işleminden sonra aynı transaction içinde exception
fırlatılmayacak.

## 9. Ticket ve assignment orkestrasyonu

Ticket ve assignment durumlarını birbirinden bağımsız servisler güncellemeyecek.

Tek bir `TicketAssignmentWorkflowService`:

- Transaction'ı başlatır.
- Her zaman önce ticket, sonra current assignment satırını kilitler.
- Ticket state machine ve assignment state kurallarını doğrular.
- İki modeli birlikte günceller.
- History, audit ve outbox kayıtlarını aynı transaction'da yazar.

Assignment durumlarının anlamı:

- `PENDING`: teknisyen atandı, yanıt bekleniyor.
- `ACCEPTED`: teknisyen atamayı kabul etti, henüz yola çıkmadı.
- `ACTIVE`: `EN_ROUTE` olayıyla başlar ve ARRIVED, IN_PROGRESS,
  WAITING_MATERIAL aşamalarında devam eder.
- `COMPLETED`: ticket COMPLETED olduğunda assignment da tamamlanır.
- `REJECTED`, `CANCELLED`, `REASSIGNED`: terminal atama durumlarıdır.

Aynı durumdan aynı duruma geçiş reddedilecek:

- `from === to` olduğunda ticket güncellenmeyecek.
- Ticket status history yazılmayacak.
- `409 TICKET_STATUS_UNCHANGED` döndürülecek.

Ticket zaten `ASSIGNED` iken teknisyen değiştirilirse:

- Eski assignment `REASSIGNED` ve `isCurrent=false` yapılır.
- Yeni assignment `PENDING` olarak oluşturulur.
- Ticket durumu değişmediği için ikinci bir `ASSIGNED → ASSIGNED` history kaydı
  yazılmaz.
- Assignment audit ve outbox kayıtları yine yazılır.

## 10. SITE oluşturma yetkisi

MVP'de PLATFORM_ADMIN rolü eklenmeyecek.

- SITE, BLOCK, UNIT ve COMMON_AREA oluşturma yetkisi OPERATIONS rolünde kalır.
- SITE_MANAGER yalnız kendi sitesindeki sakin ve unit eşleştirme işlemlerini
  yönetebilir.
- Prisma enum, RBAC matrisi ve endpointler bu kararla tutarlı olmalıdır.

## 11. Environment doğrulaması

Zod şemasında bütün kullanılan environment değişkenleri tanımlanacak.

En az:

- `NODE_ENV`
- `PORT`
- `DATABASE_URL`
- `JWT_ACCESS_SECRET`
- `JWT_ACCESS_EXPIRES_IN`
- `REFRESH_TOKEN_PEPPER`
- `REFRESH_TOKEN_EXPIRES_IN`
- `OTP_HMAC_SECRET`
- `OTP_EXPIRES_IN_SECONDS`
- `OTP_MAX_ATTEMPTS`
- `OTP_RESEND_COOLDOWN_SECONDS`
- `SMS_PROVIDER`
- `SMS_API_URL`
- `SMS_API_KEY`
- `STORAGE_PROVIDER`
- `STORAGE_LOCAL_PATH`
- `S3_ENDPOINT`
- `S3_REGION`
- `S3_BUCKET`
- `S3_ACCESS_KEY`
- `S3_SECRET_KEY`
- `S3_FORCE_PATH_STYLE`
- `CORS_ALLOWED_ORIGINS`
- `LOG_LEVEL`

Koşullu doğrulama:

- Production ortamında `SMS_PROVIDER=mock` reddedilir.
- `SMS_PROVIDER=external` ise `SMS_API_URL` ve `SMS_API_KEY` zorunludur.
- `STORAGE_PROVIDER=local` ise `STORAGE_LOCAL_PATH` zorunludur.
- `STORAGE_PROVIDER=s3` ise region, bucket, access key ve secret key zorunludur.
- `S3_ENDPOINT` AWS dışı S3 uyumlu servisler için opsiyoneldir.
- Doğrulama yalnız parse edilmiş Zod nesnesini kullanır, doğrudan
  `process.env` okumaz.

## 12. Docker geliştirme ortamı

Production Dockerfile multi-stage ve non-root kullanıcıyla çalışacak.

Development Compose:

- API source code'unu container içine volume olarak bağlayacak.
- Container içindeki `node_modules` ayrı named veya anonymous volume olacak.
- `npm run start:dev` ile hot reload çalışacak.
- Upload klasörü container kullanıcısı tarafından yazılabilir olacak.
- PostgreSQL healthcheck kullanılacak.
- API, DB healthy olmadan başlamayacak.
- Production ve development davranışları birbirinden ayrılacak.

## 13. Mimari örnek kodların statüsü

`docs/architecture.md` içindeki servis kodları doğrudan kopyalanacak üretim kodu
değildir. Bazılarında eksik constructor, tanımsız metot ve placeholder vardır.

- Yalnız mevcut fazda gereken kod yazılacak.
- Oluşturulan bütün interface metotları gerçekten uygulanacak.
- `/* ... */`, boş metot veya tanımsız dependency bırakılmayacak.
- Domain servisleri kendi fazları gelmeden oluşturulmayacak.
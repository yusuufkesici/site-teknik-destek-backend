# Manuel Kabul Testi — Bruno Koleksiyonu ve Doğrulama Runbook'u

Faz 9 Slice 3C çıktısı. Bu belge, `manual-tests/bruno/` altındaki Bruno
koleksiyonuyla uçtan uca manuel kabul testinin nasıl koşulacağını ve HTTP
yüzeyi olmayan yan etkilerin (outbox, notification delivery, audit,
zamanlanmış job'lar, dosya depolama) salt-okunur SQL/dosya kontrolleriyle
nasıl doğrulanacağını tanımlar.

## 1. Amaç

- Faz 1–8'de uygulanan tüm ana akışların gerçek çalışan uygulama üzerinde,
  API sözleşmesine (route, DTO, hata kodu, HTTP status) birebir uyarak
  doğrulanması.
- Negatif senaryolarda doğru hata kodu ve status'un döndüğünün kanıtlanması.
- Doğrudan HTTP endpoint'i olmayan yan etkilerin (outbox, SMS teslimat
  kuyruğu, audit, cron job'ları) yalnız `SELECT` sorgularıyla doğrulanması.
- Kabul sonucunun kayıt altına alınması (bkz. Bölüm 20).

Koleksiyon hiçbir gerçek secret, OTP veya token içermez; bu değerler yalnız
çalışma anında Bruno runtime değişkenlerine (`bru.setVar`) yazılır ve
diske kalıcı olarak kaydedilmez.

## 2. Ön koşullar

- Docker Desktop (PostgreSQL 16 container'ı için).
- Node.js 24 LTS ve npm (uygulama host üzerinde çalıştırılacaksa).
- [Bruno](https://www.usebruno.com/) masaüstü uygulaması (koleksiyonu GUI'de
  koşmak için). Bruno CLI repoya **bilinçli olarak kurulmamıştır**; kabul
  testi manueldir.
- Depo kökünde `.env` dosyası (`.env.example`'dan türetilmiş). Bu runbook
  yalnız geliştirme ortamı içindir: `NODE_ENV=development`,
  `SMS_PROVIDER=mock`, `STORAGE_PROVIDER=local` varsayılır.
- 3000 (API) ve 5432 (PostgreSQL) portları boş olmalıdır.

## 3. Docker/PostgreSQL başlatma

```powershell
docker compose up -d db
docker compose ps   # db "healthy" olana kadar bekleyin
```

Compose healthcheck `pg_isready` kullanır; API host'ta koşulacaksa yalnız
`db` servisini başlatmak yeterlidir.

## 4. Migration deploy

Host üzerinde (`.env` içindeki `DATABASE_URL=postgresql://app:app@localhost:5432/site_support` ile):

```powershell
npx prisma migrate deploy
```

Beklenen: tüm migration'lar "applied" durumda, hata yok.

## 5. Seed çalıştırma

```powershell
npm run db:seed
```

- Seed idempotenttir: tekrar çalıştırmak duplicate üretmez, seed dışı veriyi
  silmez.
- `NODE_ENV` development/test değilse seed **veritabanına dokunmadan** hata
  ile durur.
- Seed her koşumda: geçici sakini (+905550000006) yeniden aktifleştirir,
  Panorama sözleşmesini içinde bulunulan yılı kapsayan ACTIVE durumuna,
  Marina sözleşmesini "10 gün sonra bitecek + `expiry_notified_at IS NULL`"
  durumuna geri döndürür (job senaryoları tekrarlanabilir kalır).
- Sabit kimlikler ve telefonlar: `prisma/seed.ts` içindeki `SEED_IDS` /
  `SEED_PHONES` tabloları. Bruno environment'ı aynı değerleri kullanır.

## 6. Uygulama başlatma

Host üzerinde (önerilen; Bruno da host'ta koşar):

```powershell
$env:DEV_SMS_INBOX_ENABLED = 'true'
npm run start:dev
```

Alternatif (container içinde): `.env` dosyasına `DEV_SMS_INBOX_ENABLED=true`
satırını ekleyip `docker compose up -d` (compose `env_file: .env` okur).

Doğrulama: `GET http://localhost:3000/api/v1/health/readiness` → 200.

Notlar:

- `BACKGROUND_JOBS_ENABLED` ve `OUTBOX_RELAY_ENABLED` verilmezse
  development'ta varsayılan **true**'dur (production'da açıkça verilmeleri
  zorunludur). Yani OutboxRelay ve NotificationDeliveryRelay kabul testi
  sırasında otomatik çalışır.
- Tüm API rotaları `/api/v1` prefix'i altındadır.

## 7. Dev SMS inbox güvenlik koşulları

`GET /api/v1/dev/sms/:phone/last-otp` yalnız **çift koşulla** açılır:
`NODE_ENV=development` **ve** `DEV_SMS_INBOX_ENABLED=true`. Aksi halde route
hiç mount edilmez / 404 döner.

- OTP kodu yalnız process belleğinde tutulur (TTL 5 dk, en fazla 50 kayıt);
  loglanmaz, veritabanına veya dosyaya yazılmaz.
- Production'da `SMS_PROVIDER=mock` zaten env doğrulamasında reddedilir;
  inbox flag'i production'da `true` olsa bile devre dışıdır.
- Bu endpoint'i asla development dışında bir ortamda etkinleştirmeyin.

## 8. Bruno kurulumu ve koleksiyon açma

1. Bruno masaüstü uygulamasını kurun.
2. "Open Collection" ile depo içindeki `manual-tests/bruno/` klasörünü açın.
3. Klasörler numaralıdır (`01-health` … `10-negative`); istekler klasör
   içinde `seq` sırasıyla listelenir. **Sıra önemlidir**: her istek, önceki
   isteklerin `bru.setVar` ile yazdığı runtime değişkenlerine bağımlıdır.

## 9. Environment seçimi

Sağ üstteki environment seçiciden **local** ortamını seçin
(`manual-tests/bruno/environments/local.bru`).

- Environment yalnız sabit ve güvenli geliştirme değerleri içerir: baseUrl,
  seed telefonları, seed site/facility/material/contract kimlikleri ve boş
  runtime placeholder'ları.
- Token, OTP ve zincirlenen kimlikler (ticketId, assignmentId, attachmentId,
  draftContractId, invoiceId) script'lerce **runtime değişkeni** olarak
  yazılır (`bru.setVar`); environment dosyasına kalıcı yazılmaz. Bruno'da
  environment'ı elle düzenleyip token yapıştırmayın/kaydetmeyin.

## 10. Pozitif kabul zinciri

Klasör/istek sırasıyla koşun. Kısaltmalar: OPS=OPERATIONS, SM=SITE_MANAGER,
TECH=TECHNICIAN, RES=RESIDENT. Tüm rotalar `/api/v1` prefix'lidir.

| # | İstek (klasör/dosya) | Rol | Method/Route | Beklenen | DB yan etkisi |
|---|---|---|---|---|---|
| 1 | 01-health/01-liveness | — | GET /health/liveness | 200 `{status:"ok"}` | yok |
| 2 | 01-health/02-readiness | — | GET /health/readiness | 200 `{status:"ok",database:"ok"}` | yok |
| 3 | 02-auth-operations/01 | — | POST /auth/otp/request `{phoneNumber}` | 200 generic mesaj | `otp_challenges` insert; audit `OTP_REQUESTED` |
| 4 | 02-auth-operations/02 | — | GET /dev/sms/{opsPhone}/last-otp | 200 `{code}` | yok (bellek içi) |
| 5 | 02-auth-operations/03 | — | POST /auth/otp/verify `{phoneNumber,code}` | 200 access+refresh token, `user.role=OPERATIONS` | challenge consumed; `refresh_sessions` insert; `users.last_login_at`; audit `AUTH_LOGIN_SUCCESS` (tek transaction) |
| 6 | 02-auth-operations/04 | OPS | GET /auth/me | 200 `{id,role,fullName,memberships}` | yok |
| 7 | 03-auth-site-manager/01–03 | — | OTP request→inbox→verify (managerPhone) | 200'ler, `user.role=SITE_MANAGER` | 3–5 ile aynı desen |
| 8 | 04-auth-technician/01–03 | — | Aynı zincir (techPhone) | `user.role=TECHNICIAN` | aynı |
| 9 | 05-auth-resident/01–03 | — | Aynı zincir (residentPhone) | `user.role=RESIDENT` | aynı |
| 10 | 06-facilities/01 | SM | GET /facilities/sites/{panoramaSiteId}/tree | 200 site ağacı | yok |
| 11 | 07-ticket-flow/01 | RES | POST /tickets (facility=Daire 1, PLUMBING, STANDARD) | 201 `status=OPEN` | `tickets` insert (SLA aktif sözleşmeden); history; audit `TICKET_CREATED`; outbox `TicketCreated` |
| 12 | 07-ticket-flow/02 | RES | GET /tickets | 200 `items.length>=1` | yok |
| 13 | 07-ticket-flow/03 | RES | GET /tickets/{ticketId} | 200 `status=OPEN` | yok |
| 14 | 07-ticket-flow/04 | OPS | POST /tickets/{id}/status `{toStatus:TRIAGED}` | 201 `status=TRIAGED` | history + audit `TICKET_STATUS_CHANGED` |
| 15 | 07-ticket-flow/05 | OPS | POST /tickets/{id}/assignments `{technicianId}` | 201 `assignmentStatus=PENDING` | ticket ASSIGNED; `assignments` insert; audit `ASSIGNMENT_CREATED`; outbox `TechnicianAssigned` |
| 16 | 07-ticket-flow/06 | TECH | POST /assignments/{id}/accept | 201 `assignmentStatus=ACCEPTED` | ticket ACCEPTED; audit `ASSIGNMENT_ACCEPTED` |
| 17 | 07-ticket-flow/07 | TECH | POST /assignments/{id}/status `{event:EN_ROUTE}` | 201 `enRouteAt` dolu | ticket EN_ROUTE |
| 18 | 07-ticket-flow/08 | TECH | `{event:ARRIVED}` | 201 `arrivedAt` dolu | ticket ARRIVED |
| 19 | 07-ticket-flow/09 | TECH | `{event:START}` | 201 `startedAt` dolu | ticket IN_PROGRESS |
| 20 | 07-ticket-flow/10 | TECH | POST /assignments/{id}/materials (string quantity/unitPrice) | 201 | `assignment_materials` insert; audit `MATERIAL_ADDED` |
| 21 | 07-ticket-flow/11 | TECH | POST /tickets/{id}/attachments (multipart, sample.jpg, AFTER_WORK, assignmentId) | 201 `mimeType=image/jpeg` | `ticket_attachments` insert; dosya `var/uploads` altında; audit `ATTACHMENT_UPLOADED`; outbox `AttachmentUploaded` |
| 22 | 07-ticket-flow/12 | RES | GET /tickets/{id}/attachments | 200 `items.length>=1` | yok |
| 23 | 07-ticket-flow/13 | RES | GET /attachments/{id}/download | 200, `content-type: image/jpeg` | yok |
| 24 | 07-ticket-flow/14 | TECH | `{event:COMPLETE, note}` | 201 `assignmentStatus=COMPLETED` | ticket COMPLETED; `resolutionNote` |
| 25 | 07-ticket-flow/15 | OPS | POST /tickets/{id}/status `{toStatus:CLOSED}` | 201 `status=CLOSED` | history + audit |
| 26 | 08-contracts-billing/01 | OPS | GET /sites/{panoramaSiteId}/contracts | 200; SEED-PNR-ACTIVE listede | yok |
| 26b | 08-contracts-billing/02 | OPS | POST /contracts (gelecek yıl aralığı) | 201 `status=DRAFT` | `contracts` insert; audit `CONTRACT_CREATED` |
| 27 | 08-contracts-billing/03 | OPS | POST /contracts/{seedContractId}/invoices (içinde bulunulan ay dönemi) | 201 `status=DRAFT`, `currency=TRY` | `contract_invoices` insert; audit `INVOICE_CREATED` |
| 28 | 08-contracts-billing/04 | OPS | PATCH /invoices/{id}/status `{status:ISSUED}` | 200 `status=ISSUED` | audit `INVOICE_ISSUED`; outbox `InvoiceIssued` |
| 29 | 08-contracts-billing/05 | OPS | `{status:PAID, paymentMethod:BANK_TRANSFER, referenceNumber}` | 200 `paidAt` dolu | audit `INVOICE_PAID` |
| 29b | 08-contracts-billing/06 | OPS | GET /sites/{panoramaSiteId}/invoices | 200 `items.length>=1` | yok |
| 30 | 09-emergency-refresh-logout/01 | RES | POST /tickets (ELECTRICAL, EMERGENCY) | 201 `slaTargetAt` dolu | outbox `EmergencyTicketCreated` → OPS'a SMS fan-out |
| 31 | 09-emergency-refresh-logout/02 | — | POST /auth/token/refresh `{refreshToken}` | 200 yeni token çifti | eski session rotated; yeni `refresh_sessions`; audit `REFRESH_TOKEN_ROTATED` |
| 32 | 09-emergency-refresh-logout/03 | RES | POST /auth/logout `{refreshToken}` (güncel) | 204 | session revoked |

Görev planındaki adımlarla farklar (gerçek API'ye göre gerekçeli):

- "Contract oluşturma" (adım 26b) **gelecek yıl** aralığına yapılır: seed'in
  ACTIVE sözleşmesi içinde bulunulan yılı kapsar ve ACTIVE/SUSPENDED çakışma
  ön-kontrolü aynı aralıkta ikinci sözleşmeye izin vermez. Çakışan aralık
  negatif senaryodadır.
- Ticket TRIAGED ve CLOSED dışındaki durum geçişleri **assignment eventi**
  üzerinden yürür (`POST /assignments/:id/status`); `POST /tickets/:id/status`
  yalnız OPERATIONS + yalnız TRIAGED/CLOSED kabul eder.
- Teknisyen attachment yüklerken `assignmentId` zorunludur ve assignment
  ACCEPTED/ACTIVE + current olmalıdır; bu yüzden upload, COMPLETE'ten önce
  koşulur.
- Outbox/NotificationDelivery/audit/job doğrulamalarının public HTTP
  endpoint'i yoktur; sahte endpoint eklenmemiştir, doğrulama Bölüm 12–16'daki
  SQL adımlarıyla yapılır.

## 11. Negatif kabul senaryoları

`10-negative` klasörü, pozitif zincir **tamamlandıktan sonra** sırayla koşulur
(runtime değişkenlerine bağımlıdır).

| İstek | Senaryo | Method/Route | Rol | Beklenen |
|---|---|---|---|---|
| 01+02 | Yanlış OTP | otp/request + otp/verify `code:"000000"` (marinaResidentPhone) | — | 200 sonra **401 `AUTH_INVALID_OTP`**; attemptCount artışı commit edilir (rollback yok) |
| 03 | Yetkisiz rol | POST /facilities/sites | RES | **403 `FORBIDDEN`** |
| 04 | Başka siteye erişim | GET /facilities/sites/{marinaSiteId}/tree | SM (Panorama) | **404 `SITE_NOT_FOUND`** (uniform; 403 değil) |
| 05 | Geçersiz ticket geçişi | POST /tickets/{closedTicketId}/status `{toStatus:TRIAGED}` | OPS | **409 `TICKET_INVALID_STATUS_TRANSITION`** |
| 06 | Başka teknisyenin assignment'ı | POST /assignments/{rastgele-uuid}/accept | TECH | **404 `ASSIGNMENT_NOT_FOUND`** — seed'de tek teknisyen vardır; kod yolu gereği sahiplik uyuşmazlığı ile var olmayan kayıt aynı uniform 404'ü üretir |
| 07 | Terminal assignment'a accept | POST /assignments/{completedId}/accept | TECH | **409 `ASSIGNMENT_STATUS_CONFLICT`** |
| 08 | Çakışan sözleşme | POST /contracts (içinde bulunulan yıl aralığı, Panorama) | OPS | **409 `CONTRACT_OVERLAP`** |
| 09 | Aynı dönem ikinci invoice | POST /contracts/{seed}/invoices (aynı ay) | OPS | **409 `INVOICE_PERIOD_OVERLAP`** |
| 10 | Manuel OVERDUE | PATCH /invoices/{id}/status `{status:OVERDUE}` | OPS | **409 `INVOICE_INVALID_STATUS_TRANSITION`** |
| 11 | Geçersiz magic-byte | POST /tickets/{emergencyTicketId}/attachments (fake-image.jpg) | OPS | **415 `ATTACHMENT_UNSUPPORTED_TYPE`**; DB kaydı ve kalıcı dosya oluşmaz |
| 12+13+14 | İnaktif kullanıcı | users/{disposable}/deactivate → otp/request → dev inbox | OPS → — | 204 → 200 generic → **404** (OTP üretilmediğinin kanıtı) |
| 15 | Refresh reuse | POST /auth/token/refresh `{residentRefreshOld}` | — | **401 `AUTH_INVALID_REFRESH`**; tüm aktif session'lar revoke + audit (bkz. Bölüm 17) |

Tehlikeli/tekrar-koşulamaz senaryoların geri dönüşü:

- **İnaktif kullanıcı (12)**: geçici sakin harcanır → `npm run db:seed`
  yeniden aktifleştirir (Bölüm 19).
- **Aynı dönem invoice (09)**: pozitif zincirdeki faturaya bağlıdır; aynı ay
  içinde koleksiyon ikinci kez koşulacaksa pozitif fatura adımı 409 döner —
  tam tekrar için DB sıfırlama gerekir (Bölüm 19).
- **Yanlış OTP (01+02)**: challenge başına 5 deneme hakkı vardır; senaryo tek
  deneme yapar, tekrar koşulabilir (60 sn cooldown'a dikkat).

## 12. Outbox SQL doğrulamaları

psql'e salt-okunur erişim:

```powershell
docker compose exec db psql -U app -d site_support
```

```sql
-- Son outbox olayları: pozitif zincirden en az TechnicianAssigned,
-- EmergencyTicketCreated, AttachmentUploaded ve InvoiceIssued beklenir.
SELECT event_type, aggregate_type, status, attempt_count, processed_at
FROM outbox_events
ORDER BY created_at DESC
LIMIT 25;

-- Relay açıkken (dev varsayılanı) birkaç saniye içinde hepsi PROCESSED olmalı:
SELECT status, COUNT(*) FROM outbox_events GROUP BY status;
```

Beklenen: `PENDING`/`FAILED` satır kalmaz; `processed_at` dolu.

## 13. NotificationDelivery SQL doğrulamaları

```sql
-- Fan-out yalnız şu event tipleri için yapılır: EmergencyTicketCreated,
-- TechnicianAssigned, ContractExpiring, InvoiceOverdue.
SELECT source_event_type, sms_method, recipient_phone, status, processed_at
FROM notification_deliveries
ORDER BY created_at DESC
LIMIT 25;
```

Beklenen (pozitif zincir sonrası):

- `TechnicianAssigned` + `TICKET_NOTIFICATION` → alıcı `+905550000002`
  (teknisyen).
- `EmergencyTicketCreated` + `EMERGENCY_ALERT` → alıcı `+905550000001`
  (aktif OPERATIONS kullanıcıları).
- Relay + mock SMS provider ile satırlar kısa sürede `PROCESSED` olur.
- Diğer outbox olayları (TicketCreated, AttachmentUploaded, InvoiceIssued…)
  teslimat satırı üretmeden PROCESSED işaretlenir — bunlar için satır
  **beklenmez**.

## 14. Audit log SQL doğrulamaları

```sql
-- Zincirin uçtan uca audit izi:
SELECT action, entity_type, site_id, created_at
FROM audit_logs
ORDER BY created_at DESC
LIMIT 40;

-- Belirli kritik aksiyonların varlığı:
SELECT action, COUNT(*)
FROM audit_logs
WHERE action IN ('OTP_REQUESTED','AUTH_LOGIN_SUCCESS','TICKET_CREATED',
                 'TICKET_STATUS_CHANGED','ASSIGNMENT_CREATED',
                 'ASSIGNMENT_ACCEPTED','MATERIAL_ADDED','ATTACHMENT_UPLOADED',
                 'CONTRACT_CREATED','INVOICE_CREATED','INVOICE_ISSUED',
                 'INVOICE_PAID','USER_DEACTIVATED',
                 'REFRESH_TOKEN_ROTATED','REFRESH_TOKEN_REUSE_DETECTED')
GROUP BY action
ORDER BY action;
```

Beklenen: listelenen her aksiyondan en az 1 satır (negatif senaryolar
koşulduysa `USER_DEACTIVATED` ve `REFRESH_TOKEN_REUSE_DETECTED` dahil).
Audit satırlarında OTP/token/secret bulunmaz; telefonlar maskelenmiştir.

## 15. ContractExpiring job doğrulaması

Job'ın public endpoint'i yoktur ve **eklenmemiştir**. `SchedulerRegistry`
ile her gün 02:00 UTC'de tetiklenir; `backgroundJobs.enabled` (dev
varsayılanı true) kapalıysa hiç kaydolmaz.

1. Ön koşul (seed): Marina sözleşmesi `SEED-MRN-EXPIRING` bitişe ~10 gün
   kala ve `expiry_notified_at IS NULL` durumundadır
   (`CONTRACT_EXPIRY_LEAD_DAYS` varsayılanı 30'un içinde).

   ```sql
   SELECT contract_number, end_date, expiry_notified_at, status
   FROM contracts WHERE contract_number = 'SEED-MRN-EXPIRING';
   ```

2. Canlı doğrulama: uygulamayı `BACKGROUND_JOBS_ENABLED` kapatılmamış
   halde 02:00 UTC'yi kapsayacak şekilde çalışır bırakın (veya 02:00 UTC
   sonrasında yeniden başlatıp ertesi tetiklenmeyi bekleyin — job yalnız
   cron tick'inde koşar, başlangıçta koşmaz).

3. Tetiklenme sonrası beklenen:

   ```sql
   SELECT expiry_notified_at FROM contracts
   WHERE contract_number = 'SEED-MRN-EXPIRING';           -- artık dolu

   SELECT event_type, status FROM outbox_events
   WHERE event_type = 'ContractExpiring'
   ORDER BY created_at DESC LIMIT 5;                       -- PROCESSED

   SELECT action FROM audit_logs
   WHERE action = 'CONTRACT_EXPIRING_NOTIFIED'
   ORDER BY created_at DESC LIMIT 5;

   SELECT source_event_type, recipient_phone, status
   FROM notification_deliveries
   WHERE source_event_type = 'ContractExpiring';
   -- Marina'da aktif SITE_MANAGER yok; alıcılar aktif OPERATIONS (+905550000001)
   ```

4. Cron beklenmeden kod-düzeyi güvence gerekiyorsa: `runOnce()` birim ve
   entegrasyon testleriyle kapsanır (`npm test`,
   `npm run test:integration`). Job idempotenttir: `expiry_notified_at`
   dolu olan sözleşme ikinci kez işlenmez; seed her koşumda alanı
   `NULL`'a çekerek senaryoyu tekrarlanabilir yapar.

## 16. InvoiceOverdue job doğrulaması

Aynı zamanlama ve kill-switch (02:00 UTC, `backgroundJobs.enabled`).

1. Ön koşul: `ISSUED` durumda ve `due_date < bugünkü UTC tarihi` olan bir
   fatura gerekir. Pozitif zincir faturası PAID yapıldığı için aday
   değildir; **geçmiş dönem** için ek bir fatura oluşturun (OPS token'ıyla,
   ör. bir önceki ay dönemi + geçmiş `dueDate`), sonra `ISSUED`'a çekin ve
   PAID **yapmayın**. (Geçmiş `issueDate/dueDate` API'de geçerlidir; tek
   kural `dueDate >= issueDate` ve dönemin sözleşme penceresi içinde
   olmasıdır.)

   ```sql
   SELECT invoice_number, status, due_date FROM contract_invoices
   WHERE status = 'ISSUED' AND due_date < (now() AT TIME ZONE 'utc')::date;
   ```

2. 02:00 UTC tetiklenmesinden sonra beklenen:

   ```sql
   SELECT invoice_number, status FROM contract_invoices
   WHERE invoice_number = '<adaydaki numara>';             -- OVERDUE

   SELECT event_type, status FROM outbox_events
   WHERE event_type = 'InvoiceOverdue'
   ORDER BY created_at DESC LIMIT 5;

   SELECT action FROM audit_logs
   WHERE action = 'INVOICE_OVERDUE'
   ORDER BY created_at DESC LIMIT 5;

   SELECT source_event_type, recipient_phone, status
   FROM notification_deliveries
   WHERE source_event_type = 'InvoiceOverdue';
   -- Alıcılar: Panorama'nın aktif SITE_MANAGER'ı (+905550000003) + aktif OPERATIONS
   ```

3. OVERDUE'ya manuel geçiş API'den kapalıdır (negatif senaryo 10 bunu
   kanıtlar); OVERDUE'dan çıkış PAID/CANCELLED ile mümkündür. Cron
   beklenmeden güvence için `runOnce()` testleri geçerlidir (Bölüm 15/4 ile
   aynı).

## 17. Refresh reuse doğrulaması

Negatif senaryo 15 koşulduktan sonra:

```sql
-- Kullanıcının tüm session'ları revoke edilmiş olmalı:
SELECT COUNT(*) AS active_sessions
FROM refresh_sessions rs
JOIN users u ON u.id = rs.user_id
WHERE u.phone_number = '+905550000004'
  AND rs.revoked_at IS NULL;
-- Beklenen: 0

SELECT action, created_at FROM audit_logs
WHERE action = 'REFRESH_TOKEN_REUSE_DETECTED'
ORDER BY created_at DESC LIMIT 5;
-- Beklenen: en az 1 satır (revocation ile aynı transaction'da yazılır)
```

Veritabanında token'ların yalnız hash'i tutulur; SQL çıktısında raw token
görülmez, görülmemelidir.

## 18. Attachment dosya doğrulamaları

```sql
SELECT id, storage_provider, storage_key, original_file_name,
       mime_type, file_size, checksum
FROM ticket_attachments
ORDER BY created_at DESC LIMIT 5;
```

- `storage_provider = 'local'`; dosya host'ta `var/uploads/<storage_key>`
  yolundadır (compose kullanılıyorsa aynı klasör bind-mount'tur).
- Dosya boyutu `file_size` ile eşleşmelidir; `sample.jpg` için 631 bayt.
- Checksum doğrulaması (PowerShell, salt-okunur):

  ```powershell
  Get-FileHash -Algorithm SHA256 "var\uploads\<storage_key>"
  # çıktı ticket_attachments.checksum ile eşleşmeli
  ```

- Negatif MIME senaryosu (11) sonrasında `var/uploads` altında **yeni dosya
  kalmamalı** ve tabloya satır eklenmemiş olmalıdır.
- İndirme yüzeyi signed URL değil, kimlik doğrulamalı stream endpoint'idir
  (`GET /attachments/:id/download`).

## 19. Test ortamını yeniden başlatma

Hafif geri dönüş (çoğu senaryo için yeterli):

```powershell
npm run db:seed   # geçici kullanıcıyı ve seed sözleşme durumlarını geri getirir
```

Tam sıfırlama (aynı ay içinde koleksiyonun ikinci tam koşumu, invoice/dönem
çakışmaları, kirlenmiş ticket verisi):

```powershell
docker compose down          # API container kullanılıyorsa onu da durdurur
docker volume rm proje1_pgdata
docker compose up -d db
npx prisma migrate deploy
npm run db:seed
# uygulamayı yeniden başlatın (Bölüm 6); dev SMS inbox belleği de sıfırlanır
```

Notlar:

- `var/uploads` altındaki test dosyaları isteğe bağlı temizlenebilir; DB
  sıfırlanınca eski kayıtlar zaten referanssız kalır.
- Uygulama yeniden başlatılınca in-memory rate limiter sayaçları ve dev SMS
  inbox'ı temizlenir (OTP cooldown beklemeden yeni koşum yapılabilir).

## 20. Kabul sonucu kayıt şablonu

Her kabul koşumu için aşağıdaki şablon doldurulup takım kanalına/PR'a not
düşülür:

```
Manuel Kabul Koşumu
===================
Tarih (UTC)          :
Koşan kişi           :
Git commit           :
Ortam                : development (host / compose)
Seed koşuldu mu      : evet/hayır

Pozitif zincir       : X/32 adım BAŞARILI  (başarısızlar: …)
Negatif senaryolar   : X/11 senaryo BAŞARILI (başarısızlar: …)
Outbox SQL           : BAŞARILI/BAŞARISIZ
NotificationDelivery : BAŞARILI/BAŞARISIZ
Audit SQL            : BAŞARILI/BAŞARISIZ
ContractExpiring job : BAŞARILI/BAŞARISIZ/ATLANDI (gerekçe)
InvoiceOverdue job   : BAŞARILI/BAŞARISIZ/ATLANDI (gerekçe)
Refresh reuse        : BAŞARILI/BAŞARISIZ
Attachment dosya     : BAŞARILI/BAŞARISIZ

Bulgular / sapmalar  :
Karar                : KABUL / RET
```

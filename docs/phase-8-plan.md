# Faz 8 — Notifications + Outbox Relay: Uygulama Planı (Revizyon 1)

## Context

Faz 1–7 `main`'e merge edildi. Outbox'ın yazma tarafı Faz 4'ten beri
üretimde; `outbox_events` tablosu hiç tüketilmeden birikiyor.
`InvoiceStateMachine` OVERDUE çıkışını Faz 8 için şimdiden hazır tutuyor.
Revizyon 0'ın ilk gözden geçirmesinde 14 mimari sorun tespit edildi —
bu revizyon o sorunların her birini kesin bir tasarım kararıyla çözüyor.

## Onay durumu (2026-07-16)

Bu plan (Revizyon 1 + Revizyon 1.1 düzeltmeleri) **onaylanmıştır**. §14'teki
8 açık karar noktası aşağıdaki gibi kesinleşmiştir:

1. Acil ticket bildirimleri aktif OPERATIONS kullanıcılarına gönderilecek.
2. ContractExpiring ve InvoiceOverdue bildirimleri ilgili sitenin aktif
   SITE_MANAGER kullanıcılarına ve aktif OPERATIONS kullanıcılarına
   gönderilecek.
3. `CONTRACT_EXPIRY_LEAD_DAYS` varsayılanı 30 olacak ve environment
   üzerinden değiştirilebilecek.
4. Relay varsayılanları: poll=5000ms, batch=20, maxAttempts=10,
   lease=60000ms.
5. Faz 8'de FAILED görünürlüğü structured log + AuditLog üzerinden
   sağlanacak; harici alerting sonraki production-readiness çalışmasına
   bırakılacak.
6. Faz 8 tek outbox tüketicisi varsayımıyla uygulanacak.
7. `OutboxRelay` ve `NotificationDeliveryRelay` aynı temel relay config
   değerlerini paylaşacak.
8. Mesajlar ayrı bir template motoru olmadan düz metin/template literal
   ile üretilecek.

**Ek zorunluluklar** (implementasyonda uygulanacak, ilgili bölümlere
işlenmiştir):

- SITE_MANAGER alıcıları yalnızca ilgili sitenin **aktif üyeliklerinden**
  seçilmeli (§6.4/§6.5 — `MembershipQueryService.listActiveManagerUserIds(siteId)`).
- Kullanıcıların aktiflik durumu kontrol edilmeli (§6.5 —
  `UserContactLookupService` tüm metotlarında `isActive=true AND deletedAt IS NULL`).
- Aynı telefon numarası birden fazla rol veya üyelik üzerinden bulunursa
  tek SMS üretilmeli (§6.5 — telefon-bazlı union dedup).
- **Telefon numarası normalize edilmeden unique/idempotency kontrolü
  yapılmamalı** (§6.5 — dedup ve `NotificationDelivery` unique constraint'i
  her zaman `normalizeE164()` çıktısı üzerinde çalışır, ham DB değeri
  üzerinde değil; ayrıntı §6.5'te).

Bu onayla birlikte plan **implementasyona hazır** kabul edilir.

---

## Revize edilen kritik kararlar

| # | Konu | Revizyon 0 | Revizyon 1 kararı |
|---|---|---|---|
| 1 | attemptCount artışı | Yalnız hata çözümünde artıyordu | **Claim sorgusunun kendisi** artırır (`UPDATE ... SET attempt_count = attempt_count + 1 ... RETURNING`); crash sonrası deneme hakkı zaten tüketilmiş sayılır |
| 2 | Çoklu alıcı retry | Tüm event yeniden deneniyordu (başarılı alıcıya tekrar SMS) | Yeni **`NotificationDelivery`** tablosu — her alıcı bağımsız claim/retry edilir; fan-out **tek transaction'da** kaynak event'i PROCESSED yapar (fan-out exactly-once, yalnız SMS gönderimi at-least-once) |
| 3 | Eski backlog | Tanımsızdı | **Tek seferlik migration SQL'i** — Faz 8 migration'ında mevcut PENDING/PROCESSING satırlar PROCESSED + açıklayıcı `last_error` ile işaretlenir |
| 4 | InvoiceOverdue yazma yolu | Repository doğrudan bypass ediliyordu | `InvoiceService.markOverdueBySystem()` → `InvoiceStateMachine.assertSystemOverdueTransition()` (yeni, ayrı, actor-guard'ı etkilemeyen metot) → repository+audit+outbox aynı transaction |
| 5 | Advisory lock | Chunk-transaction seviyesinde `pg_try_advisory_xact_lock` | **Kaldırıldı** — mevcut `findByIdForUpdate` row-lock + idempotent yeniden-kontrol yeterli ve daha basit (gereksiz kilit yok) |
| 6 | outbox_events tüketici modeli | Belirsiz | **Faz 8 itibarıyla tek onaylı tüketici** (NotificationsModule) — no-op→PROCESSED bu varsayımla gerekçelendirildi, ikinci tüketici onaylanırsa ayrı bir consumer-offset modeli gerekecek (kod yorumu + açık karar) |
| 7 | Payload doğrulama | Yoktu | Bilinen 4 eventType için Zod şeması; bozuk payload → **non-retryable**, doğrudan FAILED |
| 8 | Relay SQL | Ayrı adımlarda | Tek `UPDATE...RETURNING`'de attemptCount+lease+reclaim birlikte; **tamamı Prisma tagged-template parametreli**, string interpolation yok |
| 9 | Lease/batch/concurrency ilişkisi | Tanımsızdı | `leaseMs >= smsTimeout + güvenlik payı`, batch içi dispatch `Promise.allSettled` ile paralel → toplam süre ~1×timeout, batchSize'a bağlı değil |
| 10 | Job lifecycle | Eksikti | `OUTBOX_RELAY_ENABLED`, `BACKGROUND_JOBS_ENABLED`, UTC cron timezone, `enableShutdownHooks()` (main.ts'e eklenmeli — şu an çağrılmıyor), graceful drain, test-ortamında otomatik başlamama |
| 11 | FAILED zaman damgası | `processedAt` yeniden yorumlanıyordu | Yeni **`failedAt`** alanı — `processedAt` yalnız başarıyı temsil eder |
| 12 | ContractExpiring yeniden uyarı | Yalnız endDate değişimi | + **ACTIVE'e her yeniden giriş** de sıfırlar; lead-day config değişimi **retroaktif değildir** |
| 13 | Recipient dedup | Yoktu | **Telefon numarasına göre** union-dedup (userId'ye göre değil) — DB'de `chk_users_phone_e164` zaten format garantisi veriyor |
| 14 | Test matrisi | Genel | 12 somut senaryo eklendi (§10) |

---

## İkinci mimari inceleme — düzeltmeler (Revizyon 1.1)

Revizyon 1'in kendi üzerinde yapılan ikinci ve son mimari incelemesinde 7
somut düzeltme bulundu ve plana işlendi:

| # | Bulgu | Düzeltme |
|---|---|---|
| A | `markOverdueBySystem` pseudocode'u `invoice.siteId` alanına erişiyordu — `InvoiceRow`'da bu alan **yok** (ContractInvoice'un kendi siteId'si yok, yalnız `contract.siteId` üzerinden türetilir, override doc §3). Bu haliyle derlenmezdi. | `markOverdueBySystem(invoiceId, siteId)` imzasına geçirildi — `siteId`, job'un zaten sahip olduğu aday satırından (`findOverdueCandidatesAcrossSites` contract join'i zaten `siteId` döndürüyor) parametre olarak geliyor, ekstra sorguya gerek yok (§7.1). |
| B | §5.2 ile §6.2 arasında PROCESSED yazımının nerede olduğu belirsizdi (genel relay sonuç-işleme mi, yoksa fan-out transaction'ının kendisi mi?). | Netleştirildi: başarı yolunda PROCESSED işareti **yalnız `fanOut()`'un kendi transaction'ı içinde** yazılır (delivery satırlarıyla birlikte, atomik). `OutboxRelay`'in genel sonuç-işleme adımı **yalnız hata yollarında** (fanOut `throw` ettiğinde) devreye girer. |
| C | Sweep-to-FAILED sorgusu (`$executeRaw`, bütçe tükenen satırları toplu FAILED'e çeken) hiçbir audit kaydı üretmiyordu — "FAILED gözlemlenebilirliği yalnız audit log" garantisini (karar #5) kısmen boşa çıkarıyordu. | Sweep sorgusu `$executeRaw`'dan `$queryRaw ... RETURNING id, event_type, aggregate_type, aggregate_id`'e çevrildi; dönen satırlar için `AuditWriter.log(OUTBOX_EVENT_FAILED)` aynı transaction içinde yazılır. **Aynı düzeltme `NotificationDeliveryRelay`'e de uygulanır** — yeni audit action `NOTIFICATION_DELIVERY_FAILED` eklendi (§11 dosya listesine yansıtıldı). |
| D | `NotificationDelivery`'nin unique/idempotency anahtarı yalnız `(sourceEventId, recipientPhone)` idi — `channel` her zaman `'SMS'` olduğu için bugün fark etmiyor, ama Faz 9+'ta Push gibi ikinci bir kanal eklenirse aynı olayda aynı numaraya farklı kanaldan bildirim gitmesini yanlışlıkla engelleyebilirdi. | `@@unique([sourceEventId, recipientPhone, channel])` — ileriye dönük, düşük maliyetli düzeltme. |
| E | Eski backlog'un migration'la temizlenmesi, migration'ın relay'den **önce** çalıştığı varsayımına dayanıyordu — bu bir deployment-sıralama varsayımıdır, kodda garanti edilmiyor. | Operasyonel öneri eklendi (§9.1): ilk Faz 8 deploy'unda `OUTBOX_RELAY_ENABLED=false` ile başla, backlog-temizleme migration'ının uygulandığı doğrulandıktan (`SELECT count(*) FROM outbox_events WHERE status IN ('PENDING','PROCESSING')` ≈ 0) SONRA `true`'ya çevir. Zaten var olan kill-switch'i (§10) bu amaçla kullanır, yeni kod gerektirmez. |
| F | Test-ortamı izolasyonu yalnız `postgres-testcontainer.ts`'in `OUTBOX_RELAY_ENABLED=false` set etmeyi **hatırlamasına** dayanıyordu (kural, garanti değil). | `configuration.ts`'teki config loader'a yapısal güvence eklendi: `enabled: env.NODE_ENV !== 'test' && env.OUTBOX_RELAY_ENABLED` — `NODE_ENV=test` her zaman otomatik kapatır, ayrı bir dosyanın bunu hatırlamasına bağımlı değil (§10.1). |
| G | Tarama job'larının "aday tükenene kadar tekrar sorgula" (chunked) davranışı Revizyon 1 metninde örtük kalmıştı. | §7'de açıkça yeniden teyit edildi — davranış değişmedi, yalnız netleştirildi. |

---

## 1. Repository'de mevcut durum

(Revizyon 0 §1 ile aynı, değişmedi — özet: outbox yazma tarafı tamam ve
dokunulmuyor; hiçbir tüketici yok; `SmsProvider.sendTicketNotification`/
`sendEmergencyAlert` tanımlı ama çağrılmıyor; `InvoiceStateMachine` OVERDUE
çıkışını hazır tutuyor; modül export sınırları katı; tek `api` container'ı;
injectable Clock yok.)

**Bu revizyonda yeni doğrulanan iki ek bulgu:**

- `src/main.ts` şu an `app.enableShutdownHooks()` **çağırmıyor** — bu
  olmadan `OnModuleDestroy`/`OnApplicationShutdown` SIGTERM'de hiç
  tetiklenmez. Faz 8'in graceful-shutdown gereksinimi (§10) bunu
  `main.ts`'e eklemeyi zorunlu kılıyor.
- `src/common/utils/phone.util.ts` + DB migration'daki `chk_users_phone_e164`
  CHECK constraint'i, `User.phoneNumber`'ın **her zaman** geçerli E.164
  formatında olduğunu DB seviyesinde garanti ediyor — Faz 8'in recipient
  çözümlemesinde ayrıca format doğrulaması yapmasına gerek yok (§9/§13).

---

## 2. Faz 8 kapsamı

Değişmedi (Revizyon 0 §2) — roadmap'in 4 kalemi: OutboxRelay,
NotificationDispatcher, acil arıza SMS'i, ContractExpiring/InvoiceOverdue
tarama job'ları. `ContractExpiring` (uyarı, status değişmez) ≠
`ContractExpired` (Faz 7'de zaten çalışan manuel geçiş) ayrımı korunuyor.

---

## 3. Mimari tasarım

### 3.1 İki aşamalı outbox tüketimi (kritik karar #2'nin temeli)

Tek bir "claim → SMS gönder → PROCESSED" adımı yerine, **iki bağımsız
relay + iki tablo**:

```
[outbox_events]  --OutboxRelay claim-->  NotificationDispatcher.fanOut()
                                            │  (payload validate + route + recipient resolve + dedup)
                                            ▼  TEK TRANSACTION:
                                  [N × notification_deliveries satırı INSERT]
                                  + [outbox_events satırı PROCESSED]
                                            │
[notification_deliveries]  --NotificationDeliveryRelay claim-->  SmsProvider.send*()
                                            │
                                     PROCESSED / retry / FAILED (per-recipient, bağımsız)
```

**Neden**: `outbox_events` domain-olay akışı (§6'da tek-tüketicili olarak
sabitlendi), `notification_deliveries` ise tamamen notification'a özel
teslimat kuyruğudur — ayrı kolonlara (recipientPhone, channel, smsMethod)
ihtiyaç duyar ve domain akışını "SMS retry bookkeeping" ile kirletmez. Fan-out
adımı (kaç alıcı, kim) **tek transaction'da** hem delivery satırlarını
oluşturur hem kaynak event'i PROCESSED yapar — bu adım book-keeping
açısından **exactly-once**'tur (ya ikisi de olur ya hiçbiri; crash olursa
event PENDING kalır, yeniden claim edildiğinde fan-out'un tamamı — henüz
hiç delivery satırı yokken — sıfırdan tekrar çalışır, kısmi/duplicate
delivery satırı asla oluşmaz). Kalan kaçınılmaz at-least-once riski YALNIZ
`NotificationDeliveryRelay`'in gerçek SMS gönderme adımına indirgenmiştir
(§9).

### 3.2 Modül/bağımlılık grafiği

`NotificationsModule` (`src/modules/notifications/`) içerir: `OutboxRelay`,
`NotificationDispatcher` (fan-out), `NotificationDeliveryRelay`,
payload şemaları, yönlendirme tablosu. İçe aktardıkları: `UsersModule`
(yeni `UserContactLookupService`), `MembershipsModule` (mevcut
`MembershipQueryService` + yeni metot), `SmsModule`, `AuditModule`.
**`EventsModule` gerekmiyor** — NotificationsModule hiç yeni domain event
yazmıyor (`OutboxService.publishInTx` çağırmıyor), yalnız mevcut
`outbox_events` satırlarını okuyup kendi `notification_deliveries`
tablosuna yazıyor.

Tarama job'ları yine kendi sahip modüllerinde (Revizyon 0 kararı
korunuyor, §5 gerekçesiyle güçlendi — artık advisory lock da
gerektirmiyorlar): `InvoiceOverdueScanJob` → `BillingModule` içinde,
`ContractExpiringScanJob` → `ContractsModule` içinde. Her ikisi de artık
kendi domain servisleri üzerinden yazıyor (§7), repository'yi doğrudan
çağırmıyor.

```
NotificationsModule → UsersModule, MembershipsModule, SmsModule, AuditModule
ContractsModule (+ dahili ContractExpiringScanJob) → MembershipsModule, FacilitiesModule, AuditModule, EventsModule  (değişmedi)
BillingModule (+ dahili InvoiceOverdueScanJob) → ContractsModule, MembershipsModule, FacilitiesModule, AuditModule, EventsModule  (değişmedi)
```

---

## 4. Outbox event sözleşmeleri

Değişmedi (Revizyon 0 §4) — yeni üretilen `InvoiceOverdue`/`ContractExpiring`,
tüketilen `EmergencyTicketCreated`/`TechnicianAssigned`/`ContractExpiring`/
`InvoiceOverdue`, diğerleri no-op. **Ek olarak**: no-op kararı artık §6'daki
tek-tüketici gerekçesine dayanıyor ve bir testle doğrulanıyor (§10).

**Payload doğrulama şemaları** (yalnız işlenen 4 eventType için —
işlenmeyenler payload'a hiç bakmadan no-op):

```ts
const emergencyTicketCreatedSchema = z.object({
  ticketId: z.string().uuid(), ticketCode: z.string(), siteId: z.string().uuid(),
  facilityId: z.string().uuid(), category: z.string(), urgency: z.literal('EMERGENCY'),
  createdByUserId: z.string().uuid(),
});
const technicianAssignedSchema = z.object({
  ticketId: z.string().uuid(), assignmentId: z.string().uuid(),
  technicianId: z.string().uuid(), reassigned: z.boolean(),
});
const contractExpiringSchema = z.object({
  contractId: z.string().uuid(), contractNumber: z.string(),
  siteId: z.string().uuid(), endDate: z.string(),
});
const invoiceOverdueSchema = z.object({
  invoiceId: z.string().uuid(), contractId: z.string().uuid(),
  siteId: z.string().uuid(), invoiceNumber: z.string(), dueDate: z.string(),
});
```

**Hata sınıflandırması**:
- `NonRetryableDispatchError` (payload şema doğrulaması başarısız —
  üretici tarafında bug, retry hiçbir zaman düzeltmez) → **hemen FAILED**,
  kalan deneme hakkı ne olursa olsun.
- Retryable (varsayılan — SMS provider hatası, DB bağlantı hatası) →
  normal backoff döngüsü, deneme bütçesi tükenince FAILED.
- **Soft-success** (tanınan eventType ama sıfır alıcı çözüldü — örn. aktif
  hiç OPERATIONS kullanıcısı yok) → hata DEĞİL, `PROCESSED` +
  `recipientCount: 0` audit metadata'sı. Bu geçici bir operasyonel durum
  olabilir (retry ile "düzelmez", her yeni event kendi anlık recipient
  listesini çözer) — sonsuz retry'a sokmak yanlış olur.

---

## 5. Relay algoritması

### 5.1 Claim — attemptCount artışı + max-attempt + lease + backoff tek atomik modelde (kritik karar #1, #8)

Prisma tagged-template (`$queryRaw`) kullanılır — tüm değerler (`leaseMs`,
`maxAttempts`, `batchSize`) JS template ifadeleriyle geçilir, Prisma bunları
otomatik olarak parametreli SQL'e (`$1, $2, ...`) çevirir; **hiçbir yerde
string concatenation veya `$queryRawUnsafe` kullanılmaz**:

```ts
const claimed = await this.prisma.$queryRaw<ClaimedOutboxRow[]>`
  UPDATE outbox_events
  SET status = 'PROCESSING',
      attempt_count = attempt_count + 1,
      next_attempt_at = now() + (${leaseMs}::text || ' milliseconds')::interval
  WHERE id IN (
    SELECT id FROM outbox_events
    WHERE status IN ('PENDING', 'PROCESSING')
      AND attempt_count < ${maxAttempts}
      AND (next_attempt_at IS NULL OR next_attempt_at <= now())
    ORDER BY created_at ASC
    LIMIT ${batchSize}
    FOR UPDATE SKIP LOCKED
  )
  RETURNING id, event_type AS "eventType", aggregate_type AS "aggregateType",
            aggregate_id AS "aggregateId", payload, attempt_count AS "attemptCount",
            created_at AS "createdAt"
`;
```

attemptCount **claim anında** artıyor — yani PROCESSING'e geçen ama hiç
gerçek iş yapmadan çöken bir worker bile o denemeyi tüketmiş sayılır. Bu,
kalıcı olarak başarısız (zehirli) bir satırın sonsuz reclaim döngüsüne
girmesini engeller.

**Deneme bütçesi tükenen satırlar** ayrı, eşit derecede parametreli bir
sweep sorgusuyla FAILED'e çekilir (claim sorgusunun `WHERE`'i
`attempt_count < maxAttempts` olduğu için bu satırlar zaten bir daha claim
edilmez — sweep olmazsa PENDING/PROCESSING'de sonsuza dek asılı kalırlar).
**DÜZELTME (Rev 1.1, bulgu C)**: sweep, çıplak bir `$executeRaw` DEĞİL,
`RETURNING`'li bir `$queryRaw`'dır — dönen satırlar için aynı transaction
içinde `AuditWriter.log(OUTBOX_EVENT_FAILED)` yazılır; aksi halde
claim-anında-crash yoluyla FAILED'e düşen satırlar hiç audit izi
bırakmadan sessizce kaybolurdu (karar #5'in "FAILED gözlemlenebilirliği
yalnız audit log" garantisini kısmen boşa çıkarırdı):

```ts
await this.prisma.$transaction(async (tx) => {
  const swept = await tx.$queryRaw<SweptRow[]>`
    UPDATE outbox_events
    SET status = 'FAILED', failed_at = now(),
        last_error = COALESCE(last_error, 'MAX_ATTEMPTS_REACHED_AT_CLAIM')
    WHERE id IN (
      SELECT id FROM outbox_events
      WHERE status IN ('PENDING', 'PROCESSING')
        AND attempt_count >= ${maxAttempts}
        AND (next_attempt_at IS NULL OR next_attempt_at <= now())
      LIMIT ${failSweepBatchSize}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, event_type AS "eventType", aggregate_type AS "aggregateType", aggregate_id AS "aggregateId"
  `;
  for (const row of swept) {
    await this.audit.log(tx, {
      action: DOMAIN_AUDIT_ACTIONS.OUTBOX_EVENT_FAILED, entityType: row.aggregateType,
      entityId: row.aggregateId, metadata: { eventType: row.eventType, reason: 'MAX_ATTEMPTS_REACHED_AT_CLAIM' },
    });
  }
});
```

Claim sorgusu (SKIP LOCKED ile satır claim eden asıl `UPDATE...RETURNING`)
ayrı kalır — sweep'in `WHERE attempt_count >= N` kümesiyle claim'in
`< N` kümesi ayrık olduğundan iki sorgu birbirini etkilemez; her poll
tick'inde önce sweep, sonra claim çalıştırılır. **Aynı model (attemptCount-
artışlı claim + audit'li sweep) `notification_deliveries` için
`NotificationDeliveryRelay`'de birebir tekrarlanır** (farklı tablo/`RETURNING`
kolonları ve yeni `NOTIFICATION_DELIVERY_FAILED` audit action'ı ile —
CLAUDE.md'nin erken soyutlama karşıtı ilkesiyle tutarlı olarak iki
bağımsız, açık sınıf olarak; iki kullanım için generic bir taban sınıf
kurulmuyor).

### 5.2 Sonuç işleme

**DÜZELTME (Rev 1.1, bulgu B)**: Başarı durumunda PROCESSED yazımı
`OutboxRelay`'in kendisi tarafından YAPILMAZ — bu adım zaten
`NotificationDispatcher.fanOut()`'un kendi transaction'ı içinde,
delivery satırlarının oluşturulmasıyla ATOMİK olarak gerçekleşir (§6.2).
`OutboxRelay`'in aşağıdaki sonuç-işleme mantığı yalnız `fanOut()` bir
hata `throw` ettiğinde devreye girer (başarı yolunda relay'in ayrıca bir
şey yapmasına gerek yoktur — fanOut zaten commit etmiştir). attemptCount
artık claim'de arttığından, hata-yolu sonuç işlemesi YALNIZ durum/zaman
alanlarını günceller (attemptCount'a dokunmaz):
- (Başarı — bilgi amaçlı: gerçekleşen state, ama relay tarafından değil `fanOut()` tarafından yazılır) → `status='PROCESSED', processedAt=now(), nextAttemptAt=null, lastError=null`.
- Geçici hata, `attemptCount < maxAttempts` (bütçe kaldıysa) →
  `status='PENDING', nextAttemptAt=now()+backoff(attemptCount), lastError=msg.slice(0,2000)`.
- Geçici hata, `attemptCount >= maxAttempts` (bu son denemeydi) →
  `status='FAILED', failedAt=now(), lastError=msg.slice(0,2000)`.
- `NonRetryableDispatchError` → doğrudan FAILED, bütçe durumu ne olursa
  olsun (`failedAt=now(), lastError='PAYLOAD_VALIDATION_FAILED: ...'`).

Full-jitter exponential backoff (değişmedi): `delay = random(0, min(cap, base * 2^attemptCount))`.

### 5.3 Advisory lock kaldırıldı (kritik karar #5)

`InvoiceOverdueScanJob`/`ContractExpiringScanJob` artık advisory lock
kullanmıyor. Gerekçe: her iki job da **idempotent-by-construction** durum
geçişleri/bayraklar üzerinde çalışıyor (bir fatura yalnız bir kez
ISSUED→OVERDUE olabilir; bir sözleşme `expiryNotifiedAt` set edildikten
sonra aday listesinden düşer). İki replika aynı anda çalışırsa: ikisi de
aynı aday listesini okur (kilitsiz SELECT), ama her aday için asıl
mutasyon `findByIdForUpdate` (standart Postgres row lock, mevcut repository
metodu) içinde yapılır — ikinci worker o satırda bloke olur, ilk worker
commit ettikten sonra satırı tekrar okur, durumun zaten değiştiğini görür
(`status !== 'ISSUED'` veya `expiryNotifiedAt !== null`) ve **sessizce
atlar** (hata değil, beklenen sonuç). Prisma connection-pool açısından bu,
her aday için kısa ömürlü, bağımsız bir `$transaction` demektir — pool
bağlantısı hemen serbest kalır, advisory lock'un session boyunca
tutacağı bir bağlantı riski yok. Günlük, düşük hacimli bir tarama için
olası "boşa git-bekle-vazgeç" maliyeti ihmal edilebilir; advisory lock
eklemek yalnız gereksiz karmaşıklık olurdu.

---

## 6. NotificationDispatcher, SMS ve outbox tüketici modeli

### 6.1 outbox_events tek mi çok mu tüketicili? (kritik karar #6)

`docs/architecture.md` Bölüm 3 (satır 86) `notifications` modülünü
"Outbox event'lerini kanal bağımsız bildirime çevirir" olarak tanımlıyor;
Ek C (satır 2095) gelecekte bir "Sanal POS/payments" modülünün webhook'ları
`InvoicePaid` outbox event'ine çevireceğinden bahsediyor — ama bu yalnız
gelecekte bir **üretici** eklenmesi, onaylı bir **ikinci tüketici**
değil. Hiçbir onaylanmış faz planında NotificationsModule dışında bir
tüketici yok. CLAUDE.md'nin faz disiplini ("sonraki fazlara ait ... sahte
implementation oluşturma", "yeni iş kuralı uydurma") gereği, henüz
onaylanmamış bir ikinci tüketici için multi-consumer-safe bir mekanizma
(örn. per-consumer offset/cursor tablosu) **şimdi inşa edilmeyecek**.

**Karar**: `outbox_events`, Faz 8 itibarıyla **tek onaylı tüketicilidir**
(NotificationsModule). Bu nedenle paylaşılan tek `status` kolonunun
"PROCESSED = kimse ilgilenmiyor" anlamına gelmesi güvenlidir — no-op
eventType'lar PROCESSED işaretlenir (§4). **Açık karar/gelecek notu**:
ikinci bir tüketici gerçekten onaylanırsa, tek `status` kolonu "tüketici
A işledi ama B henüz bakmadı" durumunu ayırt edemez — o noktada ya (a) her
tüketici için ayrı bir `OutboxConsumerOffset(consumerName, lastProcessedCreatedAt)`
tablosu ya da (b) tüketiciye özel event tabloları (bu planın zaten
`notification_deliveries` için yaptığı gibi) gerekecek. Bu, Faz 8'in
çözmesi gereken bir sorun değil — kodda açık bir yorumla işaretlenecek.

Bu kararın testi: `notification-dispatcher.service.spec.ts` içinde
"tanınmayan eventType için SmsProvider hiç çağrılmaz, satır PROCESSED
işaretlenir" (§10).

### 6.2 NotificationDispatcher (fan-out) tasarımı

`fanOut(claimedEvent): Promise<void>`:
1. eventType routing tablosunda yoksa → no-op, kaynak event'i PROCESSED işaretle, dön.
2. Varsa → ilgili Zod şemasıyla payload doğrula; başarısızsa `NonRetryableDispatchError` fırlat.
3. Route'un recipient-resolver'ını çağır (§6.5), sonuçları **normalize
   edilmiş telefon numarasına göre** dedupe et (§ kritik karar #13).
4. Sıfır alıcı → kaynak event'i PROCESSED + `metadata:{recipientCount:0}` audit, dön (hata değil).
5. `this.prisma.$transaction(async (tx) => { N × notificationDelivery.create(...); outboxEvent.update({status:'PROCESSED', processedAt:now()}); })`
   — **bu adım §5.2'de düzeltilen noktanın kaynağıdır**: PROCESSED yazımı
   burada, delivery satırlarıyla aynı transaction'da gerçekleşir; `OutboxRelay`
   fanOut() başarıyla dönünce (throw etmeyince) ayrıca hiçbir şey yazmaz.

### 6.3 NotificationDeliveryRelay (SMS gönderimi)

`notification_deliveries` üzerinde §5.1/§5.2 ile birebir aynı
claim/backoff/lease modeli (ayrı, paralel bir sınıf). Claim edilen her
satır için `smsMethod` alanına göre (`'EMERGENCY_ALERT'` →
`sendEmergencyAlert`, `'TICKET_NOTIFICATION'` → `sendTicketNotification`)
`SmsProvider` çağrılır. Batch içindeki claim edilen satırlar
`Promise.allSettled` ile **paralel** işlenir (§9) — her satırın
başarı/hata sonucu bağımsız olarak kendi `status`/`attemptCount`/`lastError`
alanlarına yazılır.

`SmsProvider` arayüzü değişmiyor. `MockSmsProvider` zaten hazır.

### 6.4 Yönlendirme tablosu

| eventType | alıcı | smsMethod |
|---|---|---|
| `EmergencyTicketCreated` | aktif tüm OPERATIONS | `EMERGENCY_ALERT` |
| `TechnicianAssigned` | `payload.technicianId` | `TICKET_NOTIFICATION` |
| `ContractExpiring` | payload.siteId'nin aktif SITE_MANAGER üyelikleri + aktif tüm OPERATIONS | `TICKET_NOTIFICATION` |
| `InvoiceOverdue` | payload.siteId'nin aktif SITE_MANAGER üyelikleri + aktif tüm OPERATIONS | `TICKET_NOTIFICATION` |

`ContractExpiring`/`InvoiceOverdue` için SITE_MANAGER alıcıları yalnızca
`payload.siteId` ile eşleşen sitenin **aktif** üyeliklerinden gelir —
`MembershipQueryService.listActiveManagerUserIds(siteId)` zaten
`membershipRole='MANAGER', isActive=true, startsAt<=now, (endsAt IS NULL OR endsAt>now)`
filtresini uyguluyor; başka sitenin yöneticisi asla bu listeye girmez.

### 6.5 Recipient dedup ve normalizasyon kuralları (kritik karar #13)

- **Anahtar normalize edilmiş telefon numarasıdır, userId değil** — aynı
  fiziksel numaraya iki kez SMS gitmesini önlemek asıl amaç; bir
  kullanıcının global `role='OPERATIONS'` olması ile ayrıca bir site'de
  `membershipRole='MANAGER'` taşıması yapısal olarak mümkün (iki farklı,
  birbirini dışlamayan alan), bu durumda `listActiveOperationsPhones()` ve
  `listActiveManagerUserIds(siteId)` aynı kişiyi iki kez döndürebilir →
  fan-out, tüm resolver sonuçlarının **birleşimini** dedupe eder.
- **Normalizasyon zorunlu ve dedup'tan önce gelir**: her `recipientPhone`,
  `Set`'e eklenmeden ve herhangi bir `NotificationDelivery` satırı
  oluşturulmadan **önce** mevcut `normalizeE164()` (`src/common/utils/phone.util.ts`)
  ile normalize edilir. `User.phoneNumber` DB'de `chk_users_phone_e164`
  CHECK constraint'iyle zaten E.164 garantili olsa da, dedup ve unique
  constraint mantığının kendisi normalize edilmiş değer üzerinde
  çalıştığını **açıkça** varsaymalı — kaynağın örtük garantisine
  güvenmemeli. Bu, `UserContactLookupService`'in döndürdüğü her
  `{userId, phoneNumber}` çiftinin `phoneNumber` alanının fan-out
  içinde `normalizeE164()`'ten geçirildiği, ham DB değerinin doğrudan
  `Set`'e veya `NotificationDelivery.recipientPhone`'a yazılmadığı
  anlamına gelir.
- İnaktif/silinmiş kullanıcı: `UserContactLookupService`'in tüm metotları
  `isActive=true AND deletedAt IS NULL` filtreler; DB-membership arasında
  yarış durumu olursa (kullanıcı arada deaktive edilirse) o kayıt sonuç
  kümesinden zaten düşer, hata değil.
- Null/geçersiz telefon: yapısal olarak imkânsız — `User.phoneNumber`
  `NOT NULL` ve DB'de `chk_users_phone_e164` CHECK constraint'i format
  garantisi veriyor (bkz. §1). Faz 8 ayrıca format doğrulaması yapmaz
  (Faz 1-3'ün DTO/DB katmanıyla mükerrer olurdu) — yalnız normalizasyon
  (yukarıdaki madde) uygulanır, format DOĞRULAMASI değil.
- **DB seviyesi ek güvenlik**: `NotificationDelivery`'de
  `@@unique([sourceEventId, recipientPhone, channel])` — uygulama-seviyesi
  dedup'ı atlayan bir bug olsa bile aynı event için aynı (normalize
  edilmiş) numaraya iki delivery satırı oluşmasını DB seviyesinde
  engeller.

---

## 7. Scheduled jobs

### 7.1 InvoiceOverdue — domain yolu üzerinden (kritik karar #4)

`InvoiceStateMachine`'e **yeni, ayrı bir metot** eklenir — mevcut
`assertTransition`'a hiç dokunulmaz:

```ts
// Yalnız sistem-tetiklemeli InvoiceOverdueScanJob cagirir. Actor/API yolu
// (changeStatus -> assertTransition) bunu hicbir sekilde kullanmaz;
// OVERDUE'ya manuel giris hala kapali kalir.
assertSystemOverdueTransition(from: InvoiceStatus): void {
  if (from !== 'ISSUED') {
    throw new DomainError(ERROR_CODES.INVOICE_INVALID_STATUS_TRANSITION, HttpStatus.CONFLICT,
      `Sistem kaynakli OVERDUE gecisi yalniz ISSUED durumundan yapilabilir (mevcut: ${from}).`);
  }
}
```

`InvoiceService`'e yeni metot:

```ts
// InvoiceRow'da siteId alani YOK (ContractInvoice'un kendi siteId'si yok,
// yalniz contract.siteId'den turer - override doc #3). siteId, job'un
// zaten sahip oldugu aday satirindan parametre olarak gelir.
async markOverdueBySystem(invoiceId: string, siteId: string): Promise<InvoiceRow | null> {
  return this.prisma.$transaction(async (tx) => {
    const invoice = await this.invoiceRepo.findByIdForUpdate(tx, invoiceId);
    if (!invoice) return null;
    if (invoice.status !== 'ISSUED' || invoice.dueDate >= utcToday()) {
      return null; // baska worker/actor zaten cozmus veya artik uygun degil - hata degil
    }
    this.stateMachine.assertSystemOverdueTransition(invoice.status);
    const updated = await this.invoiceRepo.updateStatus(tx, invoiceId, { status: 'OVERDUE' });
    await this.audit.log(tx, {
      action: DOMAIN_AUDIT_ACTIONS.INVOICE_OVERDUE, entityType: 'ContractInvoice',
      entityId: invoiceId, siteId, metadata: { dueDate: invoice.dueDate },
    });
    await this.outbox.publishInTx(tx, {
      eventType: 'InvoiceOverdue', aggregateType: 'ContractInvoice', aggregateId: invoiceId,
      payload: { invoiceId, contractId: invoice.contractId, siteId,
                 invoiceNumber: invoice.invoiceNumber, dueDate: invoice.dueDate },
    });
    return updated;
  });
}
```

`InvoiceOverdueScanJob` (BillingModule içinde) **döngüsel** olarak aday
listesini okur (`InvoiceRepository.findOverdueCandidatesAcrossSites`,
salt-okunur, kilitsiz, mevcut `@@index([status, dueDate])`'i kullanır,
her turda `limit` kadar) ve her aday için (candidate satırı zaten
`siteId`'yi contract join'inden taşıdığı için) `invoiceService.markOverdueBySystem(candidate.id, candidate.siteId)`
çağırır; `null` dönerse (başka worker/actor önce halletmiş) sessizce
atlar, exception fırlarsa logla-devam-et (bir satırın hatası batch'i
durdurmaz). Bir turda dönen aday sayısı `limit`'ten azsa (backlog o gün
için tükendi) döngü sonlanır. `TRANSITION_NAMING` map'ine dokunulmaz
(actor-DTO akışına özgü kalır).

### 7.2 ContractExpiring — genişletilmiş yeniden-uyarı kuralları (kritik karar #12)

`expiryNotifiedAt` alanı korunuyor (Rev0), ama sıfırlama kuralları
netleştirildi. `ContractService.update` içinde, PATCH'in **sonuç**
durumuna göre (yalnız gerçek değişiklik varsa, no-op update'te değil):

1. **`endDate` değeri değişiyorsa** → `expiryNotifiedAt = null`.
2. **`status` değeri ACTIVE-DIŞI bir durumdan ACTIVE'e geçiyorsa**
   (DRAFT→ACTIVE veya SUSPENDED→ACTIVE) → `expiryNotifiedAt = null`.
   Gerekçe: sözleşme askıya alınıp tekrar aktive edildiğinde, aynı (veya
   artık daha da yakın) bitiş tarihine karşı taze bir uyarı şansı
   verilmeli — suspend sırasında endDate otomatik uzamıyor.
3. **`CONTRACT_EXPIRY_LEAD_DAYS` env değişikliği retroaktif değildir** —
   zaten `expiryNotifiedAt IS NOT NULL` olan sözleşmeler, eşik
   genişlese bile yeniden taranmaz. Ops gerçekten geçmişe dönük
   yeniden-bildirim isterse bu ayrı, manuel bir backfill script'i
   gerektirir (Faz 8 kapsamı dışı, dokümante edilen bir non-goal).

Aday sorgusu ve chunk mantığı Rev0 ile aynı (§5.3 ile artık advisory
lock'suz).

---

## 8. Veritabanı değişiklikleri

**Yeni migration, Faz 8'e özel — 4 parça:**

1. `Contract.expiryNotifiedAt DateTime? @db.Timestamptz(6)` + `@@index([status, endDate])` (Rev0'dan, değişmedi).
2. **`OutboxEvent.failedAt DateTime? @map("failed_at") @db.Timestamptz(6)`** (kritik karar #11 — `processedAt` yalnız başarıyı temsil eder).
3. **Yeni model `NotificationDelivery`** (kritik karar #2):
   ```prisma
   model NotificationDelivery {
     id                String       @id @default(uuid()) @db.Uuid
     sourceEventId     String       @map("source_event_id") @db.Uuid
     sourceEventType   String       @map("source_event_type") @db.VarChar(100)
     channel           String       @db.VarChar(20)   // 'SMS' (tek deger, Faz 8)
     smsMethod         String       @map("sms_method") @db.VarChar(30) // 'EMERGENCY_ALERT' | 'TICKET_NOTIFICATION'
     recipientUserId   String       @map("recipient_user_id") @db.Uuid
     recipientPhone    String       @map("recipient_phone") @db.VarChar(16)
     message           String       @db.VarChar(500)
     status            OutboxStatus @default(PENDING)
     attemptCount      Int          @default(0) @map("attempt_count")
     nextAttemptAt     DateTime?    @map("next_attempt_at") @db.Timestamptz(6)
     processedAt       DateTime?    @map("processed_at") @db.Timestamptz(6)
     failedAt           DateTime?   @map("failed_at") @db.Timestamptz(6)
     lastError         String?      @map("last_error") @db.VarChar(2000)
     createdAt         DateTime     @default(now()) @map("created_at") @db.Timestamptz(6)

     @@unique([sourceEventId, recipientPhone, channel])
     @@index([status, nextAttemptAt])
     @@map("notification_deliveries")
   }
   ```
   FK yok (OutboxEvent/AuditLog'daki "append-only, gevşek referans"
   felsefesiyle tutarlı — `sourceEventId` bilgi amaçlı, kısıtlama değil).
   `OutboxStatus` enum'ı yeniden kullanılıyor (yeni enum gerekmez).
   `recipientPhone`, fan-out tarafından **her zaman normalize edilmiş**
   (E.164) değerle doldurulur (§6.5) — unique constraint bu varsayıma
   dayanır.
4. **Tek seferlik veri temizliği** (kritik karar #3, aşağıda §9'da detaylı).

---

## 9. Güvenlik ve güvenilirlik

### 9.1 Eski backlog aktivasyon politikası (kritik karar #3)

Faz 4'ten beri biriken PENDING event'ler (eski acil ticket'lar, eski
teknisyen atamaları vb.) Faz 8 devreye girdiğinde SMS'e dönüşmemeli.
**Karar: tek seferlik migration SQL'i**, şema değişiklikleriyle aynı Faz 8
migration dosyasında:

```sql
UPDATE outbox_events
SET status = 'PROCESSED', processed_at = now(),
    last_error = 'SKIPPED_PRE_PHASE8_BACKLOG'
WHERE status IN ('PENDING', 'PROCESSING');
```

**Neden bu ve neden diğerleri değil**:
- *Cutoff-timestamp (runtime karşılaştırma)* yerine tercih edildi çünkü
  relay'e kalıcı, hiç kaldırılmayan bir "eğer createdAt < X ise atla"
  dallanması eklemeyi gerektirirdi — bu kalıcı karmaşıklık, oysa
  migration tek seferlik ve sonra unutulabilir.
- Migration, `prisma migrate deploy` sırasında (yeni relay kodu
  başlamadan ÖNCE, tipik CI/CD sırasıyla) çalışır — o ana kadar birikmiş
  HER ŞEYİ kapsar; migration'dan SONRA (relay başlamadan önceki kısa
  pencerede dahi) oluşan yeni event'ler bilerek dokunulmadan bırakılır,
  çünkü onlar gerçek/güncel olaylardır ve yeni relay tarafından doğru
  şekilde işlenmelidir.
- `lastError` alanı (teknik olarak bir "hata" olmasa da) bu tek seferlik
  atlamanın adli iz kaydı olarak kasıtlı şekilde yeniden kullanılıyor —
  yeni bir alan eklemeye değmeyecek, tamamen bir kereye mahsus bir not.
- **Audit kaydı yazılmaz**: migration.sql, Nest app dışında (Prisma
  migrate tarafından) çalıştığı için `AuditWriter`'a erişimi yok; yüzlerce
  satır için tek tek audit kaydı da anlamsız olurdu (aktör yok, gerçek
  bir iş kararı değil, deployment operasyonu). Bu adım bir **deployment
  runbook notu** olarak dokümante edilir; etkilenen satır sayısı deploy
  loglarında (`UPDATE ... RETURNING` ile psql üzerinden) gözlemlenebilir.

**Operasyonel sıralama önerisi**: bu yaklaşımın güvenliği migration'ın
relay'den ÖNCE çalıştığı varsayımına dayanır; bu bir deployment-sıralama
varsayımıdır, kod içinde garanti edilmez. Önerilen rollout: Faz 8'in İLK
deploy'unda `OUTBOX_RELAY_ENABLED=false` ile başla (kod devreye girer ama
relay hiç poll etmez) → migration'ın uygulandığını ve backlog'un
temizlendiğini doğrula (`SELECT count(*) FROM outbox_events WHERE status IN ('PENDING','PROCESSING')`
≈ 0, yalnız o andan sonra oluşan taze satırlar kalmalı) → ardından
`OUTBOX_RELAY_ENABLED=true`'ya çevir. Bu, zaten §10'da tanımlı kill-switch'i
yeniden kullanır — yeni kod gerektirmez, yalnız bir deployment runbook adımıdır.

### 9.2 Diğer riskler (Rev0'dan, kritik kararlarla güncellendi)

- **Relay crash / iki worker aynı satırı alır**: `FOR UPDATE SKIP LOCKED`
  + lease (artık attemptCount-artışıyla birlikte atomik, §5.1) —
  yapısal olarak imkânsız/otomatik kurtarma.
- **Fan-out sırasında crash**: artık **exactly-once** — delivery satırları
  + kaynak PROCESSED işareti tek transaction'da (§3.1), kısmi fan-out
  imkânsız.
- **SMS gönderilip delivery satırı PROCESSED olmadan crash**: kalan tek
  at-least-once riski burada — nadir, dokümante edilmiş, düşük şiddetli
  (§3.1, §6.3).
- **InvoiceOverdue state machine uyumu**: artık gerçek bir domain yolu
  üzerinden (§7.1) — guard hem korunuyor hem bypass edilmiyor.
- **ContractExpiring/InvoiceOverdue tekrar üretimi**: idempotent-by-construction
  (§5.3, §7.2).
- **Notification hatası ana transaction'ı bozmaz**: yapısal ayrıklık
  değişmedi.
- **Test ortamında gerçek SMS gitmez**: `CapturingSmsProvider` zaten
  mevcut; ayrıca `BACKGROUND_JOBS_ENABLED=false`/`OUTBOX_RELAY_ENABLED=false`
  test env varsayılanı (§10) gerçek zamanlayıcının test sırasında hiç
  tetiklenmemesini garanti eder.

**Loglama**: `maskPhone` (mevcut `mask.util.ts`) tüm log/hata mesajlarında
kullanılır; `NotificationDelivery.recipientPhone` kolonu düz metin
saklanır (SMS gönderimi için zorunlu, OTP kodu gibi bir "secret" değil —
CLAUDE.md'nin yasakladığı kategoriye girmiyor, ancak LOG satırlarında hâlâ
maskelenir).

---

## 10. Test stratejisi

### 10.1 Job/relay yaşam döngüsü (kritik karar #10)

- `OUTBOX_RELAY_ENABLED` (bool, varsayılan `true`) — yalnız relay'i kapatır.
- `BACKGROUND_JOBS_ENABLED` (bool, varsayılan `true`) — yalnız iki cron
  tarama job'unu kapatır. İkisi bağımsız anahtarlar.
- Her iki cron job `@Cron(expr, { timeZone: 'UTC' })` ile kayıtlı —
  sunucu locale'inden bağımsız, CLAUDE.md'nin "veritabanı zamanları UTC"
  kuralıyla tutarlı.
- **Test ortamında otomatik başlamama**: `test/integration/setup/postgres-testcontainer.ts`
  test env'ine `OUTBOX_RELAY_ENABLED=false`, `BACKGROUND_JOBS_ENABLED=false`
  varsayılan olarak eklenir. Bu yalnız bir dosyanın bu iki değeri set
  etmeyi hatırlamasına bağlı kalmasın diye, `src/config/configuration.ts`'teki
  config loader'a yapısal bir güvence eklenir:
  `enabled: env.NODE_ENV !== 'test' && env.OUTBOX_RELAY_ENABLED`
  (aynısı `backgroundJobs.enabled` için) — `NODE_ENV=test` HER ZAMAN
  otomatik olarak kapatır, gelecekte yeni bir test dosyası bu env
  değişkenini set etmeyi unutsa bile zamanlayıcı test sürecinde asla
  gerçekten başlamaz. Gerçek claim/dispatch mantığını test eden
  integration testler, zamanlayıcıyı beklemek yerine ilgili servis
  metodunu (`relay.pollOnce()`, `job.runOnce()`) **doğrudan** çağırır —
  bu hem hızlı hem deterministik, flaky zamanlama riski yok.
- `src/main.ts`'e `app.enableShutdownHooks()` eklenir (şu an yok — §1'de
  doğrulandı) — bu olmadan aşağıdaki `OnModuleDestroy` hiç tetiklenmez.
- `OutboxRelay`/`NotificationDeliveryRelay` `OnModuleInit`'te
  `SchedulerRegistry.addInterval` ile kayıt olur, iç durum olarak
  `currentPollPromise` tutar (re-entrancy guard'ıyla aynı bayrak).
  `OnModuleDestroy`: interval temizlenir, `currentPollPromise` varsa
  en fazla `SHUTDOWN_DRAIN_TIMEOUT_MS` (örn. 10s, sabit) kadar beklenir;
  aşılırsa uyarı loglanıp shutdown'a izin verilir (lease mekanizması
  zaten kurtarmayı garanti ediyor, sonsuz beklemeye gerek yok).

### 10.2 Test matrisi (kritik karar #14 — 12 somut senaryo)

**Unit** (mock Prisma/collaborator, mevcut desenle):
1. Claim sonrası crash simülasyonu: `attemptCount`'un claim adımında
   arttığını, dispatch hiç çağrılmasa bile bir sonraki claim'de
   `attemptCount`'un zaten yüksek olduğunu doğrulayan test.
2. Malformed payload → `NonRetryableDispatchError` → doğrudan FAILED
   (bütçe kalsa bile), `failedAt` set edilir.
3. Retryable hata + bütçe kaldı → `PENDING` + `nextAttemptAt` ileri.
4. Retryable hata + bütçe tükendi → `FAILED` + `failedAt` (artık
   `processedAt` DEĞİL).
5. Çoklu alıcıdan biri başarısız: `NotificationDeliveryRelay` düzeyinde
   yalnız o satırın retry'landığı, diğer (PROCESSED) satırın tekrar
   dokunulmadığı.
6. Tanınmayan eventType → payload hiç okunmadan no-op → PROCESSED (§6.1
   kararının doğrudan testi).
7. Sıfır alıcı çözümlenmesi → PROCESSED + `recipientCount:0` audit,
   hata fırlatılmaz.
8. Recipient dedup: aynı telefonun hem OPERATIONS hem site-manager
   listesinden gelmesi → tek `NotificationDelivery` satırı; ayrıca farklı
   formatta (boşluklu/tireli) ama aynı numarayı temsil eden iki kaynağın
   normalize edildikten sonra tek satıra indiği testi.
9. `InvoiceOverdueScanJob`: aday artık `ISSUED` değilse (`markOverdueBySystem`
   `null` döner) → job hatasız devam eder, audit/outbox üretilmez.
10. `ContractExpiringScanJob`: `endDate` değişince / ACTIVE'e yeniden
    girince `expiryNotifiedAt` sıfırlanır; lead-day config değişince
    zaten bildirilmiş sözleşme tekrar taranmaz.
11. Backoff formülü saf fonksiyon testi (`computeBackoffDelay`).
12. `InvoiceOverdue`'nun yalnız `InvoiceService.markOverdueBySystem` üzerinden
    üretildiği, `assertTransition`'ın (actor yolu) hâlâ `to==='OVERDUE'`'yu
    reddettiği (regresyon testi — Faz 7'nin mevcut testi zaten bunu
    kapsıyor, Faz 8 onu bozmadığını doğrular).

**Integration** (`test/integration/notifications/`, gerçek testcontainer
Postgres — mock'la test edilemeyecek gerçek concurrency):
- İki eşzamanlı `pollOnce()` çağrısının aynı satırı asla iki kez claim
  etmediği (`FOR UPDATE SKIP LOCKED` doğrulaması).
- Lease dolmadan ikinci claim'in satırı **almadığı** (negatif test).
- Lease dolduktan sonra reclaim edildiği.
- Eski backlog migration'ının gerçek DB'de PENDING satırları PROCESSED'e
  çevirdiği (migration testi).
- Fan-out transaction'ının atomikliği: fan-out ortasında enjekte edilen
  hata sonrası ne delivery satırı ne PROCESSED işareti kalıcı olmuyor
  (rollback doğrulaması).
- UTC tarih sınırı: `endDate`/`dueDate` gün sınırında (gece yarısı UTC)
  aday sorgusunun doğru tarafta davrandığı.
- Graceful shutdown: `OnModuleDestroy` çağrıldığında devam eden
  `pollOnce()`'un tamamlanmasının beklendiği.
- Yalnızca ilgili sitenin aktif SITE_MANAGER'larının `ContractExpiring`/
  `InvoiceOverdue` alıcı listesine girdiği, başka sitenin yöneticisinin
  girmediği (gerçek DB üzerinde membership izolasyon testi).

**E2E**: mevcut `CapturingSmsProvider` ile "acil ticket oluştur → relay
tick → dispatcher fan-out → delivery relay tick → `sendEmergencyAlert`
çağrıldı" uçtan uca akışı; test ortamında zamanlayıcıların hiç otomatik
başlamadığının doğrulanması (§10.1).

**Zaman/clock boşluğu**: Rev0 kararı korunuyor — Clock soyutlaması
eklenmiyor, backoff saf fonksiyon seviyesinde test ediliyor, lease-expiry
gibi DB-zamanına bağımlı davranışlar kısa gerçek bekleme ile.

---

## 11. Dosya değişiklik listesi

**Yeni dosyalar:**
- `src/modules/notifications/notifications.module.ts`
- `src/modules/notifications/outbox-relay.service.ts`
- `src/modules/notifications/notification-delivery-relay.service.ts`
- `src/modules/notifications/notification-dispatcher.service.ts` (fan-out)
- `src/modules/notifications/notification-routes.ts`
- `src/modules/notifications/schemas/outbox-payload.schemas.ts`
- `src/modules/notifications/errors/dispatch-error.ts` (`NonRetryableDispatchError`)
- `src/modules/notifications/utils/backoff.util.ts`
- `src/modules/billing/jobs/invoice-overdue-scan.job.ts`
- `src/modules/contracts/jobs/contract-expiring-scan.job.ts`
- `src/modules/users/services/user-contact-lookup.service.ts`
- İlgili `.spec.ts` dosyaları (her yeni dosya için)
- `test/integration/notifications/outbox-relay-concurrency.integration-spec.ts`
- `test/integration/notifications/fanout-atomicity.integration-spec.ts`
- `test/integration/notifications/scan-jobs.integration-spec.ts`
- `test/integration/notifications/backlog-migration.integration-spec.ts`
- `test/e2e/notifications.e2e-spec.ts`
- Yeni Prisma migration (schema §8'deki 4 parça + backlog UPDATE)

**Değişecek mevcut dosyalar:**
- `prisma/schema.prisma` — `Contract.expiryNotifiedAt`+index,
  `OutboxEvent.failedAt`, yeni `NotificationDelivery` modeli.
- `src/main.ts` — `app.enableShutdownHooks()` eklenir.
- `src/config/validation.schema.ts`, `src/config/configuration.ts` — §13.
- `src/app.module.ts` — `ScheduleModule.forRoot()`, `NotificationsModule`.
- `src/modules/users/users.module.ts` — `UserContactLookupService` export.
- `src/modules/users/repositories/user.repository.ts` — yeni lookup metotları.
- `src/modules/memberships/membership-query.service.ts`,
  `.../repositories/site-membership.repository.ts` — `listActiveManagerUserIds`.
- `src/modules/billing/repositories/invoice.repository.ts` — `findOverdueCandidatesAcrossSites`.
- `src/modules/billing/services/invoice.service.ts` — yeni `markOverdueBySystem`.
- `src/modules/billing/state/invoice-state-machine.ts` — yeni `assertSystemOverdueTransition` (yalnız EKLEME, mevcut `assertTransition` değişmez).
- `src/modules/contracts/repositories/contract.repository.ts` — `findExpiringSoonAcrossSites`.
- `src/modules/contracts/services/contract.service.ts` — `expiryNotifiedAt` sıfırlama (endDate değişimi + ACTIVE'e yeniden giriş).
- `src/modules/billing/billing.module.ts`, `src/modules/contracts/contracts.module.ts` — yeni job provider'ları (exports değişmez).
- `src/common/constants/domain-audit-actions.constant.ts` — Faz 8 bloğu
  (`INVOICE_OVERDUE`, `CONTRACT_EXPIRING_NOTIFIED`, `OUTBOX_EVENT_FAILED`,
  `NOTIFICATION_DELIVERY_FAILED`).
- `package.json` — `@nestjs/schedule`.

**Dokunulmayacak**: `InvoiceStateMachine.assertTransition` (yalnız yeni
metot eklenir, mevcut değişmez), `ContractStateMachine`, `outbox.service.ts`
(yazma tarafı), `sms-provider.interface.ts`, `TRANSITION_NAMING` map'i,
tüm Faz 1-7 controller/DTO/policy dosyaları.

---

## 12. Uygulama sırası

### Dilim 1 / Dilim 2 ayrımı

Aşağıdaki 13 adım iki bağımsız teslim edilebilir dilime bölünüyor —
Dilim 1, Contract/Invoice domain servislerine hiç dokunmadan uçtan uca
çalışan bir bildirim borusu teslim eder; Dilim 2 onun üzerine iki tarama
job'unu ekler.

**Dilim 1 — çekirdek relay + bildirim borusu (adım 1-5, 8-11, 13'ün ilgili
kısmı)**. Kapsam: `@nestjs/schedule` kurulumu; şemaya yalnız `failedAt` +
`NotificationDelivery` eklenir (`expiryNotifiedAt` henüz eklenmez);
backlog-temizleme migration'ı; `main.ts` shutdown-hook'u; env/config;
`UserContactLookupService`; `OutboxRelay`; payload şemaları + `NotificationDispatcher`
(yalnız halihazırda var olan `EmergencyTicketCreated`/`TechnicianAssigned`
route'ları için — `ContractExpiring`/`InvoiceOverdue` route'ları henüz
yok); `NotificationDeliveryRelay`; `AppModule` wiring. **Etkilenen
dosyalar**: §11'deki tüm `src/modules/notifications/**` dosyaları,
`src/modules/users/**` değişiklikleri, `src/modules/memberships/**`
değişiklikleri, `src/main.ts`, `src/config/**`, `src/app.module.ts`,
`prisma/schema.prisma` (yalnız `failedAt`+`NotificationDelivery` kısmı),
`package.json`. **Contracts/Billing modüllerine hiç dokunulmaz.** Dilim 1
sonunda: acil ticket oluşturma ve teknisyen atama gerçek SMS'e (mock
provider üzerinden) dönüşür, sistem uçtan uca test edilebilir durumda olur.

**Dilim 2 — tarama job'ları (adım 6-7, 12-13'ün kalanı)**. Kapsam:
`Contract.expiryNotifiedAt`+index migration'ı; `InvoiceStateMachine.assertSystemOverdueTransition`;
`InvoiceService.markOverdueBySystem`; `InvoiceRepository.findOverdueCandidatesAcrossSites`;
`InvoiceOverdueScanJob`; `ContractRepository.findExpiringSoonAcrossSites`;
`ContractExpiringScanJob`; `ContractService.update` sıfırlama dokunuşu;
yönlendirme tablosuna `ContractExpiring`/`InvoiceOverdue` route'larının
eklenmesi. **Etkilenen dosyalar**: `src/modules/billing/**`,
`src/modules/contracts/**` değişiklikleri (§11'de listeli), ikinci bir
küçük Prisma migration.

Bu ayrımın nedeni: Dilim 1 tek başına dağıtılabilir/test edilebilir bir
artış sağlar ve mevcut Faz 7 domain kodunu (Contract/Invoice) hiç
etkilemez — risk yüzeyi küçük. Dilim 2, zaten çalışan ve test edilmiş bir
relay motorunun üzerine, yalnız iki yeni üretici (job) ekler.

### Adımlar

1. `@nestjs/schedule` kurulumu.
2. Schema: `expiryNotifiedAt`+index, `failedAt`, `NotificationDelivery`
   modeli → migration → backlog UPDATE aynı migration'a eklenir →
   `prisma format`/`validate`.
3. `src/main.ts`'e `enableShutdownHooks()`.
4. Env/config (§13 aşağıda).
5. `UserContactLookupService` + `listActiveManagerUserIds` — izole, bağımsız test edilebilir.
6. `InvoiceStateMachine.assertSystemOverdueTransition` + `InvoiceService.markOverdueBySystem` + `InvoiceRepository.findOverdueCandidatesAcrossSites` + `InvoiceOverdueScanJob`.
7. `ContractRepository.findExpiringSoonAcrossSites` + `ContractExpiringScanJob` + `ContractService.update` sıfırlama dokunuşu.
8. `OutboxRelay` (attemptCount-at-claim + sweep + backoff) — dispatcher mock'lanarak izole test edilebilir.
9. Payload şemaları + hata sınıflandırması + `NotificationDispatcher` (fan-out) + yönlendirme tablosu.
10. `NotificationDeliveryRelay`.
11. `AppModule` wiring (`ScheduleModule.forRoot()`, `NotificationsModule`).
12. Integration testler (concurrency, fan-out atomikliği, backlog migration, job idempotency) → e2e.
13. Doğrulama: `npm install` → lint → `tsc build` → `prisma format` → `prisma validate` → `docker compose config` → tüm testler.

---

## 13. Config/env değişiklikleri (netleştirilmiş)

**Yeni env (Zod'a eklenir):**
- `CONTRACT_EXPIRY_LEAD_DAYS` — iş kuralı eşiği (`EMERGENCY_SLA_HOURS` emsali), varsayılan 30.
- `OUTBOX_RELAY_POLL_INTERVAL_MS` (varsayılan 5000), `OUTBOX_RELAY_BATCH_SIZE`
  (varsayılan 20), `OUTBOX_MAX_ATTEMPTS` (varsayılan 10),
  `OUTBOX_CLAIM_LEASE_MS` (varsayılan 60000) — hem `OutboxRelay` hem
  `NotificationDeliveryRelay` **aynı** dört değeri paylaşır (bilinçli
  basitleştirme — ikisi de "outbox alt sistemi"nin parçası, birlikte
  tuning edilmesi beklenir; bağımsız tuning ihtiyacı çıkarsa ayrılabilir).
- `OUTBOX_RELAY_ENABLED`, `BACKGROUND_JOBS_ENABLED` (bool, kill-switch).

**Sabit (constant, env değil)**: backoff taban/tavan değerleri, sweep
batch boyutu, `SHUTDOWN_DRAIN_TIMEOUT_MS`, cron ifadeleri (`@Cron` statik
decorator — poll interval'ın aksine correctness gereksinimi yok).

---

## 14. Onaylanan kararlar (özet)

Aşağıdaki 8 madde bu planın onayı sırasında kesinleşmiştir (ayrıntı için
yukarıdaki "Onay durumu" bölümü):

1. Acil arıza SMS alıcısı: tüm aktif OPERATIONS.
2. ContractExpiring/InvoiceOverdue alıcı kapsamı: ilgili sitenin aktif SITE_MANAGER üyelikleri + tüm aktif OPERATIONS.
3. `CONTRACT_EXPIRY_LEAD_DAYS`: varsayılan 30, env ile değiştirilebilir.
4. Relay varsayılanları: poll=5000ms, batch=20, maxAttempts=10, lease=60000ms.
5. FAILED gözlemlenebilirliği: structured log + AuditLog; harici alerting sonraki production-readiness çalışmasına bırakılıyor.
6. `outbox_events` tek onaylı tüketici varsayımıyla uygulanıyor.
7. `OutboxRelay`/`NotificationDeliveryRelay` aynı temel relay config değerlerini paylaşıyor.
8. Mesajlar düz metin/template literal ile üretiliyor, ayrı şablon motoru yok.

---

## 15. Riskler ve önlemler

| Risk | Önlem |
|---|---|
| Zehirli (poison-pill) satır sonsuz reclaim döngüsüne girer | attemptCount claim'de artar (§5.1) — crash sonrası bile bütçe tükenir, sweep FAILED'e çeker |
| İki replika aynı satırı işler (her iki tablo için) | `FOR UPDATE SKIP LOCKED` + tek atomik UPDATE (§5.1, aynı model iki relay'de) |
| Fan-out kısmen tamamlanır (bazı delivery satırı var, kaynak hâlâ PENDING) | Tek transaction — yapısal olarak imkânsız (§3.1) |
| Bir alıcının hatası diğer başarılı alıcılara tekrar SMS gönderir | Per-recipient bağımsız `NotificationDelivery` satırı (§3.1, §6.3) |
| Eski backlog (Faz 4-7) devreye girince SMS patlaması | Tek seferlik migration UPDATE'i + `OUTBOX_RELAY_ENABLED=false` ile başlayan rollout (§9.1) |
| InvoiceOverdue actor-guard'ı zayıflatır | Ayrı `assertSystemOverdueTransition`, `assertTransition` dokunulmaz (§7.1) |
| Gereksiz advisory lock karmaşıklığı | Kaldırıldı, row-lock + idempotent recheck yeterli (§5.3) |
| Bozuk payload sonsuz retry'a girer | Non-retryable sınıflandırma → doğrudan FAILED (§4) |
| Env değerleri SQL injection riski taşır | Prisma tagged-template parametreli bağlama, string interpolation yok (§5.1) |
| Yavaş (crash olmayan) worker lease'i geçer, ikinci worker üstüne biner | Lease, gerçekçi işlem süresinin kat kat üzerinde boyutlandırılır + batch içi paralel dispatch (§9, §6.3) |
| Test sırasında gerçek zamanlayıcı tetiklenir | `OUTBOX_RELAY_ENABLED=false`/`BACKGROUND_JOBS_ENABLED=false` hem test-setup hem `NODE_ENV` bazlı config-loader güvencesiyle (§10.1) |
| Deploy sırasında relay mid-batch kesilir | `enableShutdownHooks()` + graceful drain, üst sınırlı bekleme (§10.1) |
| Yeniden aktive edilen sözleşme hiç uyarılmaz | ACTIVE'e her giriş `expiryNotifiedAt`'i sıfırlar (§7.2) |
| Aynı numaraya iki kanaldan (OPS+manager) SMS | Normalize edilmiş telefon-bazlı union dedup + DB unique constraint (§6.5) |
| Başka sitenin yöneticisine yanlışlıkla bildirim gider | `listActiveManagerUserIds(siteId)` yalnız o sitenin aktif üyeliklerini döndürür (§6.4) |

---

## 16. Planın kısa özeti

Revizyon 1, Revizyon 0'ın 14 tespit edilen mimari boşluğunu şu üç yapısal
değişiklikle kapatıyor: **(1)** attemptCount artık claim anında atomik
olarak artıyor (crash-tolerant bütçe takibi), **(2)** notification
tüketimi ikiye ayrıldı — `outbox_events` (domain akışı, tek onaylı
tüketicili, `OutboxRelay`) → **exactly-once fan-out** → yeni
`notification_deliveries` (per-recipient, bağımsız retry, `NotificationDeliveryRelay`,
at-least-once yalnız burada), **(3)** InvoiceOverdue artık
`InvoiceService.markOverdueBySystem` + yeni `assertSystemOverdueTransition`
üzerinden, tam bir domain yolu izleyerek üretiliyor — actor-guard'a hiç
dokunulmadan. Advisory lock'lar kaldırıldı (gereksizdi), eski backlog için
tek seferlik migration UPDATE'i eklendi, FAILED artık kendi `failedAt`
alanını kullanıyor, ve job/relay yaşam döngüsü (UTC cron, enable/disable
anahtarları, graceful shutdown, test-ortamı izolasyonu) tam olarak
tanımlandı. İkinci mimari incelemede (Revizyon 1.1) 7 ek düzeltme
(bir gerçek derleme hatası dahil) uygulandı. Yeni şema yüzeyi:
`Contract.expiryNotifiedAt`+index, `OutboxEvent.failedAt`, yeni
`NotificationDelivery` modeli. Hâlâ PostgreSQL-only, hâlâ sıfır broker,
hâlâ `SmsProvider` arayüzü değişmedi.

**Durum: Onaylandı — implementasyona hazır (Dilim 1'den başlanacak).**

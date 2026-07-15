# Faz 7 — Contracts & Billing: Uygulama Planı (Revize 4 — onay sonrası üç teknik düzeltme)

## Bağlam

Faz 1–6 tamamlandı ve `main`'e merge edildi. `Contract`/`ContractInvoice` Prisma
modelleri ve mevcut PostgreSQL kısıtları zaten migrate edilmiş durumda. Bu
üçüncü revizyon, ikinci revizyonda kalan beş bütünlük açığını kapatır: EXPIRED
sınırının yanlış (`<=` yerine `<` olması gerekirken) tanımlanması; TERMINATED
fatura penceresinin `terminatedAt`'in `endDate`'i aşabileceği durumu hesaba
katmaması; `ContractInvoice`'un koşulsuz unique kısıtının `CANCELLED` bir
faturanın dönemini sonsuza kadar rezerve etmesi (iptal+yeniden-oluşturmayı
imkansız kılması); fatura para biriminin client'tan alınabilir görünmesi;
sözleşme feshinin var olan faturaları sessizce tutarsızlaştırabilmesi. **Bu
revizyonla plan artık `prisma/schema.prisma`'da bir gerçek model değişikliği de
içeriyor** (bir `@@unique`'in kaldırılması) — migration artık "yalnız ekleyen"
değil, **kontrollü bir dönüşüm**.

**Değişmeyen doğru kararlar** (bu revizyonda korunuyor): `ContractsModule`/
`BillingModule` ayrımı; `ContractLookupService` tek public erişim sözleşmesi;
`ContractRepository` export edilmiyor; `POST /contracts` (siteId body'de);
Faz 7'de manuel `OVERDUE` yok; `referenceNumber` yalnız `BANK_TRANSFER`'da
zorunlu; saf pessimistic `FOR UPDATE`, version kolonu yok; `CONCURRENT_
MODIFICATION` Faz 7 hata yüzeyinde yok; invoice-period trigger + CHECK
yaklaşımı (genişletilmiş biçimde) korunuyor; Faz 1–6 regresyon planı korunuyor.

**Bu revizyonun dokuz zorunlu düzeltmesi:** (1) EXPIRED sınırı `endDate <
CURRENT_DATE` olarak düzeltildi (`<=` her yerden temizlendi); (2) TERMINATED
fatura penceresi `LEAST(endDate+1, DATE(terminatedAt UTC)+1)` olarak düzeltildi;
(3) `ContractInvoice`'un koşulsuz unique kısıtı kaldırılıp `WHERE status <>
'CANCELLED'` partial unique index ile değiştirildi; (4) invoice `currency`'si
client'tan alınmıyor, kilitli contract'tan server-side kopyalanıyor; (5)
contract termination, çakışan (dönemi aşan) non-CANCELLED faturalar varsa
reddediliyor (yeni `CONTRACT_TERMINATION_INVOICE_CONFLICT`); (6) invoice-period
trigger'ı billability + currency kontrolünü de kapsayacak şekilde genişletildi,
`FOR KEY SHARE` ile ebeveyn okuması güçlendirildi; (7) migration bölümü
tamamen güncellendi; (8) iki yeni error code + genişletilmiş test listesi; (9)
Bölüm 1–26'daki eski/çelişkili ifadeler temizlendi.

---

## 1. Mevcut kod ve veritabanı durumunun özeti

**Şema** — `Contract`/`ContractInvoice` modelleri ve enum'ları Faz 1'den beri
migrate edilmiş. **Bu revizyonla `prisma/schema.prisma`'da gerçek bir model
değişikliği planlanıyor**: `ContractInvoice.@@unique([contractId,
billingPeriodStart])` satırı **kaldırılacak** (bkz. Bölüm 4.4/11) — bu,
Faz 7'nin şemaya dokunan tek değişikliğidir, geri kalan her şey (yeni sequence,
CHECK, trigger) önceki gibi schema.prisma'da hiç görünmeyen, yalnız migration
SQL'inde var olan PostgreSQL-özel nesnelerdir (mevcut `uq_facilities_parent_
code_alive`, `uq_assignments_one_current_per_ticket`, `ticket_code_seq`,
`excl_contracts_active_overlap` emsalleriyle aynı kategori).

**Doğrulanmış migration envanteri** (`Get-ChildItem` ile teyit edildi, tek
Glob sonucuna güvenilmedi): yalnız `20260709235959_init` ve `20260710000100_
custom_constraints` var, başka migration yok. **Bu ikisine hâlâ dokunulmuyor.**
Üçüncü migration artık **"yalnız ekleyen" değil** — bir gerçek DROP INDEX
(schema diff kaynaklı) + çok sayıda yeni CREATE/ALTER içeren **kontrollü bir
dönüşüm migration'ı** (bkz. Bölüm 11).

**Mevcut kod:** `src/modules/tickets/services/contract-query.service.ts`
silinip davranışı `ContractsModule`'ün `ContractLookupService`'ine taşınıyor
(değişmedi, Revize 2'deki gibi).

---

## 2. Faz 7 kapsamı

`ContractsModule` + `BillingModule` (değişmedi); `contractNumber`/
`invoiceNumber` sequence'leri; **genişletilmiş** invoice-period-within-contract
trigger'ı (artık billability + currency dahil, `FOR SHARE`); **yeni**
contract-termination-invoice-conflict trigger'ı; `dueDate>=issueDate`, ödeme
tutarlılığı, termination tutarlılığı CHECK'leri; **koşulsuz unique →
partial unique dönüşümü**; `contract-query.service.ts`'nin taşınması; yeni
error code/audit/outbox; genişletilmiş spike testi (artık altı hata şekli);
iki-modüllü unit/integration/E2E testleri.

## 3. Kapsam dışı işler

Değişmedi (Revize 2 ile aynı liste) — frontend, ödeme geçidi, e-fatura, PDF,
banka entegrasyonu, otomatik tahsilat, notification, outbox relay, cron
job'lar, Swagger, production deployment, contract dosya eki, S3/MinIO, README,
seed data. Manuel `OVERDUE` kapsam dışı. **Faz 7'de refund/invoice-düzeltme
sistemi yok** — bu, Bölüm 4.5'teki termination-conflict kuralının doğrudan
sonucu (PAID bir fatura çakışıyorsa fesih de reddedilir, veri sessizce
tutarsızlaştırılmaz).

---

## 4. Kesinleşen iş kuralları

### 4.1 Modül otoritesi
Değişmedi — bkz. Revize 2 Bölüm 4.1 / bu revizyon Bölüm 13/15.

### 4.2 Contract — oluşturma, alan kuralları, **düzeltilmiş EXPIRED sınırı**
`POST /contracts`, `contractNumber` sequence-üretimli, `siteId`/
`contractNumber`/`startDate` immutable, `endDate` kuralları (DRAFT serbest,
ACTIVE/SUSPENDED yalnız uzatma, EXPIRED/TERMINATED değiştirilemez) — hepsi
değişmedi.

**Düzeltme (madde 1):** Contract dönem aralığı `[startDate, endDate]`
**kapsayıcı-kapsayıcı** olduğundan, sözleşme `endDate` gününün tamamı boyunca
hâlâ geçerlidir.
- `DRAFT/SUSPENDED→ACTIVE`: `endDate >= CURRENT_DATE` guard'ı (**değişmedi**
  — `endDate` bugünse veya gelecekteyse aktivasyon izinli, çünkü sözleşme o
  gün hâlâ yürürlükte sayılır).
- `ACTIVE/SUSPENDED→EXPIRED`: **`endDate < CURRENT_DATE`** guard'ı (**düzeltildi,
  eskiden yanlışlıkla `<=` idi**). `endDate === CURRENT_DATE` iken `EXPIRED`'a
  geçiş **reddedilir** — sözleşme o gün boyunca hâlâ geçerli kabul edilir,
  yalnız ertesi gün (`endDate` kesinlikle geçmişte kaldığında) `EXPIRED`
  işaretlenebilir.
- Bu iki guard artık simetrik ve çakışmasız: `endDate >= bugün` → hâlâ
  aktive edilebilir/aktif kalabilir; `endDate < bugün` → artık yalnız
  `EXPIRED` işaretlenebilir. `endDate === bugün` anında sözleşme kesin olarak
  "hâlâ geçerli" tarafında durur, hiçbir belirsizlik yok.

### 4.3 Invoice — oluşturma, alan kuralları, **currency server-copy**
Oluşturma her zaman `DRAFT`; `invoiceNumber` sequence-üretimli; `PATCH
/invoices/:id` yok; `dueDate>=issueDate` zorunlu — hepsi değişmedi.

**Düzeltme (madde 4):** `currency` **`CreateInvoiceDto`'da yer almaz**. Invoice
oluşturulurken, kilitli (`FOR UPDATE`) contract satırının **o anki**
`currency` değeri okunup invoice satırına **snapshot** olarak yazılır — client
hiçbir şekilde invoice para birimini belirleyemez. Bu, `Contract.currency`'nin
yalnız `DRAFT`'ta düzenlenebilir olması (Bölüm 4.2) ve invoice'ların zaten
`DRAFT` contract'a karşı oluşturulamaması (Bölüm 4.4) nedeniyle pratikte
"contract aktive olduğu andaki para birimi dondurulur" anlamına gelir — yine
de bu bir **snapshot** olarak ele alınır (contract'ın kendisi değil, invoice
satırının kendi `currency` kolonu, geleceğe dönük hiçbir bağımlılık taşımaz).

### 4.4 Invoice oluşturma — contract-status matrisi ve **düzeltilmiş TERMINATED penceresi**

| Contract durumu | Fatura oluşturma | Kabul edilebilir dönem penceresi |
|---|---|---|
| `DRAFT` | Yasak | — |
| `ACTIVE` | İzinli | `[startDate, endDate + 1 gün)` |
| `SUSPENDED` | Faz 7'de yasak | — |
| `EXPIRED` | İzinli (geçmişe dönük) | `[startDate, endDate + 1 gün)` |
| `TERMINATED` | İzinli, yalnız termination'a kadar | `[startDate, LEAST(endDate + 1 gün, DATE(terminatedAt UTC) + 1 gün))` |

**Düzeltme (madde 2):** `TERMINATED` için pencere üst sınırı artık **yalnız**
`DATE(terminatedAt)+1` değil,
```
LEAST(
  contract.endDate + 1 gün,
  DATE(contract.terminatedAt AT TIME ZONE 'UTC') + 1 gün
)
```
'dir. Gerekçe: `terminatedAt`, `contract.endDate`'ten **sonra** kaydedilmiş
olabilir (örn. sözleşme doğal süresi dolduktan bir hafta sonra fesih işlemi
girildi) — böyle bir durumda dahi fatura penceresi sözleşmenin **kendi doğal
`endDate` sınırını asla aşamaz**. `LEAST(...)` bu iki üst sınırdan küçük
olanını seçerek her koşulda doğru davranır: `terminatedAt <= endDate` ise
(erken/normal fesih) sınırlayan `terminatedAt`; `terminatedAt > endDate` ise
(geç kaydedilen fesih) sınırlayan yine `endDate`'in kendisi olur.

Bu formül **birebir aynı şekilde** dört yerde kullanılır: `InvoiceService`
uygulama ön-kontrolü (Bölüm 12f), PostgreSQL trigger'ı (Bölüm 11), unit test,
integration test, E2E test — hiçbir yerde yalnız `terminatedAt+1` kullanan eski
(yanlış) formül kalmamıştır.

`DRAFT`/`SUSPENDED` reddi → `422 INVOICE_CONTRACT_NOT_BILLABLE`. Pencere dışı
kalan istek (üç durumun hepsinde) → `422 INVOICE_PERIOD_OUT_OF_CONTRACT`.

### 4.5 Contract termination, var olan invoice'ları geçersizleştiremez (**yeni**)

`ACTIVE`/`SUSPENDED → TERMINATED` geçişi öncesinde (`DRAFT→TERMINATED`'ın buna
ihtiyacı yok, çünkü `DRAFT` bir contract'a hiç invoice oluşturulamaz —
Bölüm 4.4), aynı contract'a ait **`status <> 'CANCELLED'`** bütün invoice'lar
kontrol edilir. Her biri için:
```
invoice.billingPeriodEnd <= effectiveTerminationWindowEnd
```
olmalı, burada
```
effectiveTerminationWindowEnd = LEAST(
  contract.endDate + 1 gün,
  DATE(proposedTerminatedAt AT TIME ZONE 'UTC') + 1 gün
)
```
(`proposedTerminatedAt` = bu `PATCH` isteğinin set edeceği `now()` değeri).
Bu sınırı aşan **en az bir** non-CANCELLED invoice varsa → **`409
CONTRACT_TERMINATION_INVOICE_CONFLICT`**. Kullanıcı önce ilgili `DRAFT`/
`ISSUED` faturaları `CANCELLED` yapmalı, sonra contract'ı terminate etmelidir.
**`PAID` bir invoice sınırı aşıyorsa fesih de reddedilir** — Faz 7'de refund
veya invoice-düzeltme mekanizması olmadığından, veri sessizce
tutarsızlaştırılmaz; bu durumda contract bu haliyle terminate edilemez (kabul
edilen bir sınırlama, Bölüm 26).

Bu kural hem `ContractService`'in uygulama ön-kontrolünde hem de yeni bir
PostgreSQL trigger'ında (Bölüm 11, `fn_contract_termination_invoice_conflict`)
uygulanır — ikisi **aynı `LEAST(...)` formülünü** kullanır.

### 4.6 DRAFT çakışma davranışı
Değişmedi — bkz. Revize 2 Bölüm 4.6 (DRAFT–DRAFT serbest, DRAFT-vs-ACTIVE/
SUSPENDED yalnız app ön-kontrolü, DB backstop'u yok, nihai güvence
aktivasyonda/uzatmada).

### 4.7 Invoice dönem bütünlüğü — üç katmanlı güvence (**genişletildi**)
Uygulama ön-kontrolü (Bölüm 4.4 mantığı, `LEAST` formülü dahil) + genişletilmiş
PostgreSQL trigger'ı (Bölüm 11 — artık yalnız dönem değil, billability ve
currency da kontrol ediyor) + (fatura oluşturma sırasında contract satırının
zaten `FOR UPDATE` ile kilitli olması, trigger'ın ayrıca `FOR SHARE` ile
okuması — doğrudan-DB-yazımı senaryolarında bile contract güncellemeleriyle
yarışı güvenli biçimde serileştiriyor).

### 4.8 CHECK kısıtları — değişmedi
`chk_invoice_due_after_issue`, `chk_invoice_payment_consistency`,
`chk_contract_termination_consistency` — Revize 2'deki gibi, hepsi app
pre-check + DB backstop ikilisiyle.

### 4.9 Concurrency ilkesi — değişmedi
Saf pessimistic `FOR UPDATE`, version kolonu yok, `CONCURRENT_MODIFICATION`
Faz 7 yüzeyinde yok (Bölüm 12).

### 4.10 Sequence davranışı — değişmedi
Bölüm 4.10 (Revize 2) aynen geçerli: rollback'te numara boşluğu normal,
kesintisiz yasal numaralandırma garantisi yok, yıl app sunucusunun
`getUTCFullYear()`'ından, e-fatura kapsam dışı.

### 4.11 Invoice iptal + yeniden oluşturma (**yeni**)
`ContractInvoice.@@unique([contractId, billingPeriodStart])` **koşulsuz**
kısıtı, invoice'lar immutable olduğundan (Bölüm 4.3) ve `PATCH /invoices/:id`
olmadığından, `CANCELLED` bir invoice'ın dönem başlangıcını **sonsuza kadar**
rezerve etmesine yol açıyordu — tek düzeltme yolu (iptal et + yeniden oluştur)
bu kısıt yüzünden imkansızdı. Düzeltme: koşulsuz unique kaldırılıp yerine
`WHERE status <> 'CANCELLED'` **partial** unique index kondu (Bölüm 11). Sonuç:
- Bir invoice `CANCELLED` olduktan sonra **aynı contract + aynı
  `billingPeriodStart`** ile yeni bir invoice başarıyla oluşturulabilir.
- İki **non-CANCELLED** invoice hâlâ aynı dönem başlangıcıyla oluşturulamaz
  (partial index bunu yakalar, aynı `INVOICE_PERIOD_OVERLAP` koduna eşlenir).
- `excl_invoice_period_overlap` (zaten `WHERE status<>'CANCELLED'` kullanıyordu)
  **değişmeden korunuyor** — iki kısıt artık tutarlı, aynı `CANCELLED`
  istisnasını paylaşıyor.

---

## 5. Açık sorular ve mevcut koddan çıkarılamayan kararlar

Bu revizyonla birlikte önceki taslağın tüm majör kararları (modül bölünmesi,
invoice-contract-status matrisi, EXPIRED/TERMINATED sınır matematiği, invoice
iptal+yeniden-oluşturma, currency bütünlüğü, termination-invoice çakışması,
concurrency modeli) kesinleşti. Geriye yalnız iki düşük etkili, bloklayıcı
olmayan not kalıyor (Revize 2 ile aynı):

1. Fatura iptal gerekçesi için ayrı bir alan/mekanizma eklenmiyor.
2. `OVERDUE→ISSUED` "geri alma" desteklenmiyor.

`GET /contracts/:id`/`GET /invoices/:id` eklenmemesi ve birleşik `PATCH
/contracts/:id` — bilinçli, belgelenen tasarım kararları (açık soru değil).

---

## 6. Endpoint matrisi

| # | Method + Path | Roller | DTO | Response | Hata kodları |
|---|---|---|---|---|---|
| 1 | `POST /contracts` | OPERATIONS | `CreateContractDto {siteId, ...}` | `ContractResponse` (201) | `SITE_NOT_FOUND`(404), `CONTRACT_INVALID_DATE_RANGE`(422), `CONTRACT_OVERLAP`(409) |
| 2 | `GET /sites/:siteId/contracts` | OPERATIONS, SITE_MANAGER | `ListContractsQueryDto` | `PaginatedResult<ContractResponse>` | `SITE_NOT_FOUND`(404) |
| 3 | `PATCH /contracts/:id` | OPERATIONS | `UpdateContractDto` | `ContractResponse` (200) | `CONTRACT_NOT_FOUND`(404), `CONTRACT_UPDATE_EMPTY`(422), `CONTRACT_IMMUTABLE_FIELD`(422), `CONTRACT_INVALID_DATE_RANGE`(422), `CONTRACT_STATUS_UNCHANGED`(409), `CONTRACT_INVALID_STATUS_TRANSITION`(409), `CONTRACT_OVERLAP`(409), **`CONTRACT_TERMINATION_INVOICE_CONFLICT`(409, yeni)** |
| 4 | `POST /contracts/:id/invoices` | OPERATIONS | `CreateInvoiceDto` (**`currency` yok**) | `InvoiceResponse` (201) | `CONTRACT_NOT_FOUND`(404), `INVOICE_CONTRACT_NOT_BILLABLE`(422), `INVOICE_INVALID_PERIOD`(422), `INVOICE_INVALID_DUE_DATE`(422), `INVOICE_PERIOD_OUT_OF_CONTRACT`(422), `INVOICE_PERIOD_OVERLAP`(409) |
| 5 | `PATCH /invoices/:id/status` | OPERATIONS | `ChangeInvoiceStatusDto` | `InvoiceResponse` (200) | `INVOICE_NOT_FOUND`(404), `INVOICE_STATUS_UNCHANGED`(409), `INVOICE_INVALID_STATUS_TRANSITION`(409), `INVOICE_PAYMENT_DETAILS_REQUIRED`(422), `VALIDATION_ERROR`(422) |
| 6 | `GET /sites/:siteId/invoices` | OPERATIONS, SITE_MANAGER | `ListInvoicesQueryDto` | `PaginatedResult<InvoiceResponse>` | `SITE_NOT_FOUND`(404) |

**Not:** `INVOICE_CURRENCY_MISMATCH` bu tabloda **listelenmiyor** — client
invoice `currency`'sini hiçbir zaman sağlayamadığından (Bölüm 4.3), bu hata
normal HTTP akışında **ulaşılamaz**; yalnız doğrudan-DB-yazımı senaryolarında
(Bölüm 20 integration testi) gözlemlenebilecek bir backstop'tur (Bölüm 17).
`CONCURRENT_MODIFICATION` hâlâ hiçbir yerde yok.

---

## 7. Contract state machine

| Mevcut ↓ \ Hedef → | DRAFT | ACTIVE | SUSPENDED | EXPIRED | TERMINATED |
|---|---|---|---|---|---|
| **DRAFT** | 409 UNCHANGED | ✅ `endDate≥bugün` | ❌ | ❌ | ✅ `terminationReason` zorunlu (trim) |
| **ACTIVE** | ❌ | 409 UNCHANGED | ✅ | ✅ **`endDate<bugün`** (düzeltildi) | ✅ `terminationReason` zorunlu + **non-CANCELLED invoice çakışma kontrolü (4.5)** |
| **SUSPENDED** | ❌ | ✅ `endDate≥bugün` | 409 UNCHANGED | ✅ **`endDate<bugün`** (düzeltildi) | ✅ `terminationReason` zorunlu + **non-CANCELLED invoice çakışma kontrolü (4.5)** |
| **EXPIRED** | ❌ | ❌ | ❌ | 409 UNCHANGED | ❌ (terminal) |
| **TERMINATED** | ❌ | ❌ | ❌ | ❌ | 409 UNCHANGED (terminal) |

`DRAFT→TERMINATED` hücresine invoice-çakışma kontrolü **eklenmedi** — `DRAFT`
bir contract'a hiçbir zaman invoice oluşturulamadığından (Bölüm 4.4) bu kontrol
anlamsızdır. Guard başarısızlıkları `409 CONTRACT_INVALID_STATUS_TRANSITION`;
invoice çakışması `409 CONTRACT_TERMINATION_INVOICE_CONFLICT` (ayrı bir kod,
tablo-dışı geçişle karıştırılmaz).

## 8. Invoice state machine

Değişmedi (Revize 2 ile aynı — `OVERDUE`'ya hiçbir geçiş Faz 7'de açık değil).
Bölüm 4.4/4.5'teki kurallar bu tablodan **ayrı eksenler**: biri invoice'ın
kendi durum geçişini, diğerleri invoice **oluşturmanın**/contract **fesih**
edilmesinin ön-koşullarını yönetir.

| Mevcut ↓ \ Hedef → | DRAFT | ISSUED | PAID | OVERDUE | CANCELLED |
|---|---|---|---|---|---|
| **DRAFT** | 409 UNCHANGED | ✅ | ❌ | ❌ (Faz 8) | ✅ |
| **ISSUED** | ❌ | 409 UNCHANGED | ✅ ödeme alanları zorunlu | ❌ (Faz 8) | ✅ |
| **PAID** | ❌ | ❌ | 409 UNCHANGED (terminal) | ❌ | ❌ |
| **OVERDUE** | ❌ | ❌ | ✅ (Faz 8 sonrası) | 409 UNCHANGED | ✅ (Faz 8 sonrası) |
| **CANCELLED** | ❌ | ❌ | ❌ | ❌ | 409 UNCHANGED (terminal) |

---

## 9. Authorization ve tenant izolasyonu matrisi

Değişmedi — Revize 2 Bölüm 9 ile aynı (OPERATIONS tam CRUD, SITE_MANAGER
salt-okuma kendi sitesi, RESIDENT/TECHNICIAN erişimsiz; modül sınırı
`BillingModule`→`ContractsModule` tek yönlü, yalnız `ContractLookupService`).

---

## 10. Tarih, dönem, Decimal ve para kuralları

- `Contract` aralığı kapsayıcı-kapsayıcı (`'[]'`), `ContractInvoice` aralığı
  kapsayıcı-hariç (`'[)'`) — değişmedi.
- **Düzeltildi**: fatura dönem-içi-kalma penceresi artık durum-bağımlı ve
  `TERMINATED` için `LEAST` formülü kullanıyor (Bölüm 4.4) — `ACTIVE`/`EXPIRED`
  için `[startDate, endDate+1)`, `TERMINATED` için `[startDate,
  LEAST(endDate+1, DATE(terminatedAt UTC)+1))`.
- `dueDate >= issueDate` — değişmedi.
- Para alanları (`monthlyFee`, `amount`) DTO'da doğrulanmış string,
  `Prisma.Decimal`, `.toFixed(2)` — değişmedi.
- **Düzeltildi**: `Contract.currency` hâlâ `DRAFT`'ta düzenlenebilir bir alan
  (Bölüm 4.2, değişmedi); ama **`ContractInvoice.currency` artık client
  tarafından hiçbir şekilde belirlenemez** — server, invoice oluşturma anında
  kilitli contract'ın `currency`'sini kopyalar (Bölüm 4.3). Önceki taslaktaki
  "invoice currency format kontrolü DTO'da yapılır" ifadesi, invoice'a
  uygulanmayacak şekilde düzeltildi (yalnız contract'ın kendi `currency`
  alanı için geçerlidir).
- Açık uçlu sözleşme desteklenmiyor.

---

## 11. Database constraint ve migration planı

**Yeniden doğrulanmış mevcut envanter** (Bölüm 1) — iki mevcut migration'a
**dokunulmuyor**. Üçüncü migration artık **yalnız ekleyen değil**: bir gerçek
`prisma/schema.prisma` değişikliğinin (unique kaldırma) yansıması olan bir
`DROP INDEX` + çok sayıda yeni `CREATE`/`ALTER` içeriyor.

### 11.1 Schema.prisma değişikliği
```prisma
model ContractInvoice {
  // ...
  // KALDIRILDI: @@unique([contractId, billingPeriodStart])
  @@index([contractId, status])
  @@index([status, dueDate])
  @@map("contract_invoices")
}
```
Yerine partial unique index geliyor. **Bunun schema.prisma'da mı yoksa yalnız
migration SQL'inde mi temsil edileceği artık mutlak değil, doğrulanmış bir
sürüm kararına bağlı** — bkz. 11.2 adım 0 (bu planda Seçenek B seçildi: manuel
SQL, mevcut `uq_facilities_parent_code_alive` emsaliyle aynı kategori).

### 11.2 Migration'ın hibrit yazım akışı

**0. Prisma sürümü / partial-index desteği doğrulaması (planlama sırasında
yapıldı, implementasyon başında yeniden teyit edilecek):**
- `package.json`: `prisma`/`@prisma/client` `^7.0.0`; `allowScripts` bloğu
  `prisma@7.8.0` pinliyor.
- `package-lock.json` çözümlenmiş sürüm: **her ikisi de `7.8.0`** (doğrudan
  lockfile okumasıyla teyit edildi).
- `schema.prisma` generator bloğu: `provider = "prisma-client"`, açık
  `output`; **`previewFeatures` satırı yok** (hiçbir preview feature etkin
  değil).
- Kurulu schema engine'in kendisi (`node_modules/prisma/build/
  prisma_schema_build_bg.wasm`) incelendi: motor, `where` koşullu partial
  index'i **`partialIndexes` preview feature'ı arkasında tanıyor** (birebir
  hata metni: *"Partial indexes are a preview feature. Add \"partialIndexes\"
  to previewFeatures in your generator block"*). Yani "partial index Prisma
  şemasında kesinlikle temsil edilemez" ifadesi **doğru değil** — kurulu 7.8.0
  bunu preview olarak destekliyor.

**Karar (doğrulanmış duruma göre, varsayımsız): Seçenek B — manuel SQL.**
Sürüm destekliyor (A'nın ilk şartı sağlanıyor) ama **preview feature projeye
eklenmeyecek**: (a) projede şu anda hiçbir preview feature etkin değil ve
Faz 7'nin işi toolchain politikası değiştirmek değil; (b) dört mevcut partial
unique index (`uq_facilities_parent_code_alive`, `uq_facilities_site_code_
alive`, `uq_assignments_one_current_per_ticket`, `uq_site_membership_active`
vb.) zaten yalnız custom migration SQL'inde yaşıyor — yalnız bu yeni index'i
şemaya taşımak tutarsız ikili bir kaynak yaratır; (c) preview feature'lar
tanım gereği kırıcı değişebilir. **Koşullu not:** ileride proje
`partialIndexes` preview'ını topluca etkinleştirirse Seçenek A geçerli olur —
o durumda index şemada `where` koşuluyla, `map:` argümanı
`"uq_contract_invoices_period_start_open"` olacak şekilde deklare edilir,
Prisma'nın ürettiği migration incelenir ve **aynı index elle ikinci kez
oluşturulmaz**. Her iki seçenekte de nihai DB index adı
**`uq_contract_invoices_period_start_open`**'dır ve duplicate index oluşmaz.

**Seçenek B'nin (seçilen) akışı:**
1. `prisma/schema.prisma`'dan `@@unique([contractId, billingPeriodStart])`
   satırı kaldırılır.
2. `prisma migrate dev --create-only --name contracts_billing_integrity`
   çalıştırılır — Prisma, şema farkını algılayıp `contract_invoices_contract_
   id_billing_period_start_key` için otomatik bir `DROP INDEX` migration'ı
   **üretir** (bu kısım elle yazılmaz, Prisma'nın kendi diff motoruna
   bırakılır — adlandırma/doğruluk garantisi için).
3. Üretilen (başlangıçta yalnız DROP içeren) `migration.sql` dosyası elle
   düzenlenip şu ekler yapılır: iki sequence, yeni partial unique index, üç
   CHECK, iki trigger/function (aşağıda tam SQL).
4. `prisma format` + `prisma validate` çalıştırılır — ikisi de yalnız
   **deklare edilen** şemayı kontrol eder; Seçenek B'de partial index/
   sequence/trigger'lar schema.prisma'da yer almadığından bunlar hakkında
   hiçbir şikayet üretmezler (mevcut PostgreSQL-özel nesnelerle aynı durum).
   Adım 0'daki teyit sırasında `validate`/`migrate dev` davranışının bu
   beklentiyle uyuştuğu fiilen gözlemlenerek doğrulanır.
5. **`prisma migrate diff`/drift tespiti notu**: Bu proje zaten dört adet
   (`uq_facilities_parent_code_alive`, `uq_facilities_site_code_alive`,
   `uq_assignments_one_current_per_ticket`, `ticket_code_seq`,
   `excl_contracts_active_overlap`, `excl_invoice_period_overlap`) şemada
   deklare edilmeyen PostgreSQL nesnesi barındırıyor — CI'da schema-vs-DB
   drift kontrolü varsa bu zaten kabul edilmiş bir kategoridir. Bu migration
   yalnız bu kategoriye üç nesne daha ekliyor, yeni bir risk sınıfı
   açmıyor.

### 11.3 Tam migration SQL taslağı
```sql
-- prisma/migrations/<yeni_zaman_damgasi>_contracts_billing_integrity/migration.sql
-- Faz 7: sequence'ler + invoice/contract butunluk trigger'lari + yeni CHECK'ler
-- + kosulsuz invoice-donem unique'inin partial unique'e donusturulmesi.
-- Mevcut init/custom_constraints migration'lari degistirilmez.
-- Ust kisimdaki DROP INDEX, `prisma migrate dev --create-only` ile schema.prisma
-- degisikliginden otomatik uretilmistir (bkz. plan Bolum 11.2).

-- 0) Prisma'nin uretecegi otomatik kisim (ornek):
-- DROP INDEX "contract_invoices_contract_id_billing_period_start_key";

-- 1) Sozlesme/fatura numarasi icin sequence'ler
CREATE SEQUENCE IF NOT EXISTS contract_number_seq;
CREATE SEQUENCE IF NOT EXISTS invoice_number_seq;

-- 2) Kosulsuz unique yerine CANCELLED disi partial unique (iptal+yeniden-olustur icin)
CREATE UNIQUE INDEX uq_contract_invoices_period_start_open
  ON contract_invoices(contract_id, billing_period_start)
  WHERE status <> 'CANCELLED';

-- 3) dueDate >= issueDate
ALTER TABLE contract_invoices ADD CONSTRAINT chk_invoice_due_after_issue
  CHECK (due_date >= issue_date);

-- 4) PAID/odeme alani tutarliligi
ALTER TABLE contract_invoices ADD CONSTRAINT chk_invoice_payment_consistency
  CHECK (
    (status = 'PAID' AND paid_at IS NOT NULL AND payment_method IS NOT NULL
      AND (payment_method <> 'BANK_TRANSFER'
           OR (reference_number IS NOT NULL AND btrim(reference_number) <> '')))
    OR
    (status <> 'PAID' AND paid_at IS NULL AND payment_method IS NULL
      AND reference_number IS NULL)
  );

-- 5) TERMINATED/termination alani tutarliligi
ALTER TABLE contracts ADD CONSTRAINT chk_contract_termination_consistency
  CHECK (
    (status = 'TERMINATED' AND terminated_at IS NOT NULL
      AND termination_reason IS NOT NULL AND btrim(termination_reason) <> '')
    OR
    (status <> 'TERMINATED' AND terminated_at IS NULL
      AND termination_reason IS NULL)
  );

-- 6) Invoice butunluk trigger'i: varlik + billability + donem penceresi (LEAST) + currency
CREATE OR REPLACE FUNCTION fn_invoice_period_within_contract()
RETURNS TRIGGER AS $$
DECLARE
  v_start DATE;
  v_end DATE;
  v_status "ContractStatus";
  v_terminated_at TIMESTAMPTZ;
  v_currency VARCHAR(3);
  v_window_end DATE;
BEGIN
  SELECT start_date, end_date, status, terminated_at, currency
    INTO v_start, v_end, v_status, v_terminated_at, v_currency
    FROM contracts WHERE id = NEW.contract_id
    FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'contract % not found for invoice validation', NEW.contract_id
      USING ERRCODE = 'P0001', CONSTRAINT = 'chk_invoice_contract_exists';
  END IF;

  IF v_status IN ('DRAFT', 'SUSPENDED') THEN
    RAISE EXCEPTION 'contract % is not billable in status %', NEW.contract_id, v_status
      USING ERRCODE = 'P0001', CONSTRAINT = 'chk_invoice_contract_not_billable';
  END IF;

  IF v_status = 'TERMINATED' THEN
    v_window_end := LEAST(v_end + 1, (v_terminated_at AT TIME ZONE 'UTC')::date + 1);
  ELSE
    v_window_end := v_end + 1;
  END IF;

  IF NEW.billing_period_start < v_start OR NEW.billing_period_end > v_window_end THEN
    RAISE EXCEPTION 'invoice period % - % outside billable window of contract % (% - %)',
      NEW.billing_period_start, NEW.billing_period_end, NEW.contract_id, v_start, v_window_end
      USING ERRCODE = 'P0001', CONSTRAINT = 'chk_invoice_period_within_contract';
  END IF;

  IF NEW.currency <> v_currency THEN
    RAISE EXCEPTION 'invoice currency % does not match contract % currency %',
      NEW.currency, NEW.contract_id, v_currency
      USING ERRCODE = 'P0001', CONSTRAINT = 'chk_invoice_currency_match';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_invoice_period_within_contract
  BEFORE INSERT OR UPDATE OF contract_id, billing_period_start, billing_period_end, currency
  ON contract_invoices
  FOR EACH ROW EXECUTE FUNCTION fn_invoice_period_within_contract();

-- 7) Contract termination, var olan (non-CANCELLED) faturalari gecersizlestiremez
CREATE OR REPLACE FUNCTION fn_contract_termination_invoice_conflict()
RETURNS TRIGGER AS $$
DECLARE
  v_window_end DATE;
  v_conflict_count INT;
BEGIN
  v_window_end := LEAST(NEW.end_date + 1, (NEW.terminated_at AT TIME ZONE 'UTC')::date + 1);

  SELECT count(*) INTO v_conflict_count
  FROM contract_invoices
  WHERE contract_id = NEW.id
    AND status <> 'CANCELLED'
    AND billing_period_end > v_window_end;

  IF v_conflict_count > 0 THEN
    RAISE EXCEPTION 'contract % termination conflicts with % existing invoice(s) beyond window %',
      NEW.id, v_conflict_count, v_window_end
      USING ERRCODE = 'P0001', CONSTRAINT = 'chk_contract_termination_invoice_conflict';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_contract_termination_invoice_conflict
  BEFORE UPDATE OF status, terminated_at
  ON contracts
  FOR EACH ROW
  WHEN (NEW.status = 'TERMINATED')
  EXECUTE FUNCTION fn_contract_termination_invoice_conflict();
```

**`FOR SHARE` seçimi bilinçli (`FOR KEY SHARE` değil):** PostgreSQL'de sıradan
bir `UPDATE` (contract'ın `status`/`terminated_at`/`end_date`/`currency`
kolonlarını değiştirmek dahil, key kolonlarına dokunmadığı sürece) satır
üzerinde `FOR NO KEY UPDATE` kilidi alır ve **`FOR KEY SHARE` bu kilidi bloke
etmez** — yani `FOR KEY SHARE` ile trigger, tam engellemesi gereken contract
güncellemeleriyle serbestçe yarışabilirdi. `FOR SHARE` ise hem `FOR NO KEY
UPDATE` hem `FOR UPDATE` ile çakışır: doğrudan DB invoice insert'i sırasında
trigger'ın ebeveyn okuması, eşzamanlı contract terminate/update işlemleriyle
güvenli biçimde serileşir. Salt-okuma sorgular etkilenmez; uygulamanın normal
invoice-create yolunda contract satırı zaten aynı transaction içinde `FOR
UPDATE` ile kilitli olduğundan (Bölüm 12f) trigger'ın `FOR SHARE`'i kendi
transaction'ının kilidiyle çakışmaz.

**Trigger'ların dört farklı adlandırılmış "constraint" ürettiği not edilmeli**
(`chk_invoice_contract_exists`, `chk_invoice_contract_not_billable`,
`chk_invoice_period_within_contract`, `chk_invoice_currency_match`,
`chk_contract_termination_invoice_conflict`) — her biri `.constraint` alanı
üzerinden ayrı bir domain hatasına eşlenir (Bölüm 17).

**Uygulama ön-kontrolü + DB kısıtı eşleşmesi (güncellenmiş tam tablo):**

| Kural | Uygulama ön-kontrolü | DB kısıtı (nihai güvence) |
|---|---|---|
| `endDate > startDate` | evet | `chk_contract_dates` (mevcut) |
| `billingDay` 1-28 | DTO | `chk_contract_billing_day` (mevcut) |
| Para ≥ 0 | DTO regex | `chk_contract_fee_nonneg`/`chk_invoice_amount_nonneg` (mevcut) |
| Aynı sitede çakışan ACTIVE/SUSPENDED sözleşme | evet | `excl_contracts_active_overlap` (mevcut, 23P01) |
| `billingPeriodEnd > billingPeriodStart` | evet | `chk_invoice_period` (mevcut) |
| Aynı dönem — non-CANCELLED çakışması | evet | **`uq_contract_invoices_period_start_open` (yeni, koşulsuz unique'in yerine)** |
| CANCELLED sonrası aynı dönem yeniden kullanılabilir | — | partial index + `excl_invoice_period_overlap` (`WHERE status<>'CANCELLED'`) ikisi de bunu destekler |
| Çakışan fatura dönemi | evet | `excl_invoice_period_overlap` (mevcut, 23P01) |
| `dueDate >= issueDate` | evet | `chk_invoice_due_after_issue` (yeni) |
| Fatura dönemi durum-bağımlı `LEAST` pencere içinde | evet (Bölüm 4.4) | `trg_invoice_period_within_contract` (yeni, genişletilmiş, P0001) |
| Fatura currency = contract currency | — (client hiç sağlayamıyor) | `trg_invoice_period_within_contract` içindeki currency kontrolü (yeni, P0001) |
| PAID/ödeme alanı tutarlılığı | evet (Bölüm 4.5→4.8... bkz 4.8) | `chk_invoice_payment_consistency` (yeni) |
| TERMINATED/termination alanı tutarlılığı | evet | `chk_contract_termination_consistency` (yeni) |
| **Termination, non-CANCELLED invoice'ları aşmasın** | evet (Bölüm 4.5) | **`trg_contract_termination_invoice_conflict` (yeni, P0001)** |

---

## 12. Transaction ve concurrency planı

Temel ilke değişmedi: saf `FOR UPDATE`, version kolonu yok, status-as-CAS yok,
`CONCURRENT_MODIFICATION` Contract/Invoice'ta ulaşılamaz (bkz. Revize 2
Bölüm 4.9/12, aynen geçerli).

**(a)–(d)** — contract create, aynı-satır PATCH yarışı, farklı-satır PATCH
yarışı, `endDate` uzatma — **değişmedi** (Revize 2 Bölüm 12).

**(e) Birleşik `PATCH /contracts/:id` — güncellenmiş tam işlem sırası**
(EXPIRED guard'ı ve yeni termination-invoice-conflict adımı dahil):
1. `contractRepo.findByIdForUpdate(tx, id)` — kilit; yoksa `404
   CONTRACT_NOT_FOUND`.
2. Boş body → `422 CONTRACT_UPDATE_EMPTY`.
3. Mevcut duruma göre mutable-field kontrolü → `422 CONTRACT_IMMUTABLE_FIELD`.
4. Final state kurulumu; `targetStatus = dto.status ?? currentRow.status`.
5. Final tarih doğrulaması → `422 CONTRACT_INVALID_DATE_RANGE`.
6. **Yalnız `dto.status` sağlanmışsa** state machine: aynı durum →
   `409 CONTRACT_STATUS_UNCHANGED`; tablo-dışı → `409
   CONTRACT_INVALID_STATUS_TRANSITION`; guard'lar final değerler üzerinden
   (→ACTIVE: final `endDate`≥bugün; **→EXPIRED: final `endDate`<bugün, katı**;
   →TERMINATED: final `terminationReason` dolu&trim).
7. **(Yeni)** `targetStatus === TERMINATED` ise: `effectiveTerminationWindowEnd
   = LEAST(currentRow.endDate+1, DATE(now())+1)` hesaplanır; bu contract'a ait
   `status<>'CANCELLED'` invoice'lar arasında `billingPeriodEnd >
   effectiveTerminationWindowEnd` olan var mı diye sorgulanır (contract satırı
   zaten kilitli olduğundan, eşzamanlı bir invoice-create denemesi — o da aynı
   contract satırını `FOR UPDATE` ile kilitlemeye çalışacağından — bu
   transaction bitene kadar bloke olur, bu yüzden bu sorgu sırasında yeni bir
   invoice belirmesi mümkün değildir). Çakışma varsa → `409
   CONTRACT_TERMINATION_INVOICE_CONFLICT`. *(Not: eşzamanlı bir invoice-status
   PATCH'i — Bölüm 12g — contract satırını kilitlemediğinden, bir çakışan
   invoice tam bu kontrol sırasında ayrı bir transaction'da `CANCELLED`
   yapılıyor olabilir; bu durumda en kötü ihtimalle **güvenli bir
   fazla-red** oluşur (asla güvensiz bir kabul değil) — kullanıcı işlemi
   tekrar dener.)*
8. `targetStatus ∈ {ACTIVE, SUSPENDED}` ise overlap ön-kontrolü → `409
   CONTRACT_OVERLAP`.
9. Tek `tx.contract.update(...)`.
10. 23P01 (`excl_contracts_active_overlap`) → `409 CONTRACT_OVERLAP`; **yeni**
    `trg_contract_termination_invoice_conflict`'in P0001'i (adım 7'nin
    kaçırdığı bir yarışın DB backstop'u) → `409
    CONTRACT_TERMINATION_INVOICE_CONFLICT`.
11. Audit + outbox, aynı transaction.

**(f) Invoice create — güncellenmiş**: `ContractLookupService.
findByIdForUpdate(tx, contractId)` ile ebeveyn kilitlenir. Kilit altında:
Bölüm 4.4 matrisi (`DRAFT`/`SUSPENDED` → `INVOICE_CONTRACT_NOT_BILLABLE`),
`billingPeriodEnd>Start` (`INVOICE_INVALID_PERIOD`), `dueDate>=issueDate`
(`INVOICE_INVALID_DUE_DATE`), **`LEAST` formülüyle durum-bağımlı pencere**
(`INVOICE_PERIOD_OUT_OF_CONTRACT`); **`currency` DTO'dan gelmez, kilitli
contract'ın `currency`'sinden kopyalanır** (Bölüm 4.3); `invoiceNumber`
üretimi + insert; P2002 (**artık partial unique** `uq_contract_invoices_
period_start_open`) ve 23P01 (`excl_invoice_period_overlap`) →
`INVOICE_PERIOD_OVERLAP`; trigger'ın P0001'i (herhangi bir alt-kural, defense-
in-depth) → ilgili koda eşlenir (Bölüm 17).

**(g) Invoice status PATCH** — değişmedi (Revize 2 Bölüm 12g).

**Genişletilmiş spike testi**: artık **altı** hata şeklinin doğrulanması
gerekiyor — 23P01 (iki EXCLUDE), üç CHECK, ve **beş farklı adlandırılmış**
trigger-raised P0001 (`chk_invoice_contract_exists`, `chk_invoice_contract_
not_billable`, `chk_invoice_period_within_contract`, `chk_invoice_currency_
match`, `chk_contract_termination_invoice_conflict`) + partial-unique P2002.
Servis catch-block'ları bunlar doğrulanmadan yazılmamalı.

**Paylaşılan pencere hesaplama yardımcısı (öneri)**: `LEAST(...)` formülünün
hem `InvoiceService.create` (Bölüm 12f) hem `ContractService`'in termination
ön-kontrolünde (Bölüm 12e adım 7) **iki ayrı yerde elle tekrar edilip
birbirinden sapması riskini önlemek için**, tek bir paylaşılan saf fonksiyon
öneriliyor (`computeEffectiveBillableWindowEnd(contract): Date`,
`sla.util.ts`'in `computeSlaTargetAt` deseniyle aynı stil) — her iki servis de
bu tek fonksiyonu çağırır, formül iki yerde ayrı ayrı yazılmaz.

---

## 13. Modül ve dependency tasarımı

Değişmedi — Revize 2 Bölüm 13 (iki ayrı modül, `BillingModule→ContractsModule`
tek yönlü, `ContractLookupService` tek export, `forwardRef` yok,
`findByIdForUpdate` ile repository sızdırılmadan kilit sağlanıyor).

## 14. Eklenecek service/repository/policy/mapper/DTO yapısı

Dosya yapısı değişmedi (Revize 2 Bölüm 14) — yalnız DTO içerikleri netleşti:

- **`CreateInvoiceDto`** alanları: `billingPeriodStart`, `billingPeriodEnd`,
  `issueDate`, `dueDate`, `amount` (string decimal), `note` (opsiyonel).
  **`currency` bu DTO'da yok** — server, kilitli contract'tan kopyalar
  (Bölüm 4.3/12f).
- **`ChangeInvoiceStatusDto`**: `status`, `paymentMethod?`,
  `referenceNumber?` — yalnız `status==='PAID'` iken kabul edilir (Bölüm 4.5
  — Revize 2), aksi halde 422. `paidAt` hiç yok.
- Yeni paylaşılan yardımcı: `src/modules/contracts/utils/billable-window.util.ts`
  (veya benzeri) — `computeEffectiveBillableWindowEnd` (Bölüm 12).

## 15. Mevcut ContractQueryService ile uyumluluk

Değişmedi — Revize 2 Bölüm 15 (silinip `ContractLookupService`'e taşınıyor,
`TICKET_SITE_CONTRACT_INACTIVE` davranışı birebir korunuyor).

---

## 16. Audit ve outbox tasarımı

Değişmedi (Revize 2 Bölüm 16) — audit action'lar ve outbox event'ler aynı.
`CONTRACT_TERMINATED` audit metadata'sına artık invoice-çakışma kontrolünün
geçtiği bilgisi eklenmez (gerek yok, kontrol zaten geçmemiş olsaydı işlem hiç
commit olmazdı — yalnız transition-özel alanlar metadata'da kalır).

## 17. Error code ve HTTP status eşlemesi

```ts
// Faz 7 (Contracts)
CONTRACT_NOT_FOUND: 'CONTRACT_NOT_FOUND',                               // 404
CONTRACT_INVALID_DATE_RANGE: 'CONTRACT_INVALID_DATE_RANGE',             // 422
CONTRACT_OVERLAP: 'CONTRACT_OVERLAP',                                   // 409
CONTRACT_INVALID_STATUS_TRANSITION: 'CONTRACT_INVALID_STATUS_TRANSITION', // 409
CONTRACT_STATUS_UNCHANGED: 'CONTRACT_STATUS_UNCHANGED',                 // 409
CONTRACT_IMMUTABLE_FIELD: 'CONTRACT_IMMUTABLE_FIELD',                   // 422
CONTRACT_UPDATE_EMPTY: 'CONTRACT_UPDATE_EMPTY',                         // 422
CONTRACT_TERMINATION_DETAILS_REQUIRED: 'CONTRACT_TERMINATION_DETAILS_REQUIRED', // 422 (backstop)
CONTRACT_TERMINATION_INVOICE_CONFLICT: 'CONTRACT_TERMINATION_INVOICE_CONFLICT', // 409 (yeni)

// Faz 7 (Billing)
INVOICE_NOT_FOUND: 'INVOICE_NOT_FOUND',                                 // 404
INVOICE_CONTRACT_NOT_BILLABLE: 'INVOICE_CONTRACT_NOT_BILLABLE',         // 422
INVOICE_INVALID_PERIOD: 'INVOICE_INVALID_PERIOD',                       // 422
INVOICE_INVALID_DUE_DATE: 'INVOICE_INVALID_DUE_DATE',                   // 422
INVOICE_PERIOD_OUT_OF_CONTRACT: 'INVOICE_PERIOD_OUT_OF_CONTRACT',       // 422
INVOICE_PERIOD_OVERLAP: 'INVOICE_PERIOD_OVERLAP',                       // 409
INVOICE_CURRENCY_MISMATCH: 'INVOICE_CURRENCY_MISMATCH',                 // 422 (yeni, DB-backstop-only)
INVOICE_INVALID_STATUS_TRANSITION: 'INVOICE_INVALID_STATUS_TRANSITION', // 409
INVOICE_STATUS_UNCHANGED: 'INVOICE_STATUS_UNCHANGED',                   // 409
INVOICE_PAYMENT_DETAILS_REQUIRED: 'INVOICE_PAYMENT_DETAILS_REQUIRED',   // 422
```

**Trigger-raised isim → domain kod eşlemesi**: `chk_invoice_contract_exists`
→ `CONTRACT_NOT_FOUND`; `chk_invoice_contract_not_billable` →
`INVOICE_CONTRACT_NOT_BILLABLE`; `chk_invoice_period_within_contract` →
`INVOICE_PERIOD_OUT_OF_CONTRACT`; `chk_invoice_currency_match` →
`INVOICE_CURRENCY_MISMATCH`; `chk_contract_termination_invoice_conflict` →
`CONTRACT_TERMINATION_INVOICE_CONFLICT`. `chk_invoice_payment_consistency`/
`chk_contract_termination_consistency` ihlalleri (normalde ulaşılamaz
backstop'lar) sırasıyla `INVOICE_PAYMENT_DETAILS_REQUIRED`/`CONTRACT_
TERMINATION_DETAILS_REQUIRED`'a eşlenir. `CONCURRENT_MODIFICATION` hâlâ
tamamen dışarıda.

## 18. Response mapper ve internal alanların gizlenmesi

Değişmedi (Revize 2 Bölüm 18) — `InvoiceResponse`'un `currency` alanı artık
her zaman contract'tan kopyalanan değeri yansıtır (client girdisi asla değil).

---

## 19. Unit test planı

- `contract-state-machine.spec.ts`: **düzeltilmiş** `endDate<bugün` (katı)
  guard'ı — `endDate===bugün` → `EXPIRED` reddi; `endDate=dün` → başarı.
- `contract.service.spec.ts`: EXPIRED katı sınır (yukarıdaki gibi); **yeni**
  termination-invoice-conflict testi (mock `ContractInvoice` lookup çakışan
  bir kayıt döndürürse → `CONTRACT_TERMINATION_INVOICE_CONFLICT`; çakışma
  yoksa başarı; `PAID` bir invoice çakışıyorsa da reddedilir); geri kalanı
  Revize 2 ile aynı.
- **`billable-window.util.spec.ts` (yeni)**: `computeEffectiveBillableWindowEnd`
  saf fonksiyonu için sınır testleri — `terminatedAt < endDate`,
  `terminatedAt > endDate` (LEAST endDate'i seçmeli), `terminatedAt ===
  endDate`.
- `invoice.service.spec.ts`: Bölüm 4.4 beş-durumlu matrisi (LEAST formülü
  dahil, `terminatedAt>endDate` sınır senaryosu dahil); `dueDate<issueDate`;
  ödeme-alanı-DTO-kuralı; **`currency` server-copy** (DTO'da `currency` alanı
  yok; insert payload'ının `currency`'sinin kilitli contract'tan geldiği
  doğrulanır, hiçbir client girdisi kullanılmadığı test edilir); **cancel+
  recreate** (bir `CANCELLED` invoice varken aynı dönem için yeni oluşturmanın
  serviste hiçbir yapay engelle karşılaşmadığı — yalnız DB partial index'in
  yönettiği — doğrulanır).
- `prisma-error.util.spec.ts`: altı hata şekli için negatif testler (Revize
  2'deki üçe ek olarak trigger'ın beş farklı isimlendirilmiş çeşidi ve yeni
  partial-unique P2002 ayrımı).

## 20. Gerçek PostgreSQL integration test planı

- **`constraint-violation-shapes.integration-spec.ts`** (genişletildi, ilk
  yazılacak dosya): artık **altı** hata şeklinin tamamı — iki EXCLUDE (23P01),
  üç CHECK, beş farklı trigger-raised isim + yeni partial-unique P2002.
- `contract-lifecycle.integration-spec.ts`: **EXPIRED katı sınır** ile
  güncellendi (`endDate=bugün` → 409; `endDate=dün` → 200).
- **`contract-termination-invoice-conflict.integration-spec.ts` (yeni)**:
  contract aktive edilir, `endDate`'e kadar bir invoice oluşturulur; bu
  invoice'ın `billingPeriodEnd`'i, önerilen `terminatedAt`'in penceresini
  aşacak şekilde `terminate` denenir → `409`; invoice `CANCELLED` yapılır →
  `terminate` tekrar denenir → başarı; ayrıca **`PAID`** bir invoice çakışması
  senaryosu (fesih yine reddedilir, `PAID` iptal edilemeyeceği için kalıcı bir
  blok — bu, testte açıkça "kabul edilen sınırlama" olarak yorumlanır).
- **`invoice-cancel-recreate.integration-spec.ts` (yeni)**: `DRAFT` invoice
  `CANCELLED` yapılır; aynı contract + aynı `billingPeriodStart` ile yeni
  invoice oluşturulur → başarı; iki **non-CANCELLED** invoice aynı dönem
  başlangıcıyla oluşturulamaz → `409`; **doğrudan DB partial unique testi**
  (`$executeRaw` ile app katmanını atlayıp yalnız `uq_contract_invoices_
  period_start_open`'ın davranışını doğrulama).
- **`invoice-currency.integration-spec.ts` (yeni)**: normal akışta invoice
  currency'sinin contract'tan geldiği (app testi); **doğrudan DB testi** —
  `$executeRaw` ile app katmanını atlayıp uyumsuz bir `currency` insert
  edilmeye çalışılır → trigger reddeder, `.constraint ===
  'chk_invoice_currency_match'` doğrulanır.
- **`invoice-contract-status.integration-spec.ts`**: Bölüm 4.4 matrisi +
  **`LEAST` formülünün her iki dalı** (`terminatedAt<endDate` ve
  `terminatedAt>endDate` senaryoları, gerçek DB'ye karşı).
- **`invoice-billability-trigger.integration-spec.ts` (yeni)**: genişletilmiş
  trigger'ın doğrudan DB testleri — `DRAFT`/`SUSPENDED` contract'a raw insert
  → `chk_invoice_contract_not_billable`; var olmayan `contract_id` → `chk_
  invoice_contract_exists`; dönem dışı → `chk_invoice_period_within_contract`.
  Ayrıca **`FOR SHARE` kilidinin iki gerçek concurrency senaryosu** (iki ayrı
  DB bağlantısı/transaction ile):
  - **Senaryo A**: Tx1 doğrudan (raw) invoice insert yapar ve trigger, parent
    contract satırında `FOR SHARE` alır; Tx1 açık tutulurken Tx2 aynı
    contract'ı terminate/update etmeye çalışır → Tx2 **beklemeli** ve Tx1
    commit edildikten sonra tutarlı sonucu üretmelidir (güncelleme başarısı
    veya — Tx1'in insert ettiği invoice pencereyi aşıyorsa —
    `trg_contract_termination_invoice_conflict` reddi).
  - **Senaryo B**: Tx1 contract terminate/update için `FOR UPDATE`/UPDATE
    kilidini alır ve açık tutar; Tx2 doğrudan invoice insert dener → trigger'ın
    `FOR SHARE` okuması **beklemeli** ve Tx1 commit sonrası Tx2, contract'ın
    **güncel** durumuna göre trigger tarafından kabul veya
    (`chk_invoice_contract_not_billable`/`chk_invoice_period_within_contract`
    ile) reddedilmelidir.
  - **Determinizm tekniği**: bekleyen transaction'ın gerçekten bloke olduğu,
    zaman tahminli `sleep`'lerle değil, `pg_locks`/`pg_stat_activity` üzerinden
    (`granted = false` / `wait_event_type = 'Lock'`) sınırlı-poll ile
    gözlemlenir; ancak bu gözlem doğrulandıktan sonra Tx1 commit edilir ve
    Tx2'nin sonucu assert edilir. `lock_timeout` kullanılacaksa yalnız
    testin kendi bağlantısında, sabit ve kontrollü bir değerle set edilir —
    kırılgan süre-tabanlı beklentiler kurulmaz.
- `dueDate`/PAID/TERMINATED CHECK doğrudan DB testleri — değişmedi.
- Modül sınırı + TicketsModule regresyonu + audit/outbox atomikliği —
  değişmedi (Revize 2 Bölüm 20).

## 21. Gerçek HTTP E2E test planı

- **Yeni**: `endDate===bugün` iken `EXPIRED` denemesi → `409
  CONTRACT_INVALID_STATUS_TRANSITION`; `endDate` dünse → `200`.
- **Yeni**: gelecek dönemi kapsayan bir invoice varken `terminate` denemesi →
  `409 CONTRACT_TERMINATION_INVOICE_CONFLICT`; invoice `CANCELLED` yapıldıktan
  sonra `terminate` → `200`.
- **Yeni**: bir invoice `CANCELLED` yapıldıktan sonra aynı dönem için HTTP
  üzerinden yeniden oluşturma → `201`.
- **Yeni**: `POST /contracts/:id/invoices` yanıtındaki `currency`'nin
  contract'ın `currency`'siyle eşleştiğinin doğrulanması (mutlu yol). İstek
  gövdesine bilinmeyen `currency` alanı eklenirse beklenen sonuç **kesindir:
  `422 VALIDATION_ERROR`** — doğrulanmış mevcut global `ValidationPipe` ayarı
  (`src/main.ts` satır 29-34): `whitelist: true`, **`forbidNonWhitelisted:
  true`**, `transform: true`, `errorHttpStatusCode: 422`; E2E kurulumları da
  aynı pipe konfigürasyonunu birebir kopyalıyor (mevcut
  `tenant-isolation.e2e-spec.ts` emsali). Bu ayar **değiştirilmeyecek**;
  "sessizce yok sayılır" olasılığı `forbidNonWhitelisted: true` nedeniyle
  geçerli değildir ve plandan çıkarılmıştır.
- Geri kalan senaryolar (tenant izolasyonu, overlap, dueDate, ödeme alanları,
  pagination, IDOR) — değişmedi (Revize 2 Bölüm 21).

## 22. Faz 1–6 regresyon planı

Değişmedi (Revize 2 Bölüm 22) — `contract-query.service.ts` taşınmasının
ticket davranışını bozmadığının doğrulanması hâlâ merkezi risk.

---

## 23. Oluşturulacak/değiştirilecek/silinecek tahmini dosya listesi

**Yeni (Revize 2'ye ek):**
- `src/modules/contracts/utils/billable-window.util.ts` (+ `.spec.ts`)
- `test/integration/contracts/contract-termination-invoice-conflict.integration-spec.ts`
- `test/integration/billing/invoice-cancel-recreate.integration-spec.ts`
- `test/integration/billing/invoice-currency.integration-spec.ts`
- `test/integration/billing/invoice-billability-trigger.integration-spec.ts`

**Değiştirilecek (Revize 2 listesine ek):**
- **`prisma/schema.prisma`** — `ContractInvoice.@@unique([contractId,
  billingPeriodStart])` satırı kaldırılır (Faz 7'nin şemaya dokunan tek
  değişikliği).
- `src/modules/contracts/dto/update-contract.dto.ts` — termination-invoice-
  conflict kontrolü servis katmanında, DTO'da ek alan gerekmez.
- `src/modules/billing/dto/create-invoice.dto.ts` — `currency` alanı yok.

Geri kalan dosya listesi Revize 2 Bölüm 23 ile aynı.

## 24. Uygulama sırası

1. Bölüm 11.2 adım 0'daki sürüm/previewFeatures doğrulaması implementasyon
   başında yeniden teyit edilir (Seçenek B kararı geçerli mi); ardından
   `prisma/schema.prisma`'dan `@@unique` kaldırılır; `prisma migrate dev
   --create-only` ile otomatik DROP INDEX üretilir.
2. Üretilen migration dosyası elle genişletilir: iki sequence, partial unique
   index, üç CHECK, iki trigger/function (Bölüm 11.3); `prisma format`/
   `validate`.
3. **Genişletilmiş spike testi** (altı hata şekli) — servis kodu yazılmadan
   önce.
4. `error-codes.constant.ts`, `domain-audit-actions.constant.ts` genişletilir.
5. `billable-window.util.ts` (paylaşılan LEAST fonksiyonu) + unit testi.
6. `ContractsModule`: state machine → repository → `ContractLookupService`
   (taşınan davranış dahil) → `ContractService` (termination-invoice-conflict
   kontrolü dahil) → DTO/mapper/controller.
7. `TicketsModule` güncellemesi + ticket regresyon testleri.
8. `BillingModule`: state machine → repository → `InvoiceService` (currency
   server-copy, LEAST formülü, cancel+recreate uyumluluğu) → DTO/mapper/
   controller.
9. `app.module.ts`'ye modüller eklenir.
10. Integration testleri (Bölüm 20, yeni dört dosya dahil).
11. E2E testleri (Bölüm 21).
12. Faz 1–6 regresyon paketi.
13. Son doğrulama komutları (Bölüm 25).

## 25. Son doğrulama komutları

```
npm install
npm run lint
npm run build
npm run prisma:format
npm run prisma:validate
docker compose config
npm test
npm run test:integration
npm run test:e2e
```

## 26. Riskler ve çözüm önerileri

| Risk | Çözüm |
|---|---|
| Migration artık salt-ekleyen değil; `prisma migrate dev --create-only`'nin ürettiği DROP INDEX'in beklenenle birebir eşleşmediği bir senaryo | Adım, elle yazılan SQL'den önce ayrı bir commit/inceleme noktası olarak ele alınır; üretilen dosya diff'i implementasyon sırasında gözden geçirilir |
| Termination-invoice-conflict kontrolünün, eşzamanlı bir invoice-cancel işlemiyle yarışması | Bilinçli kabul edilen "güvenli fazla-red" — asla güvensiz kabul değil; kullanıcı işlemi tekrar dener (Bölüm 12e) |
| `INVOICE_CURRENCY_MISMATCH`'in normal HTTP akışında hiç tetiklenmemesi, kod yolunun test edilmeden kalma riski | Doğrudan DB integration testiyle özel olarak doğrulanır (Bölüm 20) |
| `LEAST` formülünün iki ayrı serviste (Contract/Invoice) birbirinden sapma riski | Paylaşılan `computeEffectiveBillableWindowEnd` yardımcı fonksiyonu (Bölüm 12/14), tek yerde test edilir |
| Beş farklı trigger-raised isim + iki CHECK + iki EXCLUDE'un gerçek Prisma 7 hata şekli belirsizliği | Genişletilmiş spike testi (Bölüm 12/20), servis kodu öncesi zorunlu ilk adım |
| `PAID` bir invoice'ın contract terminasyonunu kalıcı olarak bloke edebilmesi | Faz 7'nin bilinçli kapsam sınırı (refund/düzeltme sistemi yok) — Bölüm 3/4.5'te açıkça belgelendi, Faz 8+ için olası bir genişletme noktası |

---

## Revize 4 değişiklik özeti

Revize 3 onaylandıktan sonra yalnız üç teknik düzeltme işlendi; hiçbir iş
kuralı değişmedi:

1. **`FOR KEY SHARE` → `FOR SHARE`** (Bölüm 2, 4.7, 11.3): `FOR KEY SHARE`,
   sıradan UPDATE'in aldığı `FOR NO KEY UPDATE` kilidini bloke etmediğinden
   contract güncellemeleriyle doğrudan-DB invoice insert yarışını
   serileştiremezdi; trigger'ın ebeveyn okuması `FOR SHARE` yapıldı, yanlış
   gerekçe paragrafı düzeltildi ve Bölüm 20'ye iki deterministik (sleep'siz,
   `pg_locks` gözlemli) concurrency senaryosu (A: insert-önce/update-bekler,
   B: update-önce/insert-bekler) eklendi.
2. **Partial unique index — sürüm kararı varsayımsız kesinleştirildi**
   (Bölüm 11.1/11.2/24): kurulu sürüm lockfile'dan `prisma@7.8.0` /
   `@prisma/client@7.8.0` olarak, generator'da hiçbir `previewFeatures`
   olmadığı ve kurulu schema engine'in partial index'i `partialIndexes`
   preview feature'ı arkasında desteklediği fiilen doğrulandı. "Şemada
   kesinlikle temsil edilemez" mutlak ifadeleri koşullu hale getirildi.
   Karar: **Seçenek B** (manuel SQL; preview feature etkinleştirilmeyecek,
   mevcut dört partial index emsaliyle tutarlı), Seçenek A koşulu ve her iki
   durumda tek `uq_contract_invoices_period_start_open` index'i (duplicate
   yasak) açıkça belgelendi.
3. **Bilinmeyen `currency` alanının HTTP davranışı kesinleştirildi**
   (Bölüm 21): `src/main.ts` global `ValidationPipe`'ı doğrulandı
   (`whitelist: true`, `forbidNonWhitelisted: true`, `transform: true`,
   422) — beklenti artık tek: **`422 VALIDATION_ERROR`**; "sessizce yok
   sayılır" olasılığı plandan çıkarıldı, pipe ayarı değiştirilmiyor.

**Ready for implementation**

# Operasyon Runbook'u

Bu belge, Site Teknik Destek Sistemi backend'inin production ortamındaki
gözlemlenebilirlik, bakım, yedekleme ve olay müdahale prosedürlerini
tanımlar. Yeni bir monitoring platformu (Prometheus, Grafana, Sentry, ELK)
gerektirmez; yalnızca mevcut yüzeyleri kullanır: yapılandırılmış JSON log
(pino), request-id, health endpointleri, audit log ve outbox/notification
tabloları.

## 1. Sağlık kontrolleri

| Endpoint | Amaç | Beklenen |
| --- | --- | --- |
| `GET /api/v1/health/liveness` | Sürecin ayakta olduğu | `200 { "status": "ok" }` |
| `GET /api/v1/health/readiness` | DB erişilebilirliği (`SELECT 1`) | `200 { "status": "ok", "database": "ok" }`; DB yoksa `503` |

- Production Docker imajındaki `HEALTHCHECK`, liveness endpoint'ini kullanır.
- Liveness başarısızsa container restart edilmelidir; readiness başarısızsa
  önce veritabanı bağlantısı incelenmelidir (bkz. bölüm 6).

## 2. Log okuma ve request korelasyonu

- Loglar stdout'a JSON olarak yazılır (`nestjs-pino`). Log seviyesi
  `LOG_LEVEL` ile belirlenir; production önerisi `info`.
- Her isteğe bir request-id atanır: istemci `x-request-id` header'ı
  gönderirse o değer kullanılır, yoksa UUID üretilir.
- Hata yanıtındaki `error.requestId` alanı ile loglardaki `req.id` alanı
  aynıdır; bir kullanıcı hatası bildirdiğinde bu id ile korelasyon yapılır.
- Redaction: `authorization`, `cookie`, `body.otp`, `body.code`,
  `body.password`, `body.refreshToken` alanları loglarda `[REDACTED]`
  görünür. OTP kodu ve ham token'lar hiçbir seviyede loglanmaz; bu davranış
  değiştirilmemelidir.

## 3. Outbox / bildirim hattı izleme

Relay'ler API prosesinde çalışır (`OUTBOX_RELAY_ENABLED=true` iken).
Kuyruk durumları SQL ile izlenir.

### 3.1 FAILED outbox olayları

```sql
SELECT id, event_type, aggregate_type, aggregate_id,
       attempt_count, failed_at, last_error
FROM outbox_events
WHERE status = 'FAILED'
ORDER BY failed_at DESC
LIMIT 50;
```

Yeniden kuyruğa alma (kök neden giderildikten sonra):

```sql
UPDATE outbox_events
SET status = 'PENDING',
    next_attempt_at = now(),
    attempt_count = 0,
    failed_at = NULL,
    last_error = NULL
WHERE id = '<event-id>';
```

Not: `attempt_count` sıfırlanmazsa olay, `OUTBOX_MAX_ATTEMPTS` eşiğine
önceki denemeler sayılarak çok hızlı yeniden FAILED olur. Toplu yeniden
kuyruğa almadan önce `last_error` değerlerinin aynı kök nedene işaret
ettiğinden emin olun.

### 3.2 FAILED notification delivery kayıtları

```sql
SELECT id, source_event_id, recipient_phone, channel,
       attempt_count, failed_at, last_error
FROM notification_deliveries
WHERE status = 'FAILED'
ORDER BY failed_at DESC
LIMIT 50;
```

Yeniden kuyruğa alma aynı desenle yapılır (`status='PENDING'`,
`next_attempt_at=now()`, `attempt_count=0`, `failed_at=NULL`,
`last_error=NULL`). Delivery gönderimi **at-least-once**'tır: yeniden
kuyruğa alınan bir kayıt için SMS'in daha önce fiilen gitmiş olma
ihtimali göz önünde bulundurulmalıdır.

### 3.3 Backlog / lag kontrolü

```sql
-- Bekleyen olayların yaş dağılımı; relay sağlıklıysa max_age birkaç
-- polling aralığını (OUTBOX_RELAY_POLL_INTERVAL_MS) geçmemelidir.
SELECT status, count(*) AS adet,
       min(created_at) AS en_eski, now() - min(created_at) AS max_age
FROM outbox_events
GROUP BY status;

SELECT status, count(*) AS adet,
       min(created_at) AS en_eski, now() - min(created_at) AS max_age
FROM notification_deliveries
GROUP BY status;
```

Backlog büyüyorsa sırasıyla kontrol edin:

1. `OUTBOX_RELAY_ENABLED` gerçekten `true` mu (config, container env)?
2. Uygulama logunda relay hata satırları var mı (`outbox-relay`,
   `notification-delivery-relay` bağlamları)?
3. SMS sağlayıcısı (mock dışı bir sağlayıcı devredeyse) hata mı dönüyor?
4. `PROCESSING` durumunda takılı kayıt var mı? Lease süresi
   (`OUTBOX_CLAIM_LEASE_MS`) dolunca kayıt otomatik yeniden claim edilir;
   lease süresinden uzun süredir `PROCESSING` görünen kayıt yoksa müdahale
   gerekmez.

## 4. Zamanlanmış job'lar

- `contract-expiring-scan` ve `invoice-overdue-scan` her gün 02:00 UTC'de
  çalışır; kill-switch `BACKGROUND_JOBS_ENABLED`.
- Doğrulama sorguları:

```sql
-- Sona ermesine CONTRACT_EXPIRY_LEAD_DAYS kalan ve henüz bildirilmemiş
-- aktif sözleşmeler (job'ın bir sonraki koşuda işleyeceği adaylar):
SELECT id, contract_number, end_date, expiry_notified_at
FROM contracts
WHERE status = 'ACTIVE'
  AND end_date <= (CURRENT_DATE + INTERVAL '30 days')
  AND expiry_notified_at IS NULL;

-- Vadesi geçmiş ancak hala ISSUED görünen faturalar (job işlemeli):
SELECT id, invoice_number, due_date, status
FROM contract_invoices
WHERE status = 'ISSUED' AND due_date < CURRENT_DATE;
```

Job koştuğu halde adaylar işlenmiyorsa uygulama logunda job bağlamındaki
hata satırlarına bakın; job'lar aday başına try/catch kullanır, tek kaydın
hatası diğerlerini durdurmaz.

## 5. Audit log

- `audit_logs` append-only'dir; FK taşımaz. Sorgular `entity_type` +
  `entity_id` veya `actor_user_id` üzerinden yapılır:

```sql
SELECT created_at, action, actor_user_id, entity_type, entity_id, metadata
FROM audit_logs
WHERE entity_type = 'Ticket' AND entity_id = '<ticket-id>'
ORDER BY created_at DESC;
```

- Güvenlik olayları için önemli action'lar: başarısız OTP denemeleri,
  refresh token reuse tespiti (tüm oturumların revoke edildiği kayıt),
  kullanıcı deaktivasyonu.

## 6. Veritabanı ve disk

- Bağlantı kontrolü: `pg_isready -h <host> -U app -d site_support` veya
  readiness endpoint'i.
- Aktif bağlantı sayısı: `SELECT count(*) FROM pg_stat_activity;`
- Disk: `var/uploads` (attachment depolama) düzenli izlenmelidir;
  `du -sh var/uploads`. Dolan disk hem upload'ları hem PostgreSQL'i
  etkiler. Eşik önerisi: %80 doluluk uyarı, %90 müdahale.
- `var/uploads/tmp` altında bekleyen geçici dosyalar birikiyorsa (upload
  cleanup interceptor'ının temizleyemediği durumlar), uygulama kapalıyken
  1 günden eski `tmp` dosyaları silinebilir.

## 7. Log rotation

Uygulama loga dosya yazmaz; stdout/stderr container runtime tarafından
toplanır. Docker için öneri:

```yaml
# compose (production) servis tanımında
logging:
  driver: json-file
  options:
    max-size: "50m"
    max-file: "5"
```

Harici bir log toplayıcı (journald, CloudWatch vb.) kullanılıyorsa rotation
o katmanda yapılır.

## 8. Yedekleme ve geri yükleme

### 8.1 Yedek alma

```bash
pg_dump --format=custom --no-owner \
  --file=site_support_$(date +%Y%m%d_%H%M).dump \
  "$DATABASE_URL"
```

- Öneri: günde en az bir tam yedek + yedeklerin farklı bir makinede/ortamda
  saklanması. `var/uploads` içeriği de aynı sıklıkla ayrıca yedeklenmelidir
  (DB yedeği dosya içeriklerini içermez).

### 8.2 Geri yükleme testi (düzenli tatbikat)

1. Boş bir PostgreSQL 16 instance'ı açın (örn.
   `docker run -d -e POSTGRES_PASSWORD=... postgres:16-alpine`).
2. `pg_restore --no-owner --dbname="<test-db-url>" <dump-dosyası>`
3. Şema doğrulaması: `prisma migrate status` temiz olmalı; temel sorgular
   (`SELECT count(*) FROM tickets;` vb.) beklenen büyüklükte dönmeli.
4. Tatbikat sonucu (tarih, süre, sorunlar) kayıt altına alınmalıdır.
   Geri yüklemesi hiç denenmemiş yedek, yedek sayılmaz.

## 9. Deploy ve rollback

### 9.1 Deploy sırası

1. Yeni imajı build edin (`docker build --target runtime`).
2. Migration'ları uygulayın — runtime imajında Prisma CLI yoktur; build
   aşaması imajı kullanılır:

   ```bash
   docker build --target build -t app-build .
   docker run --rm -e DATABASE_URL="<prod-url>" app-build \
     npx prisma migrate deploy
   ```

   (Host üzerinde repo checkout'u varsa `npm run prisma:migrate:deploy`
   eşdeğerdir.)
3. Yeni runtime container'ını başlatın; eskisini durdurun.
4. Doğrulama: liveness ve readiness `200`; logda hata dalgası yok;
   `outbox_events` backlog'u büyümüyor.

Migration'lar geriye dönük uyumlu yazıldığından (additive), migration'ı
önce uygulamak güvenlidir; eski kod yeni şemayla çalışabilir.

### 9.2 Rollback

- **Uygulama rollback'i:** önceki imaj etiketiyle container'ı yeniden
  başlatın. İmaj etiketleri sürümlü tutulmalıdır (yalnız `latest` değil).
- **Migration rollback'i:** down-migration kullanılmaz; politika
  **yalnız ileri düzeltme**dir (yeni bir düzeltici migration yazılır).
  Veri bozulması durumunda bölüm 8'deki yedekten geri yükleme uygulanır.

### 9.3 Restart policy ve graceful shutdown

- Production container'ları için `restart: unless-stopped` (veya eşdeğeri)
  önerilir.
- Uygulama `enableShutdownHooks` kullanır: SIGTERM alındığında relay'ler ve
  job'lar mevcut turlarını en fazla 10 saniye içinde tamamlayıp durur
  (`raceWithTimeout`). Container durdurma timeout'u en az 15-30 saniye
  olmalıdır (`docker stop -t 30`).

## 10. Olay müdahale (incident response)

1. **Belirtiyi sınıflandırın:** tam kesinti (liveness down) / kısmi
   (readiness down, 5xx artışı) / işlevsel (bildirim gitmiyor, belirli
   endpoint hatalı).
2. **Health kontrol edin:** liveness + readiness. Readiness down ise DB'ye
   odaklanın (bölüm 6).
3. **Logları request-id ile daraltın:** kullanıcı hatası bildirdiyse
   yanıttaki `error.requestId` ile ilgili satırları bulun; 5xx satırları
   `err` alanıyla loglanır.
4. **Bildirim şikayetlerinde** bölüm 3 sorgularını çalıştırın: olay outbox'a
   yazılmış mı → dispatch edilmiş mi (`PROCESSED`) → delivery satırı var mı
   → delivery `FAILED` mı?
5. **Güvenlik şüphesinde** audit log'a bakın (bölüm 5): reuse tespiti, art
   arda başarısız OTP denemeleri, beklenmeyen deaktivasyonlar.
6. **Müdahale sonrası** kök neden, etki süresi ve alınan aksiyon kısa bir
   olay kaydına yazılmalıdır.

## 11. Bağımlılık güvenliği (npm audit triage)

CI'daki `npm audit` adımı bilgilendiricidir ve pipeline'ı kırmaz. Triage
kuralı: audit çıktısı tek başına aksiyon kanıtı değildir; bir bulgu ancak
etkilenen paket gerçekten kullanılan bir kod yoluna denk geliyorsa
önceliklendirilir. Değerlendirme sırası:

1. Bulgunun `severity` ve `via` zincirini okuyun; runtime dependency mi,
   yalnız devDependency mi?
2. Etkilenen API'nin projede çağrılıp çağrılmadığını doğrulayın.
3. Gerçek riskse: sürüm yükseltmesini ayrı bir commit'te yapın ve tam test
   zincirini koşun.
4. Yanlış pozitifse: karar ve gerekçe kısa bir notla kayıt altına alınmalıdır.

## 12. Gelecek seçenekler (bu fazda kurulmaz)

Prometheus + Grafana (metrik), Sentry (hata izleme), merkezi log (ELK/Loki),
uptime probe servisi ve otomatik yedekleme orkestrasyonu ileriki fazlarda
değerlendirilebilir. Bu runbook'taki SQL/log prosedürleri, bu araçlar
gelene kadarki asgari operasyon yüzeyidir.

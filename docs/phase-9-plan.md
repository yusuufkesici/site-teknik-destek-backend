# Faz 9 — Sertleştirme, CI ve Dokümantasyon: Uygulama Planı (Revizyon 1)

## Bağlam

Faz 1–8 tamamlanıp main'e merge edildi (son merge: `4675026`, production entrypoint
düzeltmesi: `b2ff904`). Kabul doğrulamasında 577 unit + 133 integration + 42 E2E test
geçti; migration'lar gerçek PostgreSQL üzerinde doğrulandı. Architecture audit sonucu:
"GENEL OLARAK UYUMLU — BELGE GÜNCELLEMESİ GEREKİYOR".

Faz 9 yeni iş özelliği eklemez. Amaç, mevcut backend'i:

- sürekli doğrulanabilir (CI),
- dokümante edilmiş (architecture revizyonu, README, runbook),
- manuel denenebilir (seed + kabul koleksiyonu),
- production'a hazırlanmış (config fail-fast, boot smoke),
- güvenlik ve gözlemlenebilirlik açısından sertleştirilmiş

hale getirmektir.

## Onay durumu (2026-07-18)

Plan onaylandı. Açık karar noktalarında önerilen seçenekler kabul edildi:

| Karar | Seçim |
|---|---|
| 1. Production SMS çelişkisi ve boot-smoke profili | (a) Validation'da `SMS_PROVIDER=external` "henüz implement edilmedi" açık reddi; CI boot-smoke production imajıyla development profili; `NODE_ENV=production` fail-fast'inin pozitif smoke testi |
| 2. Dev ortamında mock OTP erişimi | (a) Dev-only in-memory SMS inbox; yalnız `NODE_ENV=development`'ta yüklenen endpoint; loglama yok; production'da yokluğu e2e ile testli |

## 1. Mevcut durum (özet)

Kanıtlı eksikler:

- CI yok (`.github/` dizini yok).
- Seed yok (`prisma/seed.ts` yok, seed script'i yok).
- `prisma migrate deploy` npm script'i yok; runtime Docker imajında Prisma CLI yok
  (devDependencies prune ediliyor).
- README Faz 1–5'te kalmış; Faz 6–8 özelliklerini "yok" olarak listeliyor.
- `docs/architecture.md` Faz 6–8 kararlarının gerisinde (NotificationDelivery,
  `OutboxEvent.failedAt`, `Contract.expiryNotifiedAt`, signed URL → download endpoint,
  başarı yanıtı zarfı).
- Dev ortamında mock OTP elde edilemiyor (`MockSmsProvider` kodu ne logluyor ne saklıyor).
- Production SMS çelişkisi: validation production'da `mock`'u reddediyor
  (`src/config/validation.schema.ts`), `external` seçilince `sms.module.ts` boot'ta
  throw ediyor → bugünkü kodla `NODE_ENV=production` hiçbir değerle boot edemez.
- Explicit HTTP body limiti yok (Express default'una örtük güven).
- `S3_*` ve `SMS_API_*` env değişkenleri doğrulanıyor ama provider implementasyonu yok.

## 2. Faz kapsamı

1. GitHub Actions CI (`.github/workflows/ci.yml`).
2. `docs/architecture.md` revizyonu (Yaklaşım C) + README güncellemesi.
3. `prisma/seed.ts` — idempotent, production-guard'lı geliştirme seed'i.
4. Bruno manuel kabul koleksiyonu + `docs/manual-acceptance.md` + dev-only OTP inbox.
5. Production config sertleştirmesi (SMS/S3 fail-fast hizalaması, body limit, CORS).
6. `docs/operations-runbook.md`.
7. Küçük güvenlik işleri (`$queryRawUnsafe` → tagged template, CI'da bilgilendirici
   `npm audit`).

## 3. Kapsam dışı

Frontend, mobil, gerçek SMS provider, WhatsApp Cloud API, e-posta/push, payment
gateway, e-fatura/PDF, S3/MinIO/R2 implementasyonu, Redis/BullMQ/Kafka/RabbitMQ,
admin paneli, Swagger/OpenAPI, Prometheus/Grafana/Sentry/ELK, coverage servisi,
büyük refactor, mikroservis, yeni domain özelliği, rate-limit eşiklerinin env'e
taşınması (yalnız belgelenir), yeni Prisma migration.

## 4. Architecture.md güncelleme yaklaşımı

Yaklaşım C (kontrollü birleşim):

1. Belge başına "Belge Statüsü" bloğu — güncel otoritenin
   `docs/implementation-overrides.md` + Bölüm 17 olduğu, kaynak öncelik sırası.
2. Yeni "Bölüm 17: Uygulama Sonrası Mimari Revizyon (Faz 1–8)" — belge-kod
   deltalarının tablosu.
3. En yanıltıcı noktalara hedefli kısa "Bkz. Bölüm 17" işaretleri (silme yok):
   Bölüm 5 OutboxEvent/Contract, Bölüm 11 girişi, Bölüm 12 StorageProvider,
   Bölüm 15 Dockerfile/seed, Bölüm 16 fazlar.

Tarihsel başlangıç tasarımı korunur; güncel kaynak otoritesi açık hale gelir.

## 5. CI tasarımı

İki job, `ubuntu-latest`, trigger: `pull_request` + `push` (main), concurrency
cancellation, Node 24, npm cache, secrets gerekmez (tüm değerler dummy).

- **verify** (~30 dk timeout): `npm ci` (dummy `DATABASE_URL` ile — postinstall
  `prisma generate` çalıştırır), `prisma validate`, `prisma format` kontrolü,
  lint, build, unit + integration + e2e (Testcontainers; PostgreSQL service
  container gerekmez), `docker compose config -q`, bilgilendirici `npm audit`.
- **docker-smoke** (~20 dk timeout): production imaj build (`--target runtime`),
  build-stage imajıyla temiz PostgreSQL'e `prisma migrate deploy`, gerçek
  entrypoint ile boot + liveness/readiness smoke (development profili),
  `NODE_ENV=production` + `SMS_PROVIDER=mock` fail-fast smoke (hata ile çıkış
  beklenir).

`package.json`'a `prisma:migrate:deploy` script'i eklenir.

## 6. Seed stratejisi

`prisma/seed.ts`, doğrudan Prisma client ile (servis katmanı değil):

- Fail-fast production guard: `NODE_ENV=production` (veya tanımsız) → DB'ye
  dokunmadan hata ile çıkış.
- Idempotent: doğal unique anahtarlarla `upsert`; silme yok; tekrar çalıştırma
  duplicate üretmez.
- İçerik: kurgusal E.164 telefonlar (`+9055500000xx`); 1 OPERATIONS,
  1 SITE_MANAGER, 1 TECHNICIAN, 2 RESIDENT; 1 SITE + BLOCK + UNIT'ler +
  COMMON_AREA; membership + resident-unit assignment; Material kataloğu;
  1 ACTIVE Contract + 1 süresi yakında dolacak Contract. OTP seed'lenmez.
- Çalıştırma: `npm run db:seed` (yalnız açık çağrı; `prisma.config.ts`'e seed
  kaydı yapılmaz).

## 7. Manuel API kabul testi

Araç: Bruno (açık kaynak, düz metin `.bru`, commit edilebilir, secret saklamaz).
Yapı: `manual-tests/bruno/` + `docs/manual-acceptance.md` runbook'u. Her adım
için ön koşul, method + route, rol, request örneği, beklenen status, beklenen
hata kodu, DB yan etkisi. Pozitif zincir 30 adım (health → OTP → auth → ticket →
assignment → material → attachment → contract → invoice → emergency → outbox →
delivery → jobs → audit → refresh rotation → logout); 12 negatif senaryo.
Mock OTP, dev-only SMS inbox endpoint'i ile elde edilir.

## 8. Production config sertleştirmesi

1. Validation: production'da `SMS_PROVIDER=external` ve `STORAGE_PROVIDER=s3`
   için "henüz implement edilmedi" açık reddi (fail-fast, dürüst mesaj).
2. `main.ts`: explicit JSON body limit.
3. Validation: production'da `CORS_ALLOWED_ORIGINS` içinde `*` reddi.
4. `.env.example` hizalaması; `S3_*`/`SMS_API_*` için "gelecek faz" notu.
5. Her yeni kural için unit test.

## 9. Gözlemlenebilirlik ve operasyon

Kod değişikliği yok; `docs/operations-runbook.md` yazılır: FAILED
outbox/delivery sorguları ve yeniden kuyruğa alma, backlog/lag sorgusu, DB/disk
kontrolleri, log rotation, `pg_dump` backup + restore testi, deploy sırası
(migrate deploy → yeni imaj → health), rollback, restart policy, graceful
shutdown, incident response. Prometheus/Grafana/Sentry yalnız "gelecek
seçenekler" olarak not edilir.

## 10. Güvenlik sertleştirmesi

- `$queryRawUnsafe` → tagged `$queryRaw`
  (`src/modules/assignments/repositories/assignment.repository.ts`; bugün de
  bound-param'lı ve güvenli, dönüşüm tutarlılık içindir).
- Explicit body limit + CORS sertleştirmesi.
- CI'da bilgilendirici `npm audit`; triage kuralı runbook'ta.
- Docker non-root, prune, `.dockerignore`/`.gitignore` kapsamı, log redaction —
  doğrulanıp belgelenir; değişiklik gerekmez.

## 11. Uygulama dilimleri

| Dilim | İçerik | Commit |
|---|---|---|
| 1 | Faz planı + architecture revizyonu + README + operasyon runbook'u | `docs: ...` |
| 2 | CI workflow + `prisma:migrate:deploy` script'i | `ci: ...` |
| 3 | Seed + dev SMS inbox + Bruno koleksiyonu + kabul runbook'u + testler | `feat: ...`, `docs: ...` |
| 4 | Config/güvenlik sertleştirmesi + spec'ler | `fix: ...` |

Sıra: 1 → 2 → 3 → 4. Her dilim sonunda kapsamına uygun doğrulama komutları
koşulur (lint, build, unit/integration/e2e, prisma format/validate,
`docker compose config -q`).

## 12. Test stratejisi

- Mevcut 752 testin regresyonu her kod dilimi sonrasında.
- Yeni: config validation kuralları unit spec'leri; seed idempotency
  (Testcontainers'ta iki koşum); seed production-guard testi; dev OTP
  endpoint'inin yalnız development'ta var olduğunu doğrulayan e2e.
- CI workflow ilk PR'da fiilen doğrulanır; ayrı workflow-lint aracı eklenmez.
- Yeni test framework'ü eklenmez.

## 13. Riskler ve önlemler

- CI süresi (Testcontainers + `--runInBand`) → timeout + concurrency cancel.
- `prisma format --check` bayrak desteği belirsiz → fallback `git diff --exit-code`.
- Seed'in custom DB kısıtlarıyla çakışması → veriler kısıtlara göre tasarlanır,
  idempotency testi Testcontainers'ta koşar.
- Dev OTP endpoint'inin production'a sızması → koşullu modül kaydı + negatif e2e.
- Fail-fast kurallarının dev ortamını bozması → sertleştirme yalnız
  `NODE_ENV=production` dalında.

## 14. Tamamlanma kriterleri

1. CI iki job'la PR ve main push'ta yeşil; migration, boot, fail-fast smoke kanıtlı.
2. `architecture.md` Bölüm 17 + Belge Statüsü ile kod gerçekliğini yansıtıyor;
   README güncel.
3. `npm run db:seed` idempotent, production-guard'lı, testli.
4. Bruno koleksiyonu + kabul runbook'u repo'da; gerçek secret yok.
5. Config sertleştirmeleri testli; mevcut testler + yeni testler geçiyor.
6. `docs/operations-runbook.md` mevcut.
7. Kapsam dışı listesine sızma yok (yeni migration yok, yeni provider yok).

## 15. Planın kısa özeti

Faz 9 dört dilimde ilerler: belgeler (architecture Bölüm 17 + README + runbook),
iki job'lu GitHub Actions CI (Testcontainers'lı tam doğrulama + production imaj
boot/fail-fast smoke), idempotent production-guard'lı seed + Bruno manuel kabul
koleksiyonu (dev-only OTP inbox ile) ve production config fail-fast
sertleştirmesi. Gerçek dış entegrasyonların tamamı bilinçli olarak sonraki
fazlara bırakılır.

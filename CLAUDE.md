# Site Teknik Destek Sistemi — Claude Code Talimatları

@docs/implementation-overrides.md

## Kaynak önceliği

Çelişki durumunda aşağıdaki sıra geçerlidir:

1. Kullanıcının mevcut görev mesajı
2. `docs/implementation-overrides.md`
3. Onaylanmış faz planı
4. `docs/architecture.md`
5. Mevcut kaynak kod

`docs/implementation-overrides.md`, `docs/architecture.md` içindeki hatalı veya eski teknik kararları geçersiz kılar.

## Bağlam ve token disiplini

- `docs/architecture.md` dosyasını kendiliğinden veya bütünüyle okuma.
- Yalnız görev mesajında belirtilen başlıkları oku.
- Önce `rg -n "^## |^### " docs/architecture.md` ile başlıkların satırlarını bul.
- Sonra yalnız gerekli satır aralığını `sed` veya eşdeğer araçla oku.
- Aynı oturumda daha önce okunan dosyaları gereksiz yere yeniden okuma.
- Büyük dosyaları tamamen çıktı olarak terminale basma.
- Görevle ilgisiz modülleri araştırma veya düzenleme.
- Uzun açıklamalar yerine kısa plan, değişiklik özeti ve doğrulama sonucu ver.

## Faz disiplini

- Yalnız açıkça istenen fazı uygula.
- Sonraki fazlara ait dosya, servis, controller, DTO veya sahte implementation oluşturma.
- Faz 1'de auth, users, memberships, facilities, tickets, assignments, materials,
  attachments, contracts, billing, notifications ve audit domain servisleri uygulanmayacak.
- İleride kullanılacak boş domain modülleri de oluşturma.
- Mimari dokümandaki eksik örnek kodları doğrudan kopyalama.

## Teknik temel

- Runtime: Node.js 24 LTS
- Paket yöneticisi: npm
- Framework: NestJS
- Dil: strict TypeScript
- Veritabanı: PostgreSQL 16
- ORM: Prisma 7 ve PostgreSQL driver adapter
- Prisma bağlantı ayarı: `prisma.config.ts`
- Logging: yapılandırılmış JSON log
- API prefix: `/api/v1`
- Veritabanı zamanları: UTC

## Kod kalitesi

- `any`, `as any`, `@ts-ignore` ve sessiz type assertion kullanma.
- Tanımsız metot, eksik constructor dependency veya placeholder implementation bırakma.
- Üretilecek her kaynak dosya derlenebilir olmalı.
- İş kuralı controller içinde bulunmamalı.
- Secret, OTP, token, signed URL ve kişisel veri loglanmamalı.
- Yeni iş kuralı uydurma. Belirsizlik varsa uygulamayı durdurup kısa ve tekil soru sor.
- Dosyaları mümkün olan en küçük kapsamda değiştir.

## Doğrulama

Her implementasyon görevinin sonunda kapsamına uygun olarak:

1. Bağımlılıkları kur.
2. Lint çalıştır.
3. TypeScript build çalıştır.
4. Prisma format çalıştır.
5. Prisma validate çalıştır.
6. Docker Compose config kontrolü çalıştır.
7. Oluşan hataları düzeltip kontrolleri yeniden çalıştır.

Başarısız bir komutu başarılı olarak raporlama.

## Rapor biçimi

Görev sonunda yalnız şunları raporla:

- Oluşturulan/değiştirilen dosyalar
- Çalıştırılan komutlar ve sonuçları
- Düzeltilen hatalar
- Doğrulanamayan hususlar
- Sonraki faza bırakılan işler
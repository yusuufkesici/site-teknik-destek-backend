# Faz 2 Plan Özeti — Authentication (OTP + JWT + Refresh Rotation)

> Tam plan (3 revizyon, 13 düzeltme dahil): onaylanan Faz 2 planı,
> `.claude/plans` altında. Bu dosya kısa özetidir.

## Kapsam

`/auth/otp/request`, `/auth/otp/verify`, `/auth/token/refresh`,
`/auth/logout`, `/auth/me`. `OtpService` (yalnız request akışı),
`TokenService` (rotate + stateless JWT signing), `AuthService` (verify'ın
tek transaction orkestratörü). `SmsProvider` + `MockSmsProvider`.
`JwtAuthGuard`, `RolesGuard`, `@Public()`/`@Roles()`/`@CurrentUser()`. Named
rate limiter'lar (`otpPhone`, `otpIp`, `otpCooldown`, `otpVerifyIp`).
Minimum salt-okunur `UserAuthRepository`/`MembershipReadRepository`.
Transaction-aware `AuditWriter` (yalnız auth event'leri). Jest test
altyapısının ilk kurulumu + unit/integration(Testcontainers)/E2E testleri.

Contract repository'sine auth hiç bağımlı değil (karar #1). Faz 3 modülleri
(Users/Memberships/Facilities/Tickets/... CRUD) oluşturulmadı.

## Zorunlu transaction/güvenlik kararları (aynen uygulandı)

1. OTP verify: hatalı denemede transaction içinden throw yok; discriminated
   result (`INVALID_OTP`/`NOT_ELIGIBLE`/`SUCCESS`) döner, commit her zaman
   olur, `DomainError` commit sonrası üretilir.
2. Son hatalı denemede `attemptCount` artışı + `invalidatedAt` set edilmesi
   **tek atomik repository çağrısında** (`incrementAttemptAndMaybeInvalidate`)
   aynı transaction'da; ayrıca hash karşılaştırmadan önce savunmacı
   `attemptCount>=maxAttempts` kontrolü.
3. Başarılı login: challenge kilit+tüketim, eligibility yeniden doğrulama
   (transaction-aware `MembershipReadRepository`), refresh session
   oluşturma, `lastLoginAt`, audit — tek transaction (`AuthService.verifyOtp`).
4. Access JWT yalnız commit'ten **sonra** üretilir; imzalama başarısız olursa
   refresh session revoke edilir (telafi).
5. Refresh reuse detection: tüm session revoke + audit commit içinde;
   `AUTH_INVALID_REFRESH` commit sonrası döner.
6. Yalnız refresh token hash'i saklanır; OTP/JWT/refresh/telefon/secret asla
   loglanmaz.
7. OTP: HMAC-SHA256 + timing-safe karşılaştırma, `crypto.randomInt` (asla
   `Math.random`, ayrıca ESLint kuralıyla da yasaklandı).
8. OTP request ve logout generic/enumeration-safe.
9. Auth'un ihtiyaç duyduğu üyelik/kullanıcı sorguları minimum salt-okunur
   repository'lerle çözüldü; Faz 3 modülleri erkenden oluşturulmadı.
10. Yalnız auth güvenlik event'leri için minimum `AuditWriter`.

## architecture.md'yi geçersiz kılan noktalar

- OTP request eligibility: contract kontrolü yok, yalnız aktif site
  üyeliği (override + görev kararı #1).
- DTO doğrulama hataları 400 değil 422 VALIDATION_ERROR.
- Rate limit aşımı `/auth/otp/request`'te soft-fail (200 generic), yalnız
  `/auth/otp/verify`'nin IP limiter'ında 429.

## Faz 2 dışında bırakılanlar

Facility/resident onboarding, tam Users/Memberships CRUD, Ticket/Assignment/
Material/Attachment, Contract/Billing, Notification/Outbox relay,
`ExternalSmsProvider` (yalnız arayüz + mock, `SMS_PROVIDER=external`
bootstrap hatasıyla durur), Swagger, `PHONE_VERIFICATION` OTP purpose'u.

Ayrıntılı gerekçe, dosya ağacı ve akış adımları için onaylanmış Faz 2
planına bakınız.

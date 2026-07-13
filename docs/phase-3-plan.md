# Faz 3 Plan Özeti — Facility + Membership + Users

> Tam plan (3 revizyon, 18 zorunlu karar dahil): onaylanan Faz 3 planı,
> `.claude/plans` altında. Bu dosya kısa özetidir.

## Kapsam

`MembershipsModule` (`MembershipQueryService`, `SiteMembershipRepository`,
`ResidentUnitAssignmentRepository`), `FacilitiesModule` (`FacilityService`,
`FacilityValidator`, `FacilityRepository`, SITE/BLOCK/UNIT/COMMON_AREA
oluşturma, ağaç görüntüleme), `UsersModule` (resident onboarding, site
kullanıcı listesi, global profil güncelleme, site-scoped + global
pasifleştirme), `SiteScopeGuard`, `AuthSessionRevocationService`, tenant
izolasyonu, cursor pagination, ilgili unit/integration/E2E testleri.

Faz 2'nin geçici `MembershipReadRepository`'si silinip yerine
`MembershipQueryService` geçirildi; Faz 2 davranışı/testleri değişmeden
korunuyor.

## Zorunlu kararlar (aynen uygulandı)

1. SITE_MANAGER yalnız kendi yönettiği sitelerde işlem yapabilir.
2. SITE_MANAGER site/blok/unit/common-area oluşturamaz.
3. Facility oluşturma yalnız OPERATIONS.
4. Site-scoped pasifleştirme `User.isActive`'e veya diğer sitelerdeki
   üyeliklere dokunmaz.
5. Global pasifleştirme yalnız OPERATIONS.
6. Global pasifleştirmede tüm refresh session'lar
   `AuthSessionRevocationService` ile aynı transaction'da iptal edilir.
7. `UsersModule`, `RefreshSessionRepository`'ye doğrudan bağımlı değil —
   yalnız `AuthSessionRevocationService` portu üzerinden.
8. SITE_MANAGER global profil alanlarını (ad/soyad/telefon) yalnız hedefin
   tüm aktif siteleri kendi yönettiği sitelerin alt kümesiyse değiştirebilir.
9. OPERATIONS ad/soyad değiştirebilir, telefon değiştiremez.
10. Telefon değişiminde `tokenVersion++` + maskeli audit aynı transaction'da.
11. Yeniden onboard edilen RESIDENT'in ad/soyadı sessizce güncellenmez.
12. Onboarding eşzamanlılığı: transaction-scoped `pg_advisory_xact_lock`
    (telefon numarası üzerinden).
13. Aktif `SiteMembership`/`ResidentUnitAssignment` işlemleri idempotent.
14. Geçmiş membership kayıtları yeniden aktif edilmez; tarihçe korunarak
    yeni aktif kayıt açılır.
15. Başka site/unit kaynaklarında 404 (bilgi sızdırmaz).
16. `SiteScopeGuard`'ın OPERATIONS bypass'ı yalnız üyelik kontrolünü atlar;
    site kaynağının varlığı servis katmanında ayrıca doğrulanır.
17. SITE_MANAGER yalnız RESIDENT rolündeki hedefleri yönetebilir.
18. Faz 2 OTP/JWT/refresh rotation/reuse detection/logout davranışı bozulmaz.

## Kapsam dışı

Ticket, Assignment, Material, Attachment, Contract, Billing, Notification,
Outbox relay, Faz 4+ kodları. `PLATFORM_ADMIN` yok. Reaktivasyon endpoint'i
yok. Çoklu-unit residency desteklenmiyor (tek-aktif-unit varsayımı).

Ayrıntılı gerekçe, dosya ağacı, endpoint/DTO tabloları ve transaction akışları
için onaylanmış Faz 3 planına bakınız.

# Faz 5 — Assignment + Materials: Onaylanmış Uygulama Planı

## Context

Faz 1-4 ile auth, users, memberships, facilities ve tickets tamamlandı.
`TicketStateMachine` zaten tüm 16 geçişi tanımlıyor ama `Phase4TicketTransitionPolicy`
bunu yalnız 3 geçişle (`OPEN→TRIAGED`, `OPEN→CANCELLED`, `TRIAGED→CANCELLED`)
sınırlıyor — bu, henüz assignment orkestrasyonu olmadığı için geçici bir
korumadır. Faz 5'in amacı: teknisyen atama/kabul/red/durum akışını ve malzeme
kaydını güvenli şekilde uygulamak, ve bu geçici policy'yi kalıcı bir
mekanizmayla değiştirmek. Prisma şeması (`Assignment`, `Material`,
`AssignmentMaterial`, ilgili enum ve constraint'ler) Faz 1'de zaten
tamamlandı — bu tamamen bir uygulama katmanı işidir, migration gerekmiyor.

## Kesinleşen kararlar (önceki plandaki açık kararların çözümü)

1. **ASSIGNED ticket iptali Faz 5 kapsamındadır.** Yalnız OPERATIONS
   kullanabilir. Yeni endpoint: `POST /assignments/:id/cancel`
   (`CancelAssignmentDto { reason: string, zorunlu }`). AssignmentsModule
   içindeki `TicketAssignmentWorkflowService.cancelAssignedTicket` tek
   transaction'da: ticket kilitle → current assignment kilitle → current
   assignment `CANCELLED` + `isCurrent=false` → ticket `CANCELLED` → history,
   audit, outbox. Bu endpoint AssignmentsController'da yaşar (TicketsModule
   AssignmentsModule'a asla bağımlı olmadığı için genel ticket cancel
   endpoint'i bu akışı tetikleyemez).
2. **`COMPLETED → IN_PROGRESS` yeniden açma bu fazda uygulanmayacak.**
   `TicketDirectTransitionPolicy` allowlist'inde bu geçiş YOKTUR. Denenirse
   409 `TICKET_INVALID_STATUS_TRANSITION`. Tamamlanmış assignment'lar geri
   döndürülmez.
3. **`COMPLETED → CLOSED` yalnız OPERATIONS.** `TicketDirectTransitionPolicy`
   allowlist'inde kalır (zaten state machine'de yalnız OPERATIONS rolü var).
4. **Material katalog CRUD veya listeleme endpoint'i yok.** Yalnız mevcut
   aktif `Material` kayıtlarını `materialId` ile doğrulayan
   `MaterialLookupService.assertActiveMaterial` var.
5. **Decimal kuralı:** `quantity`/`unitPrice`/`totalPrice` yalnız
   `Prisma.Decimal` ile hesaplanır. `AuditLogEntry.metadata`'ya fiyat/miktar
   DEĞERLERİ yazılmaz (yalnız id/enum/boolean). `AssignmentMaterialAdded`
   outbox payload'ında gerekli Decimal alanlar (`quantity`, `unitPrice`,
   `totalPrice`) string olarak tutulabilir — ama `note` asla payload'a veya
   audit metadata'ya yazılmaz.

## 1. Kapsam / kapsam dışı

**Kapsamda:** AssignmentsModule (atama/yeniden atama, accept, reject, 6 durum
eventi, cancel, `GET /assignments/my`), MaterialsModule (minimal, salt-okunur
lookup), AssignmentMaterial ekleme+listeleme, `TicketAssignmentWorkflowService`,
`Phase4TicketTransitionPolicy` kaldırılması, yeni audit/outbox/error code'lar.

**Kapsam dışı:** Material katalog CRUD/listeleme, Attachments, Billing,
Notifications, `COMPLETED→IN_PROGRESS` reopen.

## 2. Modül bağımlılık yönü ve orkestrasyon

`AssignmentsModule → TicketsModule` ve `AssignmentsModule → MaterialsModule`
tek yönlü. `TicketsModule` `AssignmentsModule`'a bağımlı değildir. `forwardRef`
yok.

- `TicketsModule`, `TICKET_TRANSITION_PORT` injection token'ı ile
  `TicketTransitionPort` arayüzünü export eder:
  `lockAndGet(tx, ticketId): Promise<TicketRow>` ve
  `applyStatusTransition(tx, {actor, ticket, toStatus, reason?, auditAction,
  extraAuditMetadata?}): Promise<TicketRow>`.
- Bu port `TicketTransitionService` tarafından uygulanır — mevcut
  `TicketService.applyTransition`'dan çıkarılan çekirdek mantık (transaction
  açma ve policy çağrısı HARİÇ): `stateMachine.assertTransition` →
  `updateStatus` (version-guard) → `addHistory` → `audit.log` →
  `outbox.publishInTx`.
- `TicketService.applyTransition` transaction'ı kendi açar,
  `TicketDirectTransitionPolicy`'yi kendisi çağırır, sonra
  `TicketTransitionService`'in çekirdek adımlarını (aynı transaction client
  ile) kullanır.
- `TicketRepository`/`TicketStateMachine` export edilmez.
- `AssignmentRepository.findActiveTechnician` doğrudan `client.user.findFirst`
  çalıştırır (UsersModule importu gerekmez) — mevcut
  `existsAssignmentForTechnician` presedanıyla tutarlı.
- `MaterialsModule` yalnız `MaterialLookupService`'i export eder.

## 3. Dosya ağacı

```
src/modules/tickets/
  ports/ticket-transition.port.ts
  services/ticket-transition.service.ts
  state/ticket-direct-transition.policy.ts   (phase4 policy yerine)
  state/phase4-ticket-transition-policy.ts   (SİLİNDİ)
  services/ticket.service.ts                 (değişiklik)
  tickets.module.ts                          (değişiklik)

src/modules/materials/
  materials.module.ts
  repositories/material.repository.ts
  services/material-lookup.service.ts

src/modules/assignments/
  assignments.module.ts
  assignments.controller.ts
  repositories/assignment.repository.ts
  repositories/assignment-material.repository.ts
  services/assignment.service.ts
  services/ticket-assignment-workflow.service.ts
  policies/assignment-authorization.policy.ts
  state/assignment-status-event.map.ts
  dto/create-assignment.dto.ts
  dto/reject-assignment.dto.ts
  dto/update-assignment-status.dto.ts
  dto/cancel-assignment.dto.ts
  dto/add-material.dto.ts
  dto/list-my-assignments-query.dto.ts
  mappers/assignment.mapper.ts
  mappers/assignment-material.mapper.ts

src/common/constants/domain-audit-actions.constant.ts   (ek blok)
src/common/constants/error-codes.constant.ts             (ek blok)
src/app.module.ts                                        (yeni modüller)

test/integration/assignments/assignment-concurrency.integration-spec.ts
test/integration/assignments/assignment-lifecycle.integration-spec.ts
test/integration/assignments/materials.integration-spec.ts
test/e2e/assignments.e2e-spec.ts
```

## 4. Endpoint ve DTO'lar

1. `POST /tickets/:ticketId/assignments` — OPERATIONS — `{technicianId}`
2. `POST /assignments/:id/accept` — TECHNICIAN
3. `POST /assignments/:id/reject` — TECHNICIAN — `{reason}`
4. `POST /assignments/:id/status` — TECHNICIAN, OPERATIONS —
   `{event, note?}`
5. `POST /assignments/:id/cancel` — OPERATIONS — `{reason}` (karar 1)
6. `GET /assignments/my` — TECHNICIAN — cursor pagination
7. `POST /assignments/:id/materials` — TECHNICIAN, OPERATIONS —
   `{materialId, quantity, unitPrice, suppliedBy, note?}`
8. `GET /assignments/:id/materials` — TECHNICIAN, SITE_MANAGER, OPERATIONS

## 5. Assignment yaşam döngüsü

Önceki planla aynı (bkz. §5 tablo) + cancel satırı:

| ACTIVE (current) | cancel | CANCELLED | ASSIGNED→CANCELLED | OPERATIONS, reason zorunlu | isCurrent=false |

## 6. Ticket–Assignment atomik workflow

assign/reassign, accept, reject, status-event: önceki planla aynı (kilit
sırası ticket→assignment→diğer).

**cancel (yeni, karar 1):**
1. tx aç → `lockAndGet(ticket)`.
2. `ticket.status === 'ASSIGNED'` doğrula, aksi 409.
3. current assignment'ı `findCurrentForUpdate` ile kilitle.
4. current assignment → `CANCELLED`, `isCurrent=false`.
5. `applyStatusTransition(toStatus:'CANCELLED', reason, auditAction:
   ASSIGNMENT_CANCELLED)`.
6. audit + `outbox.publishInTx('AssignmentCancelled', {ticketId,
   assignmentId, technicianId})`. Commit.

## 7. Reassignment ve concurrency

Önceki planla aynı. COMPLETE vs CANCEL yarışı: her iki yol da ticket satırını
önce kilitler → Postgres serileştirir, tam olarak biri başarılı olur.

## 8. Materials kuralları

Önceki planla aynı: yalnız `ACTIVE`+`isCurrent=true` assignment'a ekleme,
Decimal hesap, okuma scope'u role göre.

## 9. Yetki / IDOR matrisi

Önceki matris + `POST /assignments/:id/cancel`: yalnız OPERATIONS ✔, diğer
tüm roller 403 (guard seviyesinde).

## 10. Audit/outbox

`DOMAIN_AUDIT_ACTIONS` ek blok: `ASSIGNMENT_CREATED, ASSIGNMENT_ACCEPTED,
ASSIGNMENT_REJECTED, ASSIGNMENT_STATUS_CHANGED, ASSIGNMENT_CANCELLED,
MATERIAL_ADDED`.

Outbox `eventType`'lar: `TechnicianAssigned`, `AssignmentAccepted`,
`AssignmentRejected`, `AssignmentStatusChanged`, `AssignmentCancelled`,
`AssignmentMaterialAdded`.

Doğrulama (karar 5): `rejectionReason`, `resolutionNote`, material `note`
hiçbir zaman `AuditLogEntry.metadata` veya outbox payload'a yazılmaz.
`AuditLogEntry.metadata`'ya fiyat/miktar DEĞERİ de yazılmaz (yalnız
id/enum/boolean). `AssignmentMaterialAdded` outbox payload'ı istisna olarak
`quantity`/`unitPrice`/`totalPrice`'ı string olarak içerebilir (id/enum
kuralına ek, serbest metin değildir).

## 11. Phase4TicketTransitionPolicy geçişi

`phase4-ticket-transition-policy.ts` silinir. Yerine kalıcı
`TicketDirectTransitionPolicy` gelir — allowlist (karar 2/3 ile güncel):
`OPEN→TRIAGED, OPEN→CANCELLED, TRIAGED→CANCELLED, COMPLETED→CLOSED`.
`COMPLETED→IN_PROGRESS` allowlist'te YOKTUR (karar 2). Assignment'a ait tüm
geçişler (`TRIAGED→ASSIGNED, REJECTED→ASSIGNED, ASSIGNED→ACCEPTED,
ASSIGNED→REJECTED, ASSIGNED→CANCELLED, ACCEPTED→EN_ROUTE, EN_ROUTE→ARRIVED,
ARRIVED→IN_PROGRESS, IN_PROGRESS↔WAITING_MATERIAL, IN_PROGRESS→COMPLETED`)
allowlist'te yoktur — yalnız `TicketAssignmentWorkflowService` üzerinden
(kendi port çağrıları ile) ulaşılabilir.

## 12. Hata kodları (ek)

`ASSIGNMENT_NOT_FOUND, ASSIGNMENT_TECHNICIAN_INVALID,
ASSIGNMENT_STATUS_CONFLICT, ASSIGNMENT_MATERIAL_NOT_ALLOWED,
ASSIGNMENT_CONCURRENT_CONFLICT, MATERIAL_NOT_FOUND, MATERIAL_INACTIVE`.

## 13. Test planı

Önceki planla aynı unit/integration/e2e senaryoları + cancel-vs-complete
yarışı, cancel sonrası assignment/ticket tutarlılığı, `COMPLETED→IN_PROGRESS`
denemesinin 409 dönmesi.

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

## Kritik dosyalar

- `src/modules/tickets/services/ticket.service.ts`
- `src/modules/tickets/tickets.module.ts`
- `src/modules/tickets/state/phase4-ticket-transition-policy.ts`
- `src/modules/tickets/state/ticket-state-machine.ts`
- `src/modules/tickets/repositories/ticket.repository.ts`
- `prisma/schema.prisma`
- `docs/implementation-overrides.md` (Bölüm 9)

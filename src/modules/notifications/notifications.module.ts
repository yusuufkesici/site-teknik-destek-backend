import { Module } from '@nestjs/common';
import { AuditModule } from '../../infrastructure/audit/audit.module';
import { SmsModule } from '../../infrastructure/sms/sms.module';
import { MembershipsModule } from '../memberships/memberships.module';
import { UsersModule } from '../users/users.module';
import { NotificationDeliveryRelay } from './notification-delivery-relay.service';
import { NotificationDispatcher } from './notification-dispatcher.service';
import { OutboxRelay } from './outbox-relay.service';

// Faz 8 (onaylanan docs/phase-8-plan.md Bolum 3.2): EventsModule GEREKMEZ -
// bu modul hic yeni domain event yazmiyor (OutboxService.publishInTx
// cagirmiyor), yalniz mevcut outbox_events satirlarini okuyup kendi
// notification_deliveries tablosuna yaziyor. MembershipsModule,
// ContractExpiring/InvoiceOverdue route'larinin site-manager alicisi
// cozumlemesi icin (MembershipQueryService.listActiveManagerUserIds)
// gerekir. Hicbir modul bunu import etmez, o da ContractsModule/
// BillingModule/TicketsModule'u import etmez - outbox deseni producer/
// consumer'i zaten ayirdigindan dongusel bagimlilik riski yoktur.
@Module({
  imports: [UsersModule, MembershipsModule, SmsModule, AuditModule],
  providers: [OutboxRelay, NotificationDispatcher, NotificationDeliveryRelay],
})
export class NotificationsModule {}

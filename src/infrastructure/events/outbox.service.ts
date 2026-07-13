import { Injectable } from '@nestjs/common';
import type { PrismaClientLike } from '../../common/types/prisma-client-like.type';
import type { Prisma } from '../../generated/prisma-client/client';

export interface OutboxEventEntry {
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
}

// Transaction-aware outbox yazicisi (onaylanan Faz 4 plani Bolum 15): yalniz
// PENDING satir yazar, cagiran servisin transaction'i icinde commit/rollback'e
// tabi olur. Relay (PENDING satirlarin islenmesi/tuketimi) Faz 8 kapsamindadir
// - bu servis hic okuma/tuketim yapmaz.
@Injectable()
export class OutboxService {
  async publishInTx(client: PrismaClientLike, entry: OutboxEventEntry): Promise<void> {
    await client.outboxEvent.create({
      data: {
        eventType: entry.eventType,
        aggregateType: entry.aggregateType,
        aggregateId: entry.aggregateId,
        payload: entry.payload as Prisma.InputJsonValue,
        status: 'PENDING',
      },
    });
  }
}
